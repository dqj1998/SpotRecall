// Auto-close inactive tabs (autoclose-plan v2). The SW is the sole actor.
//
// Design invariants:
//   - Never touches a tab until the user has explicitly enabled the feature
//     (autoCloseConsented). Default-on is a *logical* default gated by consent.
//   - `selectTabsToClose` is a PURE function (no chrome.*), so R6 contracts are
//     testable without a browser: exclusion rules, thin-first priority, keep-N
//     convergence, per-window "never close the last tab", restart protection.
//   - Tab identity is the LIVE browser tab; the index is keyed by normalized URL.
//     The two are bridged per-scan (url -> recordId -> record).
//   - Relevance is best-effort: only when the embedding model is already READY;
//     it NEVER triggers a model download on the maintenance path.

import { normalizeUrl } from '@shared/url';
import { recordIdFor } from '@shared/hash';
import {
  allRecords,
  isAutoCloseEnabled,
  isAutoCloseConsented,
  getAutoCloseKeep,
  appendAutoCloseLog,
} from '@storage/dao';
import type { AutoClosedEntry, PageRecord } from '@shared/types';
import { domainOf } from '@shared/url';
import { offscreenState, scoreAgainst } from './offscreen-manager';

// ---- tunables (confirmed 2026-09-23) ----
export const AC_DEFAULTS = {
  keep: 12,
  thinChars: 100, // committed & shorter => "no substantive content"
  minInactiveMs: 5 * 60_000, // a tab must be idle this long to be eligible
  graceMs: 10 * 60_000, // after browser/session start, close nothing
  overAgeMs: 24 * 60 * 60_000, // never-committed & older => treated as thin (option A)
  tauMs: 12 * 60 * 60_000, // freshness = exp(-Δt/τ)
  wRelevance: 0.5,
  wFreshness: 0.5,
  recentOpenedCap: 20,
  signalQueryCap: 5,
  signalTitleCap: 5,
  captureCap: 15, // max never-committed tabs to force-capture per tick
} as const;

// ---- pure decision layer (no chrome.*) ----

export interface TabInfo {
  tabId: number;
  windowId: number;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  grouped: boolean; // groupId !== -1
  incognito: boolean;
  internal: boolean; // chrome://, extension pages, newtab, etc.
  /** Page has unsaved form input (user typed but didn't submit) — never close. */
  hasFormInput: boolean;
  recordId: string;
  committed: boolean; // record committed with non-empty cleanText
  cleanTextLen: number;
  /** ms of last activation; callers pass `now` when unknown (protective). */
  lastActive: number;
}

export interface AutoCloseSettings {
  keep: number;
  thinCharLimit: number;
  minInactiveMs: number;
  overAgeMs: number;
  tauMs: number;
  wRelevance: number;
  wFreshness: number;
}

export interface AutoCloseContext {
  now: number;
  withinGrace: boolean;
  /** tabId -> cosine in [-1,1]; absent tabs fall back to freshness only. */
  relevance?: Map<number, number>;
}

function freshness(now: number, lastActive: number, tau: number): number {
  return Math.exp(-Math.max(0, now - lastActive) / tau);
}

export interface AutoCloseDecision {
  /** Close now — already indexed (committed) or genuinely empty (thin/over-age). */
  close: number[];
  /**
   * Never-committed but inactive: index them first (force-capture), then they
   * become closable on a later tick. This satisfies "only close indexed pages"
   * without waiting for the 24h over-age fallback.
   */
  capture: number[];
}

/**
 * Decide which tabs to close / capture. Only acts when the total non-incognito
 * tab count exceeds `keep`; then walks candidates in priority order (thin first,
 * then ascending keepScore) up to the overflow — never emptying a window and
 * never touching an excluded tab. Never-committed inactive tabs are routed to
 * `capture` (indexed then closed next tick) instead of being skipped.
 */
