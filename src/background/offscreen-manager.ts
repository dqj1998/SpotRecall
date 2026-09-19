// Reentrant offscreen lifecycle. keepalive is best-effort only; correctness
// relies on IndexedDB + queue replay, never on the offscreen staying alive.

import type {
  OffscreenRequest,
  EmbedBatchResult,
  VectorSearchResult,
  OffscreenState,
} from '@shared/protocol';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (creating) return creating; // merge concurrent creations
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Local embedding inference for semantic recall.',
    })
    .catch((e) => {
      // Another caller may have created it in the race; tolerate.
      if (!String(e).includes('Only a single offscreen')) throw e;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

async function call<T>(msg: OffscreenRequest): Promise<T> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function embedBatch(items: { id: string; text: string }[]): Promise<EmbedBatchResult> {
  return call<EmbedBatchResult>({ target: 'offscreen', type: 'EMBED_BATCH', items });
}

export function vectorSearch(text: string, topK: number): Promise<VectorSearchResult> {
  return call<VectorSearchResult>({ target: 'offscreen', type: 'VECTOR_SEARCH', text, topK });
}

export function vectorRemove(ids: string[]): Promise<{ ok: boolean }> {
  if (ids.length === 0) return Promise.resolve({ ok: true });
  return call<{ ok: boolean }>({ target: 'offscreen', type: 'VECTOR_REMOVE', ids });
}

/** Trigger model load (first-run download + cache, then offline). */
export function ensureModel(): Promise<OffscreenState> {
  return call<OffscreenState>({ target: 'offscreen', type: 'ENSURE_MODEL' });
}

export async function closeOffscreen(): Promise<void> {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

export async function offscreenState(): Promise<OffscreenState | null> {
  if (!(await hasOffscreen())) return null;
  try {
    return await call<OffscreenState>({ target: 'offscreen', type: 'PING' });
  } catch {
    return null;
  }
}
