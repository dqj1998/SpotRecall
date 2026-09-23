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
    expect(selectTabsToClose(tabs, settings(12), { now: NOW, withinGrace: false })).toEqual([]);
  });

  it('closes nothing during the post-restart grace window', () => {
    const tabs = Array.from({ length: 20 }, () => tab());
    expect(selectTabsToClose(tabs, settings(12), { now: NOW, withinGrace: true })).toEqual([]);
  });

  it('never touches active / pinned / audible / grouped / internal tabs', () => {
    const active = tab({ active: true });
    const pinned = tab({ pinned: true });
    const audible = tab({ audible: true });
    const grouped = tab({ grouped: true });
    const internal = tab({ internal: true });
    const closable = tab();
    const tabs = [active, pinned, audible, grouped, internal, closable];
    // keep=1 wants 5 closed, but only `closable` is eligible.
    const out = selectTabsToClose(tabs, settings(1), { now: NOW, withinGrace: false });
    expect(out).toEqual([closable.tabId]);
  });

  it('never closes a window\'s only tab', () => {
    const lone = tab({ windowId: 1 }); // sole tab of window 1
    const a = tab({ windowId: 2 });
    const b = tab({ windowId: 2 });
    const out = selectTabsToClose([lone, a, b], settings(2), { now: NOW, withinGrace: false });
    expect(out).not.toContain(lone.tabId);
    expect(out.length).toBe(1);
    expect([a.tabId, b.tabId]).toContain(out[0]);
  });

  it('never closes a tab with unsaved form input, even if old and over keep', () => {
    const anchor = tab({ active: true });
    const idleClosable = tab({ lastActive: NOW - 10 * 60 * 60_000 });
    const formTab = tab({ lastActive: NOW - 20 * 60 * 60_000, hasFormInput: true }); // older, but dirty
    const out = selectTabsToClose([anchor, idleClosable, formTab], settings(2), {
      now: NOW,
      withinGrace: false,
    });
    expect(out).not.toContain(formTab.tabId);
    expect(out).toEqual([idleClosable.tabId]);
  });

  it('protects just-restored tabs (lastActive unknown => now) via min-inactivity', () => {
    // Simulates browser restart: session activation table empty -> caller passes now.
    const tabs = Array.from({ length: 20 }, () => tab({ lastActive: NOW }));
    expect(selectTabsToClose(tabs, settings(12), { now: NOW, withinGrace: false })).toEqual([]);
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
    expect(out).toEqual([thin.tabId]);
  });

  it('option A: never-committed is skipped until over-age, then treated as thin', () => {
    const anchor = tab({ active: true });
    const young = tab({ committed: false, cleanTextLen: 0, lastActive: OLD }); // 1h, not over-age
    const old = tab({
      committed: false,
      cleanTextLen: 0,
      lastActive: NOW - 30 * 60 * 60_000, // 30h > 24h over-age
    });
    const out = selectTabsToClose([anchor, young, old], settings(2), { now: NOW, withinGrace: false });
    expect(out).toEqual([old.tabId]);
    expect(out).not.toContain(young.tabId);
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
    expect(out).toEqual([irrelevant.tabId]);
  });

  it('closes exactly down to keep (N boundary), no further', () => {
    const anchor = tab({ active: true });
    const closable = Array.from({ length: 5 }, () => tab());
    const tabs = [anchor, ...closable]; // total 6
    const out = selectTabsToClose(tabs, settings(4), { now: NOW, withinGrace: false });
    expect(out.length).toBe(2); // 6 -> 4
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
