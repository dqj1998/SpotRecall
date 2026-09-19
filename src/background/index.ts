// Service Worker — the scheduling hub. Never does inference; never treats
// in-memory state as the source of truth.

import { handleInit, handleCommit, handleTabRemoved, handleFrameGone } from './lifecycle';
import { bm25Stage, vectorStage } from './search';
import { drainQueue, queueDepth } from './embed-queue';
import { resetBm25 } from './bm25-manager';
import {
  closeOffscreen,
  offscreenState,
  ensureOffscreen,
  ensureModel,
  vectorRemove,
} from './offscreen-manager';
import { logEvent } from './telemetry';
import {
  recordCount,
  isPaused,
  isSemanticEnabled,
  setMeta,
  getMeta,
  getBlacklist,
  getRetentionLimit,
  enforceRetention,
  clearAllData,
  allEvents,
  clearEvents,
} from '@storage/dao';
import { META_KEYS } from '@shared/types';
import type { IndexStatus } from '@shared/types';
import type { SearchResponse } from '@shared/protocol';

// ---------- startup ----------
async function bootstrap(): Promise<void> {
  // Ask for persistent storage; record the REAL result (false is not a failure).
  try {
    const granted = await navigator.storage?.persist?.();
    await setMeta(META_KEYS.persistGranted, !!granted);
  } catch {
    /* ignore */
  }
  if (!(await getMeta<string | null>(META_KEYS.sourceDeviceId, null))) {
    await setMeta(META_KEYS.sourceDeviceId, crypto.randomUUID());
  }
  chrome.alarms.create('maintenance', { periodInMinutes: 1 });
  // Returning users with semantic enabled: warm the model (from cache, offline).
  if (await isSemanticEnabled()) {
    void ensureOffscreen().then(() => ensureModel()).catch(() => {});
  }
  void maintenance();
}

async function maintenance(): Promise<void> {
  if (await isPaused()) return;
  const removed = await enforceRetention(await getRetentionLimit());
  if (removed.length) {
    await resetBm25();
    await vectorRemove(removed).catch(() => {});
  }
  await drainQueue();
}

chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'maintenance') void maintenance();
});

// ---------- capture events ----------
chrome.tabs.onRemoved.addListener((tabId) => void handleTabRemoved(tabId));

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  // SPA route change: content script is NOT re-injected, so ask it to re-init.
  chrome.tabs
    .sendMessage(details.tabId, { type: 'SPA_NAVIGATED' }, { frameId: details.frameId })
    .catch(() => {});
});

// A main-frame full navigation replaces the old document; drop its instance so
// a never-committed provisional gets GC'd. (New doc re-inits via content script.)
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0 && d.transitionType !== 'auto_subframe') {
    void handleFrameGone(d.tabId, d.frameId);
  }
});

// The palette is the action popup (anchored dropdown panel). It is opened
// natively by the toolbar icon and by the `_execute_action` command, so the SW
// needs no open/toggle wiring here.

