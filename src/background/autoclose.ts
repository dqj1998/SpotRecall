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
  getRecord,
} from '@storage/dao';
import type { AutoClosedEntry, PageRecord } from '@shared/types';
import { domainOf } from '@shared/url';
import { offscreenState, scoreAgainst } from './offscreen-manager';
import { currentRecordId } from './instances';

// ---- tunables (confirmed 2026-09-23) ----
export const AC_DEFAULTS = {
  keep: 12,
  thinChars: 100, // committed & shorter => "no substantive content"
  minInactiveMs: 5 * 60_000, // a tab must be idle this long to be eligible
  thinMinIdleMs: 60 * 60_000, // thin tabs jump the queue only once idle this long
  graceMs: 10 * 60_000, // after browser/session start, close nothing
  overAgeMs: 24 * 60 * 60_000, // never-committed & older => treated as thin (option A)
  tauMs: 12 * 60 * 60_000, // freshness = exp(-Δt/τ)
  wRelevance: 0.5,
  wFreshness: 0.5,
  recentOpenedCap: 20,
  signalQueryCap: 5,
  signalTitleCap: 5,
  captureCap: 15, // max never-committed tabs to force-capture per tick
  captureMaxAttempts: 3, // give up forcing capture after this many ticks, then close
  localOpenGraceMs: 60 * 60_000, // local tabs must be open this long before priority
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
  /** Address bar is empty (new tab / blank page): no page state worth keeping. */
  empty: boolean;
  /** Cheap to reopen locally (file://, loopback, .local host, chrome:///edge://). */
  local: boolean;
  /** Normalized-URL identity for duplicate detection; '' = not deduplicated. */
  dupeKey: string;
  /** ms when the tab was opened; 0 = unknown. */
  openedAt: number;
  /** Page has unsaved form input (user typed but didn't submit) — never close. */
  hasFormInput: boolean;
  /**
   * Chrome discarded the renderer (low-memory eviction). The content script is
   * dead so FORCE_CAPTURE will always silently fail. Treat as thin/closeable
   * directly rather than looping capture indefinitely.
   */
  discarded: boolean;
  /**
   * How many ticks we have already sent FORCE_CAPTURE to this tab without it
   * committing. Bounds the retry so a permanently uncapturable tab (CSP, no
   * content script, opened before install) cannot block the overflow forever.
   */
  captureAttempts: number;
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
  /**
   * A thin tab is closed ahead of substantive ones only after this much idle
   * time. Before that it is ranked by freshness like any other tab: thin pages
   * are often ones the user is in the middle of (login / confirmation / search
   * flows yield little text, store pages can't be captured at all).
   */
  thinMinIdleMs: number;
  /**
   * Local pages (file://, loopback, chrome:///edge://) are cheap to reopen, so
   * they are closed ahead of substantive tabs — but only after being open this
   * long, so a just-opened dev tab is not killed mid-task.
   */
  localOpenGraceMs: number;
  overAgeMs: number;
  tauMs: number;
  wRelevance: number;
  wFreshness: number;
  captureMaxAttempts: number;
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
 * tab count exceeds `keep`; then walks candidates in priority order
 * (blank > duplicate > local > thin > substantive) up to the overflow — never
 * emptying a window and never touching an excluded tab. Never-committed inactive
 * tabs are routed to `capture` (indexed then closed next tick) instead of being
 * skipped.
 */
export function selectTabsToClose(
  tabs: TabInfo[],
  s: AutoCloseSettings,
  ctx: AutoCloseContext,
): AutoCloseDecision {
  const none: AutoCloseDecision = { close: [], capture: [] };
  if (ctx.withinGrace) return none;

  const normal = tabs.filter((t) => !t.incognito);
  // Pinned and grouped tabs are excluded from the keep count: users accumulate
  // many of them intentionally and closing regular tabs to compensate is surprising.
  const total = normal.filter((t) => !t.pinned && !t.grouped).length;
  if (total <= s.keep) return none;

  // winRemaining uses the full normal set so the "never empty a window" guard
  // accounts for every tab in the window, including pinned/grouped ones.
  const winRemaining = new Map<number, number>();
  for (const t of normal) winRemaining.set(t.windowId, (winRemaining.get(t.windowId) ?? 0) + 1);

  const now = ctx.now;
  const freshOf = (t: TabInfo) => freshness(now, t.lastActive, s.tauMs);
  const keepScoreOf = (t: TabInfo): number => {
    const fresh = freshOf(t);
    if (!t.committed) return fresh;
    const thinText = t.cleanTextLen < s.thinCharLimit;
    const rel = thinText ? undefined : ctx.relevance?.get(t.tabId);
    return rel === undefined ? fresh : s.wRelevance * ((rel + 1) / 2) + s.wFreshness * fresh;
  };

  // Duplicate URLs are pure redundancy. Keep one copy per normalized URL: prefer
  // a hard-protected tab, else the most recently used (then the one with the most
  // captured text). Every other copy is ranked ahead of substantive tabs below.
  const groups = new Map<string, TabInfo[]>();
  for (const t of normal) {
    if (!t.dupeKey) continue;
    const g = groups.get(t.dupeKey);
    if (g) g.push(t);
    else groups.set(t.dupeKey, [t]);
  }
  const keeperFor = new Map<string, number>();
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const protectedCopy =
      g.find((t) => t.active) ??
      g.find((t) => t.pinned || t.grouped) ??
      g.find((t) => t.audible) ??
      g.find((t) => t.hasFormInput);
    const keeper =
      protectedCopy ??
      [...g].sort(
        (a, b) =>
          b.lastActive - a.lastActive || b.cleanTextLen - a.cleanTextLen || a.tabId - b.tabId,
      )[0];
    keeperFor.set(key, keeper.tabId);
  }

  const TIER_EMPTY = 0;
  const TIER_DUPLICATE = 1;
  const TIER_LOCAL = 2;
  const TIER_THIN = 3;
  const TIER_NORMAL = 4;

  interface Cand {
    tabId: number;
    windowId: number;
    tier: number;
    capturable: boolean; // never-committed: index before closing
    keepScore: number;
  }
  const cands: Cand[] = [];

  for (const t of normal) {
    // Hard exclusions — never eligible.
    if (t.active || t.pinned || t.audible || t.grouped) continue;
    if (t.hasFormInput) continue; // unsaved form input — closing would lose data
    if (t.internal && !t.empty && !t.local) continue; // extension/devtools/error pages
    if ((winRemaining.get(t.windowId) ?? 0) <= 1) continue; // window's only tab
    if (now - t.lastActive < s.minInactiveMs) continue; // too recently used / just restored

    const fresh = freshOf(t);
    const stale = now - t.lastActive >= s.thinMinIdleMs; // eligible for the thin tier

    // Blank address bar / new tab: nothing to index, nothing to lose.
    if (t.empty) {
      cands.push({ tabId: t.tabId, windowId: t.windowId, tier: TIER_EMPTY, capturable: false, keepScore: fresh });
      continue;
    }

    // Never close the last copy of a duplicated URL.
    if (t.dupeKey && keeperFor.get(t.dupeKey) === t.tabId) continue;
    if (t.dupeKey && (groups.get(t.dupeKey)?.length ?? 0) > 1) {
      cands.push({
        tabId: t.tabId,
        windowId: t.windowId,
        tier: TIER_DUPLICATE,
        capturable: false,
        keepScore: keepScoreOf(t),
      });
      continue;
    }

    // Local pages are cheap to reopen, so close them ahead of substantive tabs —
    // but only once they have been open long enough that the user is unlikely to
    // still be mid-task. Within the grace they are fully protected (never closed
    // or captured). Closing directly is safe: the URL stays in the log.
    if (t.local) {
      const openAge = t.openedAt > 0 ? now - t.openedAt : now - t.lastActive;
      if (openAge < s.localOpenGraceMs) continue;
      cands.push({
        tabId: t.tabId,
        windowId: t.windowId,
        tier: TIER_LOCAL,
        capturable: false,
        keepScore: keepScoreOf(t),
      });
      continue;
    }

    if (t.committed) {
      const thinText = t.cleanTextLen < s.thinCharLimit;
      cands.push({
        tabId: t.tabId,
        windowId: t.windowId,
        tier: thinText && stale ? TIER_THIN : TIER_NORMAL,
        capturable: false,
        keepScore: keepScoreOf(t),
      });
    } else if (now - t.lastActive > s.overAgeMs || t.discarded) {
      // Close directly when: (a) never captured & very old, OR (b) Chrome
      // discarded the renderer — the content script is dead so FORCE_CAPTURE
      // would loop silently forever; closing is safe because a discarded tab
      // has no live renderer state to lose.
      cands.push({ tabId: t.tabId, windowId: t.windowId, tier: stale ? TIER_THIN : TIER_NORMAL, capturable: false, keepScore: fresh });
    } else if (t.captureAttempts >= s.captureMaxAttempts) {
      // FORCE_CAPTURE has been sent this many ticks with no commit: the content
      // script is absent or blocked (CSP, pre-install tab). Stop retrying and
      // close. Safe because the provisional record (url + title) outlives the
      // tab — handleTabRemoved no longer GCs it — so the page stays searchable.
      cands.push({ tabId: t.tabId, windowId: t.windowId, tier: stale ? TIER_THIN : TIER_NORMAL, capturable: false, keepScore: fresh });
    } else {
      // Never committed but inactive: index it first, then close on a later tick.
      cands.push({ tabId: t.tabId, windowId: t.windowId, tier: TIER_NORMAL, capturable: true, keepScore: fresh });
    }
  }

  // Priority: blank, duplicate, local, stale thin, then least-worth-keeping.
  cands.sort((a, b) => a.tier - b.tier || a.keepScore - b.keepScore);

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

/** Blank address bar / new tab page: carries no page state worth preserving. */
export function isEmptyTabUrl(url: string): boolean {
  if (!url) return true;
  const u = url.trim().toLowerCase();
  return (
    u === 'about:blank' ||
    u.startsWith('about:blank?') ||
    u.startsWith('about:blank#') ||
    u === 'about:newtab' ||
    u.startsWith('about:newtab?') ||
    u.startsWith('about:newtab#') ||
    u === 'chrome://newtab' ||
    u.startsWith('chrome://newtab/') ||
    u.startsWith('chrome://new-tab-page/') ||
    u === 'edge://newtab' ||
    u.startsWith('edge://newtab/') ||
    u.startsWith('chrome-search://local-ntp/')
  );
}

/** Cheap to reopen locally: file://, loopback, mDNS .local, and chrome:///edge:// pages. */
export function isLocalUrl(url: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return true;
  if (u.protocol === 'chrome:' || u.protocol === 'edge:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  return h.endsWith('.local');
}

// ---- session-scoped tab state (cleared on browser restart, survives SW sleep) ----

const SS = {
  lastActive: 'ac_lastActive',
  recentOpened: 'ac_recentOpened',
  sessionStart: 'ac_sessionStart',
  formDirty: 'ac_formDirty',
  captureAttempts: 'ac_captureAttempts',
  openedAt: 'ac_openedAt',
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
  const now = Date.now();
  const list = await ssGet<{ tabId: number; ts: number }[]>(SS.recentOpened, []);
  list.push({ tabId, ts: now });
  await ssSet(SS.recentOpened, list.slice(-AC_DEFAULTS.recentOpenedCap));

  const opened = await ssGet<Record<string, number>>(SS.openedAt, {});
  opened[tabId] = now;
  await ssSet(SS.openedAt, opened);
}

export async function forgetTab(tabId: number): Promise<void> {
  const m = await ssGet<Record<string, number>>(SS.lastActive, {});
  if (tabId in m) {
    delete m[tabId];
    await ssSet(SS.lastActive, m);
  }
  const att = await ssGet<Record<string, number>>(SS.captureAttempts, {});
  if (tabId in att) {
    delete att[tabId];
    await ssSet(SS.captureAttempts, att);
  }
  const opened = await ssGet<Record<string, number>>(SS.openedAt, {});
  if (tabId in opened) {
    delete opened[tabId];
    await ssSet(SS.openedAt, opened);
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

/**
 * `install`: the first-run tidy, run in front of the user on the welcome panel.
 * It skips the post-restart grace and the idle minimum (ranking still keeps the
 * freshest tabs), and closes never-committed tabs directly because
 * `captureExistingTabs` has already made its one capture attempt.
 */
export async function runAutoClose(opts: { install?: boolean } = {}): Promise<AutoClosedEntry[]> {
  if (!(await isAutoCloseEnabled()) || !(await isAutoCloseConsented())) return [];

  const now = Date.now();
  const sessionStart = await ensureSessionStart(now);
  if (!opts.install && now - sessionStart < AC_DEFAULTS.graceMs) return []; // post-restart grace

  const keep = await getAutoCloseKeep();
  const settings: AutoCloseSettings = {
    keep,
    thinCharLimit: AC_DEFAULTS.thinChars,
    minInactiveMs: opts.install ? 0 : AC_DEFAULTS.minInactiveMs,
    thinMinIdleMs: AC_DEFAULTS.thinMinIdleMs,
    localOpenGraceMs: AC_DEFAULTS.localOpenGraceMs,
    overAgeMs: AC_DEFAULTS.overAgeMs,
    tauMs: AC_DEFAULTS.tauMs,
    wRelevance: AC_DEFAULTS.wRelevance,
    wFreshness: AC_DEFAULTS.wFreshness,
    captureMaxAttempts: opts.install ? 0 : AC_DEFAULTS.captureMaxAttempts,
  };

  const liveTabs = await chrome.tabs.query({});
  const records = await allRecords();
  const recMap = new Map(records.map((r) => [r.id, r]));
  const lastActive = await ssGet<Record<string, number>>(SS.lastActive, {});
  const formDirty = await ssGet<Record<string, true>>(SS.formDirty, {});
  const captureAttempts = await ssGet<Record<string, number>>(SS.captureAttempts, {});
  const openedAtMap = await ssGet<Record<string, number>>(SS.openedAt, {});

  const tabInfos: TabInfo[] = [];
  const tabById = new Map<number, chrome.tabs.Tab>();
  for (const tab of liveTabs) {
    if (tab.id === undefined) continue;
    tabById.set(tab.id, tab);
    const url = tab.url || tab.pendingUrl || '';
    const empty = isEmptyTabUrl(url);
    const internal = isInternalUrl(url) && !empty;
    let recordId = '';
    let rec: PageRecord | undefined;
    if (!internal && !empty) {
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
      empty,
      local: isLocalUrl(url),
      dupeKey: internal || empty ? '' : recordId,
      openedAt: openedAtMap[tab.id] ?? 0,
      hasFormInput: !!formDirty[tab.id],
      discarded: !!(tab as chrome.tabs.Tab & { discarded?: boolean }).discarded,
      captureAttempts: captureAttempts[tab.id] ?? 0,
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
  // Each attempt is counted: after captureMaxAttempts the tab is reclassified as
  // closeable, so an uncapturable tab can no longer occupy the overflow forever.
  const attempted = decision.capture.slice(0, AC_DEFAULTS.captureCap);
  if (attempted.length) {
    for (const id of attempted) {
      chrome.tabs.sendMessage(id, { type: 'FORCE_CAPTURE' }).catch(() => {});
    }
    for (const id of attempted) captureAttempts[id] = (captureAttempts[id] ?? 0) + 1;
    await ssSet(SS.captureAttempts, captureAttempts);
  }

  if (!decision.close.length) return [];

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
  if (!finalClose.length) return [];

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
  return entries;
}

// ---- first-run capture of pre-install tabs ----

async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Tabs open before install have no content script (Chrome injects declared
 * scripts only into pages loaded afterwards), so FORCE_CAPTURE would reach
 * nothing and they would close with only the backfilled title + URL. Inject the
 * capture script, wait for each tab's INIT to register, then force a commit so
 * the full text is indexed before the first-run tidy. Discarded, restricted
 * (store / chrome://) and blocklisted tabs stay title + URL only.
 */
export async function captureExistingTabs(
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
  if (!file) return;
  const tabs = (await chrome.tabs.query({})).filter(
    (t) =>
      t.id !== undefined &&
      !t.incognito &&
      !(t as chrome.tabs.Tab & { discarded?: boolean }).discarded &&
      /^(https?|file):/.test(t.url || ''),
  );
  const injected: { tabId: number; recordId: string }[] = [];
  await Promise.all(
    tabs.map(async (t) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id! }, files: [file] });
        injected.push({ tabId: t.id!, recordId: await recordIdFor(normalizeUrl(t.url!)) });
      } catch {
        /* restricted page or tab went away */
      }
    }),
  );
  const total = injected.length;
  onProgress(0, total);
  if (!total) return;

  // A commit is accepted only for the instance INIT registered; committing
  // before that is dropped as a stale document.
  await waitUntil(async () => injected.every((x) => currentRecordId(x.tabId, 0) !== undefined), 3000);
  for (const x of injected) {
    chrome.tabs.sendMessage(x.tabId, { type: 'FORCE_CAPTURE' }).catch(() => {});
  }
  await waitUntil(async () => {
    let done = 0;
    for (const x of injected) {
      if ((await getRecord(x.recordId))?.status === 'committed') done++;
    }
    onProgress(done, total);
    return done === total;
  }, 6000);
}