export function selectTabsToClose(
  tabs: TabInfo[],
  s: AutoCloseSettings,
  ctx: AutoCloseContext,
): AutoCloseDecision {
  const empty: AutoCloseDecision = { close: [], capture: [] };
  if (ctx.withinGrace) return empty;

  const normal = tabs.filter((t) => !t.incognito);
  const total = normal.length;
  if (total <= s.keep) return empty;

  const winRemaining = new Map<number, number>();
  for (const t of normal) winRemaining.set(t.windowId, (winRemaining.get(t.windowId) ?? 0) + 1);

  const now = ctx.now;
  interface Cand {
    tabId: number;
    windowId: number;
    thin: boolean;
    capturable: boolean; // never-committed: index before closing
    keepScore: number;
  }
  const cands: Cand[] = [];

  for (const t of normal) {
    // Hard exclusions — never eligible.
    if (t.active || t.pinned || t.audible || t.grouped || t.internal) continue;
    if (t.hasFormInput) continue; // unsaved form input — closing would lose data
    if ((winRemaining.get(t.windowId) ?? 0) <= 1) continue; // window's only tab
    if (now - t.lastActive < s.minInactiveMs) continue; // too recently used / just restored

    const fresh = freshness(now, t.lastActive, s.tauMs);
    if (t.committed) {
      const thin = t.cleanTextLen < s.thinCharLimit;
      const rel = thin ? undefined : ctx.relevance?.get(t.tabId);
      const keepScore =
        rel === undefined ? fresh : s.wRelevance * ((rel + 1) / 2) + s.wFreshness * fresh;
      cands.push({ tabId: t.tabId, windowId: t.windowId, thin, capturable: false, keepScore });
    } else if (now - t.lastActive > s.overAgeMs) {
      // Uncapturable-so-far & very old: treat as empty, close directly.
      cands.push({ tabId: t.tabId, windowId: t.windowId, thin: true, capturable: false, keepScore: fresh });
    } else {
      // Never committed but inactive: index it first, then close on a later tick.
      cands.push({ tabId: t.tabId, windowId: t.windowId, thin: false, capturable: true, keepScore: fresh });
    }
  }

  // Priority: thin (junk) first; then least-worth-keeping (lowest keepScore).
  cands.sort((a, b) => {
    if (a.thin !== b.thin) return a.thin ? -1 : 1;
    return a.keepScore - b.keepScore;
  });

  let overflow = total - s.keep;
  const decision: AutoCloseDecision = { close: [], capture: [] };
  for (const c of cands) {
    if (overflow <= 0) break;
    if ((winRemaining.get(c.windowId) ?? 0) <= 1) continue; // don't empty a window
    if (c.capturable) decision.capture.push(c.tabId);
    else decision.close.push(c.tabId);
    winRemaining.set(c.windowId, (winRemaining.get(c.windowId) ?? 0) - 1);
    overflow--;
  }
  return decision;
}

export function isInternalUrl(url: string): boolean {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('chrome-error://') ||
    url.startsWith('devtools://') ||
    url.startsWith('view-source:')
  );
}

// ---- session-scoped tab state (cleared on browser restart, survives SW sleep) ----

const SS = {
  lastActive: 'ac_lastActive',
  recentOpened: 'ac_recentOpened',
  sessionStart: 'ac_sessionStart',
  formDirty: 'ac_formDirty',
} as const;

async function ssGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const r = await chrome.storage.session.get(key);
    return (r[key] as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}
async function ssSet(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {
    /* ignore */
  }
}

/**
 * The session-start timestamp is set once per browser session (survives SW
 * restarts via storage.session, resets on browser restart). This anchors the
 * post-restart grace window so recovered tabs are not culled immediately.
 */
async function ensureSessionStart(now: number): Promise<number> {
  const cur = await ssGet<number>(SS.sessionStart, 0);
  if (cur > 0) return cur;
  await ssSet(SS.sessionStart, now);
  return now;
}

export async function recordActivation(tabId: number): Promise<void> {
  const m = await ssGet<Record<string, number>>(SS.lastActive, {});
  m[tabId] = Date.now();
  await ssSet(SS.lastActive, m);
}