// ---------- result opening + success tracking ----------
function openResult(url: string, queryId: string, rank: number, resultVersion: 1 | 2): void {
  logEvent('result_click', queryId, { rank, resultVersion });
  logEvent('open_attempt', queryId, { url });
  chrome.tabs.create({ url }, (tab) => {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        logEvent('open_success', queryId, { url });
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// ---------- status ----------
async function indexStatus(): Promise<IndexStatus> {
  const [total, pending, paused, semanticEnabled] = await Promise.all([
    recordCount(),
    queueDepth(),
    isPaused(),
    isSemanticEnabled(),
  ]);
  return { total, pending, paused, semanticEnabled };
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse): boolean => {
  // Offscreen messages are handled in the offscreen document, not here.
  if (msg && (msg as { target?: string }).target === 'offscreen') return false;

  (async () => {
    try {
      switch (msg?.type) {
        // ----- capture (page -> SW) -----
        case 'INIT_PROVISIONAL_RECORD': {
          const { stop } = await handleInit(sender, msg.data);
          if (stop && sender.tab?.id !== undefined) {
            chrome.tabs
              .sendMessage(sender.tab.id, { type: 'STOP_CAPTURE' }, { frameId: sender.frameId ?? 0 })
              .catch(() => {});
          }
          sendResponse({ ok: true });
          return;
        }
        case 'COMMIT_PAGE_RECORD': {
          await handleCommit(sender, msg.data);
          sendResponse({ ok: true });
          return;
        }

        // ----- search (palette -> SW) -----
        case 'SEARCH_QUERY': {
          const buckets = await bm25Stage(msg.text);
          const resp: SearchResponse = { queryId: msg.queryId, resultVersion: 1, buckets };
          sendResponse(resp);
          logEvent('query_input', msg.queryId, { len: msg.text.length });
          logEvent('results_shown', msg.queryId, { resultVersion: 1, count: buckets.reduce((n, b) => n + b.items.length, 0) });
          if (await isSemanticEnabled()) {
            void vectorStage(msg.queryId, msg.text).then(() =>
              logEvent('results_shown', msg.queryId, { resultVersion: 2 }),
            );
          }
          return;
        }
        case 'OPEN_RESULT': {
          openResult(msg.url, msg.queryId, msg.rank, msg.resultVersion);
          sendResponse({ ok: true });
          return;
        }
        case 'TELEMETRY': {
          logEvent(msg.event.type, msg.event.queryId, msg.event.payload);
          sendResponse({ ok: true });
          return;
        }
        case 'GET_INDEX_STATUS': {
          sendResponse(await indexStatus());
          return;
        }

        // ----- settings / control (options -> SW) -----
        case 'GET_SETTINGS': {
          sendResponse({
            paused: await isPaused(),
            blacklist: await getBlacklist(),
            retentionLimit: await getRetentionLimit(),
            persistGranted: await getMeta<boolean>(META_KEYS.persistGranted, false),
            semanticEnabled: await isSemanticEnabled(),
            offscreen: await offscreenState(),
            total: await recordCount(),
            pending: await queueDepth(),
          });
          return;
        }
        case 'GET_MODEL_STATUS': {
          sendResponse(await offscreenState());
          return;
        }
        case 'SET_SEMANTIC': {
          await setMeta(META_KEYS.semanticEnabled, !!msg.enabled);
          if (msg.enabled) {
            await ensureOffscreen();
            void ensureModel().then(() => drainQueue()).catch(() => {});
          }
          sendResponse({ ok: true });
          return;
        }
        case 'SET_PAUSED': {
          await setMeta(META_KEYS.paused, !!msg.paused);
          if (!msg.paused) void drainQueue();
          sendResponse({ ok: true });
          return;
        }
        case 'SET_BLACKLIST': {
          await setMeta(META_KEYS.blacklist, msg.blacklist ?? []);
          sendResponse({ ok: true });
          return;
        }
        case 'SET_RETENTION': {
          await setMeta(META_KEYS.retentionLimit, Math.max(1000, msg.limit | 0));
          sendResponse({ ok: true });
          return;
        }
        case 'CLEAR_ALL': {
          await clearAllData();
          await resetBm25();
          await closeOffscreen(); // will rebuild empty on next use
          sendResponse({ ok: true });
          return;
        }
        case 'REFRESH_CACHES': {
          // After an external import: rebuild BM25 & reload offscreen vectors.
          await resetBm25();
          await closeOffscreen();
          void drainQueue();
          sendResponse({ ok: true });
          return;
        }
        case 'GET_EVENTS': {
          sendResponse({ events: await allEvents() });
          return;
        }
        case 'CLEAR_EVENTS': {
          await clearEvents();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      console.error('[SpotRecall] message error', msg?.type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // async sendResponse
});

void bootstrap();
