import { describe, it, expect } from 'vitest';
import {
  selectTabsToClose,
  isInternalUrl,
  isEmptyTabUrl,
  isLocalUrl,
  AC_DEFAULTS,
  type TabInfo,
  type AutoCloseSettings,
} from '../src/background/autoclose';

const NOW = 10_000_000_000;
const OLD = NOW - 60 * 60_000; // 1h idle: past minInactive, under overAge

function settings(keep: number): AutoCloseSettings {
  return {
    keep,
    thinCharLimit: AC_DEFAULTS.thinChars,
    minInactiveMs: AC_DEFAULTS.minInactiveMs,
    thinMinIdleMs: AC_DEFAULTS.thinMinIdleMs,
    localOpenGraceMs: AC_DEFAULTS.localOpenGraceMs,
    overAgeMs: AC_DEFAULTS.overAgeMs,
    tauMs: AC_DEFAULTS.tauMs,
    wRelevance: AC_DEFAULTS.wRelevance,
    wFreshness: AC_DEFAULTS.wFreshness,
    captureMaxAttempts: AC_DEFAULTS.captureMaxAttempts,
  };
}

let seq = 0;
function tab(over: Partial<TabInfo> = {}): TabInfo {
  seq += 1;
  return {
    tabId: seq,
    windowId: 1,
    active: false,
    pinned: false,
    audible: false,
    grouped: false,
    incognito: false,
    internal: false,
    empty: false,
    local: false,
    dupeKey: `r${seq}`,
    openedAt: 0,
    hasFormInput: false,
    discarded: false,
    captureAttempts: 0,
    recordId: `r${seq}`,
    committed: true,
    cleanTextLen: 500,
    lastActive: OLD,
    ...over,
  };
}