export async function recordCreation(tabId: number): Promise<void> {
  const list = await ssGet<{ tabId: number; ts: number }[]>(SS.recentOpened, []);
  list.push({ tabId, ts: Date.now() });
  await ssSet(SS.recentOpened, list.slice(-AC_DEFAULTS.recentOpenedCap));
}

export async function forgetTab(tabId: number): Promise<void> {
  const m = await ssGet<Record<string, number>>(SS.lastActive, {});
  if (tabId in m) {
    delete m[tabId];
    await ssSet(SS.lastActive, m);
  }
  await clearFormDirty(tabId);
}

/** Mark/clear a tab as having unsaved form input (reported by the content script). */
export async function markFormDirty(tabId: number): Promise<void> {
  const m = await ssGet<Record<string, true>>(SS.formDirty, {});
  if (!m[tabId]) {
    m[tabId] = true;
    await ssSet(SS.formDirty, m);
  }
}
export async function clearFormDirty(tabId: number): Promise<void> {
  const m = await ssGet<Record<string, true>>(SS.formDirty, {});
  if (m[tabId]) {
    delete m[tabId];
    await ssSet(SS.formDirty, m);
  }
}

// ---- context signals for relevance ----

async function buildSignals(
  tabInfos: TabInfo[],
  recMap: Map<string, PageRecord>,
  tabById: Map<number, chrome.tabs.Tab>,
): Promise<string[]> {
  const out: string[] = [];

  // Recent search terms live in the palette's chrome.storage.local history
  // (not in the events store, which records only query lengths — privacy).
  try {
    const r = await chrome.storage.local.get('sr_history');
    for (const q of ((r['sr_history'] as string[]) ?? []).slice(0, AC_DEFAULTS.signalQueryCap)) {
      if (q) out.push(q);
    }
  } catch {
    /* ignore */
  }

  // Current (active) tabs: their captured text if available, else the title.
  for (const t of tabInfos) {
    if (!t.active) continue;
    const text = recMap.get(t.recordId)?.cleanText || tabById.get(t.tabId)?.title || '';
    if (text) out.push(text.slice(0, 400));
  }

  // Most-recently-opened tabs' current titles.
  const recent = await ssGet<{ tabId: number; ts: number }[]>(SS.recentOpened, []);
  const recentSorted = [...recent].sort((a, b) => b.ts - a.ts).slice(0, AC_DEFAULTS.signalTitleCap);
  for (const { tabId } of recentSorted) {
    const title = tabById.get(tabId)?.title;
    if (title) out.push(title.slice(0, 200));
  }

  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}

// ---- orchestration ----

