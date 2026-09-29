import { describe, it, expect } from 'vitest';
import {
  selectTabsToClose,
  isInternalUrl,
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