describe('selectTabsToClose (autoclose-plan v2, R6 contracts)', () => {
  it('does nothing when total tabs <= keep', () => {
    const tabs = [tab(), tab(), tab()];
    expect(selectTabsToClose(tabs, settings(12), { now: NOW, withinGrace: false })).toEqual({
      close: [],
      capture: [],
    });
  });

  it('closes nothing during the post-restart grace window', () => {
    const tabs = Array.from({ length: 20 }, () => tab());
    expect(selectTabsToClose(tabs, settings(12), { now: NOW, withinGrace: true })).toEqual({
      close: [],
      capture: [],
    });
  });

  it('never touches active / pinned / audible / grouped / internal tabs', () => {
    const active = tab({ active: true });
    const pinned = tab({ pinned: true });
    const audible = tab({ audible: true });
    const grouped = tab({ grouped: true });
    const internal = tab({ internal: true });
    const closable = tab();
    const tabs = [active, pinned, audible, grouped, internal, closable];
    // countable (non-pinned, non-grouped) = [active, audible, internal, closable] = 4; keep=1 → overflow=3
    // but only `closable` is eligible.
    const out = selectTabsToClose(tabs, settings(1), { now: NOW, withinGrace: false });
    expect(out.close).toEqual([closable.tabId]);
    expect(out.capture).toEqual([]);
  });

  it('pinned and grouped tabs do not count toward the keep threshold', () => {
    const pinned1 = tab({ pinned: true });
    const pinned2 = tab({ pinned: true });
    const grouped1 = tab({ grouped: true });
    const closable1 = tab();
    const closable2 = tab();
    // countable (non-pinned, non-grouped) = [closable1, closable2] = 2 == keep=2 → no action,
    // even though the raw tab count is 5.
    const tabs = [pinned1, pinned2, grouped1, closable1, closable2];
    expect(selectTabsToClose(tabs, settings(2), { now: NOW, withinGrace: false })).toEqual({
      close: [],
      capture: [],
    });
  });

  it('closes only the overflow of non-pinned/grouped tabs when mixed', () => {
    const pinned = tab({ pinned: true });
    const grouped = tab({ grouped: true });
    const closable = Array.from({ length: 4 }, () => tab());
    // countable = 4, keep=3 → overflow=1; only 1 regular tab is closed.
    const tabs = [pinned, grouped, ...closable];
    const out = selectTabsToClose(tabs, settings(3), { now: NOW, withinGrace: false });
    expect(out.close.length + out.capture.length).toBe(1);
    expect([...closable.map((t) => t.tabId)]).toContain(out.close[0] ?? out.capture[0]);
  });

  it('never closes a window\'s only tab', () => {
    const lone = tab({ windowId: 1 }); // sole tab of window 1
    const a = tab({ windowId: 2 });
    const b = tab({ windowId: 2 });
    const out = selectTabsToClose([lone, a, b], settings(2), { now: NOW, withinGrace: false });
    expect(out.close).not.toContain(lone.tabId);
    expect(out.close.length).toBe(1);
    expect([a.tabId, b.tabId]).toContain(out.close[0]);
  });

  it('never closes a tab with unsaved form input, even if old and over keep', () => {
    const anchor = tab({ active: true });
    const idleClosable = tab({ lastActive: NOW - 10 * 60 * 60_000 });
    const formTab = tab({ lastActive: NOW - 20 * 60 * 60_000, hasFormInput: true }); // older, but dirty
    const out = selectTabsToClose([anchor, idleClosable, formTab], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).not.toContain(formTab.tabId);
    expect(out.capture).not.toContain(formTab.tabId);
    expect(out.close).toEqual([idleClosable.tabId]);
  });

  it('protects just-restored tabs (lastActive unknown => now) via min-inactivity', () => {
    // Simulates browser restart: session activation table empty -> caller passes now.
    const tabs = Array.from({ length: 20 }, () => tab({ lastActive: NOW }));
    expect(selectTabsToClose(tabs, settings(12), { now: NOW, withinGrace: false })).toEqual({
      close: [],
      capture: [],
    });
  });

  it('closes thin (no substantive content) tabs first', () => {
    const anchor = tab({ active: true }); // keeps window non-unique
    const substantiveOld = tab({ cleanTextLen: 800, lastActive: NOW - 10 * 60 * 60_000 });
    const thin = tab({ cleanTextLen: 10, lastActive: OLD });
    // total 3, keep 2 -> close exactly 1, must be the thin one despite being fresher.
    const out = selectTabsToClose([anchor, substantiveOld, thin], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([thin.tabId]);
  });

  it('does not jump a recently used thin tab ahead of older substantive ones', () => {
    // Regression: a just-used login / confirmation page (little text) was closed
    // 5 minutes after use while hours-old substantive tabs stayed open.
    const anchor = tab({ active: true });
    const substantiveOld = tab({ cleanTextLen: 800, lastActive: NOW - 6 * 60 * 60_000 });
    const thinRecent = tab({ cleanTextLen: 30, lastActive: NOW - 6 * 60_000 });
    const out = selectTabsToClose([anchor, substantiveOld, thinRecent], settings(2), {
      now: NOW,
      withinGrace: false,
      relevance: new Map([[substantiveOld.tabId, 0.9]]),
    });
    expect(out.close).toEqual([substantiveOld.tabId]);
  });

  it('does not jump a recently used uncapturable tab ahead of older substantive ones', () => {
    // Store pages etc. never commit; after the capture budget they become closeable,
    // but must still be ranked by freshness until idle long enough to count as junk.
    const anchor = tab({ active: true });
    const substantiveOld = tab({ cleanTextLen: 800, lastActive: NOW - 6 * 60 * 60_000 });
    const uncapturable = tab({
      committed: false,
      cleanTextLen: 0,
      lastActive: NOW - 10 * 60_000,
      captureAttempts: AC_DEFAULTS.captureMaxAttempts,
    });
    const out = selectTabsToClose([anchor, substantiveOld, uncapturable], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([substantiveOld.tabId]);
  });

  it('routes never-committed inactive tabs to capture; closes over-age ones as thin', () => {
    const anchor = tab({ active: true });
    const young = tab({ committed: false, cleanTextLen: 0, lastActive: OLD }); // 1h -> capture (index then close)
    const old = tab({
      committed: false,
      cleanTextLen: 0,
      lastActive: NOW - 30 * 60 * 60_000, // 30h > 24h -> close as thin now
    });
    // keep=1, total=3 (anchor excluded) -> overflow 2, both acted on.
    const out = selectTabsToClose([anchor, young, old], settings(1), { now: NOW, withinGrace: false });
    expect(out.close).toEqual([old.tabId]); // thin (over-age) first
    expect(out.capture).toEqual([young.tabId]); // indexed before closing later
  });

  it('closes discarded uncommitted tabs directly (FORCE_CAPTURE would loop forever on dead renderer)', () => {
    const anchor = tab({ active: true });
    // discarded: content script dead, FORCE_CAPTURE cannot succeed
    const discarded = tab({ committed: false, cleanTextLen: 0, lastActive: OLD, discarded: true });
    const live = tab({ committed: false, cleanTextLen: 0, lastActive: OLD, discarded: false });
    // keep=1, total=3 -> overflow 2
    const out = selectTabsToClose([anchor, discarded, live], settings(1), { now: NOW, withinGrace: false });
    // discarded tab treated as thin -> goes to close, not capture
    expect(out.close).toContain(discarded.tabId);
    expect(out.capture).toContain(live.tabId);
    expect(out.capture).not.toContain(discarded.tabId);
  });

  it('retries capture while under the attempt budget (preserves full-text indexing)', () => {
    // A capturable-but-not-yet-committed tab must be indexed before it is closed,
    // otherwise auto-close would silently degrade the index to url+title only.
    const anchor = tab({ active: true });
    const liveCapturable = Array.from({ length: 13 }, () =>
      tab({ committed: false, cleanTextLen: 0, lastActive: OLD, captureAttempts: 0 }),
    );
    const out = selectTabsToClose([anchor, ...liveCapturable], settings(12), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.capture.length).toBe(2); // overflow=2, both get a capture attempt
    expect(out.close.length).toBe(0); // nothing closed yet — capture comes first
  });

  it('closes uncommitted tabs once the capture-attempt budget is exhausted', () => {
    // Contract: FORCE_CAPTURE failing forever (CSP / no content script / tab opened
    // before install) must NOT wedge auto-close. After captureMaxAttempts ticks the
    // tab is reclassified as closeable so the keep limit is actually enforced.
    const anchor = tab({ active: true });
    const exhausted = Array.from({ length: 13 }, () =>
      tab({
        committed: false,
        cleanTextLen: 0,
        lastActive: OLD,
        captureAttempts: AC_DEFAULTS.captureMaxAttempts,
      }),
    );
    const out = selectTabsToClose([anchor, ...exhausted], settings(12), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close.length).toBe(2); // overflow=2 actually closed
    expect(out.capture.length).toBe(0); // no more pointless capture attempts
  });

  it('does not close an uncommitted tab one attempt short of the budget', () => {
    // Boundary: the budget is a >= comparison, so attempts = max-1 must still capture.
    const anchor = tab({ active: true });
    const almost = Array.from({ length: 13 }, () =>
      tab({
        committed: false,
        cleanTextLen: 0,
        lastActive: OLD,
        captureAttempts: AC_DEFAULTS.captureMaxAttempts - 1,
      }),
    );
    const out = selectTabsToClose([anchor, ...almost], settings(12), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.capture.length).toBe(2);
    expect(out.close.length).toBe(0);
  });

  it('among substantive tabs, closes the least relevant first', () => {
    const anchor = tab({ active: true });
    const relevant = tab({ lastActive: OLD });
    const irrelevant = tab({ lastActive: OLD }); // same freshness -> relevance decides
    const relevance = new Map<number, number>([
      [relevant.tabId, 0.9],
      [irrelevant.tabId, -0.9],
    ]);
    const out = selectTabsToClose([anchor, relevant, irrelevant], settings(2), {
      now: NOW,
      withinGrace: false,
      relevance,
    });
    expect(out.close).toEqual([irrelevant.tabId]);
  });

  it('acts on exactly the overflow (N boundary), no further', () => {
    const anchor = tab({ active: true });
    const closable = Array.from({ length: 5 }, () => tab());
    const tabs = [anchor, ...closable]; // total 6
    const out = selectTabsToClose(tabs, settings(4), { now: NOW, withinGrace: false });
    expect(out.close.length + out.capture.length).toBe(2); // 6 -> 4
  });
});

describe('selectTabsToClose — expendable tabs first', () => {
  it('closes blank/new-tab tabs before substantive tabs', () => {
    const anchor = tab({ active: true });
    const substantive = tab({ cleanTextLen: 800, lastActive: NOW - 10 * 60 * 60_000 });
    const blank = tab({ empty: true, internal: true, committed: false, cleanTextLen: 0 });
    // total 3, keep 2 -> overflow 1
    const out = selectTabsToClose([anchor, substantive, blank], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([blank.tabId]);
  });

  it('still never closes a non-empty internal tab', () => {
    const anchor = tab({ active: true });
    const settingsTab = tab({ internal: true });
    const substantive = tab({ cleanTextLen: 800 });
    // total 3, keep 2 -> overflow 1; only the substantive tab is eligible.
    const out = selectTabsToClose([anchor, settingsTab, substantive], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([substantive.tabId]);
    expect(out.close).not.toContain(settingsTab.tabId);
  });

  it('collapses duplicate URLs to one copy before closing substantive tabs', () => {
    const anchor = tab({ active: true });
    const substantive = tab({ cleanTextLen: 800, lastActive: NOW - 10 * 60 * 60_000 });
    const keep = tab({ dupeKey: 'same', lastActive: NOW - 30 * 60_000 });
    const dupOld = tab({ dupeKey: 'same', lastActive: NOW - 2 * 60 * 60_000 });
    const dupOlder = tab({ dupeKey: 'same', lastActive: NOW - 3 * 60 * 60_000 });
    // total 5, keep 3 -> overflow 2; both older copies close, fresh copy stays.
    const out = selectTabsToClose([anchor, substantive, keep, dupOld, dupOlder], settings(3), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close.sort()).toEqual([dupOld.tabId, dupOlder.tabId].sort());
    expect(out.close).not.toContain(keep.tabId);
    expect(out.close).not.toContain(substantive.tabId);
  });

  it('keeps an active duplicate and closes the inactive copy', () => {
    const active = tab({ dupeKey: 'same', active: true });
    const dup = tab({ dupeKey: 'same', lastActive: OLD });
    const substantive = tab({ cleanTextLen: 800 });
    // total 3, keep 2 -> overflow 1
    const out = selectTabsToClose([active, dup, substantive], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([dup.tabId]);
  });

  it('never closes the last copy of a duplicated URL', () => {
    const older = tab({ dupeKey: 'same', lastActive: NOW - 3 * 60 * 60_000 });
    const newer = tab({ dupeKey: 'same', lastActive: NOW - 2 * 60 * 60_000 });
    // total 2, keep 1 -> overflow 1; the older copy closes, the newer stays.
    const out = selectTabsToClose([older, newer], settings(1), { now: NOW, withinGrace: false });
    expect(out.close).toEqual([older.tabId]);
  });

  it('closes duplicate copies directly even when not yet indexed', () => {
    const anchor = tab({ active: true });
    const keep = tab({ dupeKey: 'same', lastActive: NOW - 30 * 60_000 });
    const dup = tab({
      dupeKey: 'same',
      committed: false,
      cleanTextLen: 0,
      lastActive: NOW - 2 * 60 * 60_000,
    });
    // total 3, keep 2 -> overflow 1
    const out = selectTabsToClose([anchor, keep, dup], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([dup.tabId]);
    expect(out.capture).toEqual([]);
  });

  it('closes an old local tab before a substantive tab', () => {
    const anchor = tab({ active: true });
    const substantive = tab({ cleanTextLen: 800, lastActive: NOW - 10 * 60 * 60_000 });
    const local = tab({ local: true, openedAt: NOW - 2 * 60 * 60_000, lastActive: OLD });
    // total 3, keep 2 -> overflow 1
    const out = selectTabsToClose([anchor, substantive, local], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([local.tabId]);
  });

  it('does not prioritize a local tab opened less than the grace period ago', () => {
    const anchor = tab({ active: true });
    const substantive = tab({ cleanTextLen: 800, lastActive: NOW - 10 * 60 * 60_000 });
    const local = tab({
      local: true,
      openedAt: NOW - 10 * 60_000,
      lastActive: NOW - 10 * 60_000,
    });
    // total 3, keep 2 -> overflow 1. The local tab is within its open grace, so
    // ordinary freshness ranking closes the older substantive tab instead.
    const out = selectTabsToClose([anchor, substantive, local], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([substantive.tabId]);
    expect(out.close).not.toContain(local.tabId);
  });

  it('fully protects a local tab inside its open grace, even as the only candidate', () => {
    const anchor = tab({ active: true });
    const localA = tab({ local: true, openedAt: NOW - 10 * 60_000, lastActive: NOW - 10 * 60_000 });
    const localB = tab({ local: true, openedAt: NOW - 20 * 60_000, lastActive: NOW - 20 * 60_000 });
    // total 3, keep 1 -> overflow 2, but both local tabs are inside the 1h grace.
    const out = selectTabsToClose([anchor, localA, localB], settings(1), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([]);
    expect(out.capture).toEqual([]);
  });

  it('closes an old chrome:// tab before a substantive tab', () => {
    const anchor = tab({ active: true });
    const substantive = tab({ cleanTextLen: 800, lastActive: NOW - 10 * 60 * 60_000 });
    const chrome = tab({
      internal: true,
      local: true,
      committed: false,
      cleanTextLen: 0,
      openedAt: NOW - 2 * 60 * 60_000,
      lastActive: OLD,
    });
    // total 3, keep 2 -> overflow 1
    const out = selectTabsToClose([anchor, substantive, chrome], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([chrome.tabId]);
    expect(out.capture).toEqual([]);
  });

  it('does not capture a chrome:// tab inside its open grace', () => {
    const anchor = tab({ active: true });
    const chrome = tab({
      internal: true,
      local: true,
      committed: false,
      cleanTextLen: 0,
      openedAt: NOW - 10 * 60_000,
      lastActive: NOW - 10 * 60_000,
    });
    // total 2, keep 1 -> overflow 1; the chrome:// tab is protected by the grace.
    const out = selectTabsToClose([anchor, chrome], settings(1), {
      now: NOW,
      withinGrace: false,
    });
    expect(out.close).toEqual([]);
    expect(out.capture).toEqual([]);
  });

  it('closes an old uncommitted local tab directly instead of capturing it', () => {
    const anchor = tab({ active: true });
    const local = tab({
      local: true,
      committed: false,
      cleanTextLen: 0,
      openedAt: NOW - 2 * 60 * 60_000,
      lastActive: OLD,
    });
    // total 2, keep 1 -> overflow 1
    const out = selectTabsToClose([anchor, local], settings(1), { now: NOW, withinGrace: false });
    expect(out.close).toEqual([local.tabId]);
    expect(out.capture).toEqual([]);
  });
});

describe('isInternalUrl', () => {
  it('flags browser-internal and extension URLs', () => {
    for (const u of [
      '',
      'chrome://newtab/',
      'chrome-extension://abc/page.html',
      'edge://settings',
      'about:blank',
      'chrome-error://chromewebdata/',
      'devtools://devtools/',
      'view-source:https://x.com',
    ]) {
      expect(isInternalUrl(u)).toBe(true);
    }
  });
  it('treats real web pages as non-internal', () => {
    expect(isInternalUrl('https://example.com/article')).toBe(false);
    expect(isInternalUrl('http://localhost:3000/')).toBe(false);
  });
});

describe('isEmptyTabUrl', () => {
  it('flags blank and new-tab pages', () => {
    for (const u of [
      '',
      'about:blank',
      'about:newtab',
      'chrome://newtab/',
      'chrome://newtab',
      'chrome://newtab/?source=abc',
      'chrome://new-tab-page/',
      'edge://newtab/',
      'chrome-search://local-ntp/local-ntp.html',
    ]) {
      expect(isEmptyTabUrl(u)).toBe(true);
    }
  });
  it('does not flag real pages or other internal pages', () => {
    for (const u of ['https://example.com', 'chrome://settings', 'about:preferences']) {
      expect(isEmptyTabUrl(u)).toBe(false);
    }
  });
});

describe('isLocalUrl', () => {
  it('flags files, loopback and mDNS hosts', () => {
    for (const u of [
      'file:///Users/a.pdf',
      'http://localhost:3000/',
      'http://app.localhost:5173/',
      'http://127.0.0.1:8080/',
      'http://[::1]:5173/',
      'http://myapp.local/',
      'chrome://settings/',
      'edge://settings/',
    ]) {
      expect(isLocalUrl(u)).toBe(true);
    }
  });
  it('does not flag remote, private-LAN, or non-local internal pages', () => {
    for (const u of [
      'https://example.com',
      'http://192.168.1.10/',
      'https://localhost.example.com/',
      'chrome-extension://abc/page.html',
      'devtools://devtools/',
    ]) {
      expect(isLocalUrl(u)).toBe(false);
    }
  });
});

describe('selectTabsToClose — first-run tidy settings', () => {
  // runAutoClose({ install: true }): no idle minimum, capture already attempted.
  const install = (keep: number): AutoCloseSettings => ({
    ...settings(keep),
    minInactiveMs: 0,
    captureMaxAttempts: 0,
  });

  it('closes never-committed tabs instead of deferring them to a capture tick', () => {
    const tabs = Array.from({ length: 5 }, () => tab({ committed: false, cleanTextLen: 0 }));
    const d = selectTabsToClose(tabs, install(2), { now: NOW, withinGrace: false });
    expect(d.capture).toEqual([]);
    expect(d.close).toHaveLength(3);
  });

  it('can close just-used tabs but keeps the freshest ones', () => {
    const stale = tab({ lastActive: NOW - 3 * 60 * 60_000 });
    const recent = tab({ lastActive: NOW - 60_000 });
    const d = selectTabsToClose([stale, recent], install(1), { now: NOW, withinGrace: false });
    expect(d.close).toEqual([stale.tabId]);
  });

  it('still protects active, pinned, grouped, audible and form-filled tabs', () => {
    const tabs = [
      tab({ active: true }),
      tab({ pinned: true }),
      tab({ grouped: true }),
      tab({ audible: true }),
      tab({ hasFormInput: true }),
      tab(),
      tab(),
    ];
    const d = selectTabsToClose(tabs, install(1), { now: NOW, withinGrace: false });
    expect(d.close.every((id) => id === tabs[5].tabId || id === tabs[6].tabId)).toBe(true);
  });
});