export async function runAutoClose(): Promise<void> {
  if (!(await isAutoCloseEnabled()) || !(await isAutoCloseConsented())) return;

  const now = Date.now();
  const sessionStart = await ensureSessionStart(now);
  if (now - sessionStart < AC_DEFAULTS.graceMs) return; // post-restart grace

  const keep = await getAutoCloseKeep();
  const settings: AutoCloseSettings = {
    keep,
    thinCharLimit: AC_DEFAULTS.thinChars,
    minInactiveMs: AC_DEFAULTS.minInactiveMs,
    overAgeMs: AC_DEFAULTS.overAgeMs,
    tauMs: AC_DEFAULTS.tauMs,
    wRelevance: AC_DEFAULTS.wRelevance,
    wFreshness: AC_DEFAULTS.wFreshness,
  };

  const liveTabs = await chrome.tabs.query({});
  const records = await allRecords();
  const recMap = new Map(records.map((r) => [r.id, r]));
  const lastActive = await ssGet<Record<string, number>>(SS.lastActive, {});
  const formDirty = await ssGet<Record<string, true>>(SS.formDirty, {});

  const tabInfos: TabInfo[] = [];
  const tabById = new Map<number, chrome.tabs.Tab>();
  for (const tab of liveTabs) {
    if (tab.id === undefined) continue;
    tabById.set(tab.id, tab);
    const url = tab.url || tab.pendingUrl || '';
    const internal = isInternalUrl(url);
    let recordId = '';
    let rec: PageRecord | undefined;
    if (!internal) {
      recordId = await recordIdFor(normalizeUrl(url));
      rec = recMap.get(recordId);
    }
    tabInfos.push({
      tabId: tab.id,
      windowId: tab.windowId,
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      grouped: (tab.groupId ?? -1) !== -1,
      incognito: !!tab.incognito,
      internal,
      hasFormInput: !!formDirty[tab.id],
      recordId,
      committed: !!rec && rec.status === 'committed' && rec.cleanText.length > 0,
      cleanTextLen: rec?.cleanText.length ?? 0,
      // Prefer the browser's authoritative last-accessed time (Chrome/Edge 121+);
      // it reflects real inactivity even for tabs never activated during this SW
      // session (background-opened / session-restored). Fall back to our own
      // activation map, then to `now` (protective) when nothing is known.
      lastActive:
        (tab as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ??
        lastActive[tab.id] ??
        now,
    });
  }

  // Relevance is best-effort and only when the model is already loaded.
  let relevance: Map<number, number> | undefined;
  const st = await offscreenState().catch(() => null);
  if (st?.state === 'READY') {
    const signals = await buildSignals(tabInfos, recMap, tabById);
    const candIds = [...new Set(tabInfos.filter((t) => t.committed).map((t) => t.recordId))];
    if (signals.length && candIds.length) {
      const res = await scoreAgainst(signals, candIds).catch(() => null);
      if (res?.ok) {
        const byRecord = new Map(res.scores.map((x) => [x.id, x.score]));
        relevance = new Map();
        for (const t of tabInfos) {
          const sc = t.committed ? byRecord.get(t.recordId) : undefined;
          if (sc !== undefined && sc > -1) relevance.set(t.tabId, sc);
        }
      }
    }
  }

  const decision = selectTabsToClose(tabInfos, settings, { now, withinGrace: false, relevance });
  const infoById = new Map(tabInfos.map((t) => [t.tabId, t]));

  // Force-capture never-committed inactive tabs so they become indexed (and thus
  // closable on a later tick), rather than waiting for the 24h over-age fallback.
  // Best-effort: needs a live content script; discarded/uncapturable tabs simply
  // stay until they age out. Capped per tick to smooth CPU.
  for (const id of decision.capture.slice(0, AC_DEFAULTS.captureCap)) {
    chrome.tabs.sendMessage(id, { type: 'FORCE_CAPTURE' }).catch(() => {});
  }

  if (!decision.close.length) return;

  // Re-verify against a fresh snapshot right before removing: the async scan may
  // have raced with the user closing tabs (never empty a window).
  const fresh = await chrome.tabs.query({});
  const winCount = new Map<number, number>();
  for (const t of fresh) if (!t.incognito) winCount.set(t.windowId, (winCount.get(t.windowId) ?? 0) + 1);
  const alive = new Set(fresh.map((t) => t.id));

  const finalClose: number[] = [];
  for (const id of decision.close) {
    const info = infoById.get(id);
    if (!info || !alive.has(id)) continue;
    if ((winCount.get(info.windowId) ?? 0) <= 1) continue;
    finalClose.push(id);
    winCount.set(info.windowId, (winCount.get(info.windowId) ?? 0) - 1);
  }
  if (!finalClose.length) return;

  const closedAt = Date.now();
  const entries: AutoClosedEntry[] = finalClose.map((id) => {
    const tab = tabById.get(id);
    const url = tab?.url || tab?.pendingUrl || '';
    return {
      url,
      title: tab?.title || url,
      domain: domainOf(url),
      favicon: tab?.favIconUrl,
      closedAt,
      indexed: !!infoById.get(id)?.committed,
    };
  });
  await chrome.tabs.remove(finalClose).catch(() => {});
  await appendAutoCloseLog(entries);
}
