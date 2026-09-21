// Offscreen document: persistent embedding host. Heavy inference lives here
// (SW is ephemeral). The model is loaded lazily only when semantic search is
// enabled (ENSURE_MODEL) — first run downloads & caches it, then works offline.
// Vectors cache in memory; IndexedDB (written by the SW) is the source of truth.

import { loadModel, embedPassages, embedQuery, currentBackend, isModelLoaded, type LoadProgress } from './embedder';
import { expandQuery } from './translate';
import { VectorStore } from './vectorstore';
import { quantizeInt8, l2normalize } from '@shared/quantize';
import { allVectors } from '@storage/dao';
import { MODEL_ID } from '@shared/protocol';
import type {
  OffscreenRequest,
  EmbedBatchResult,
  VectorSearchResult,
  OffscreenState,
  ModelState,
} from '@shared/protocol';

const store = new VectorStore();
let state: ModelState = 'IDLE';
let progress = 0;
let currentFile = '';
let initError = '';
let ensurePromise: Promise<void> | null = null;

// Byte-weighted, monotonic download progress across all model files (config,
// tokenizer, onnx…). Per-file 0..100 events would otherwise jump around.
const dlBytes = new Map<string, { loaded: number; total: number }>();

function onProgress(p: LoadProgress): void {
  state = 'DOWNLOADING';
  if (p.file) currentFile = p.file;
  if (p.file && typeof p.total === 'number' && p.total > 0) {
    const loaded = p.status === 'done' ? p.total : (p.loaded ?? 0);
    dlBytes.set(p.file, { loaded, total: p.total });
  }
  let loaded = 0;
  let total = 0;
  for (const b of dlBytes.values()) {
    loaded += b.loaded;
    total += b.total;
  }
  const overall = total > 0 ? Math.round((loaded / total) * 100) : progress;
  progress = Math.max(progress, Math.min(overall, 100)); // never go backwards
}

/** Load model (download+cache on first run) then restore the vector buffer. */
async function ensureModel(): Promise<void> {
  if (state === 'READY') return;
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    try {
      if (!isModelLoaded()) {
        state = 'DOWNLOADING';
        await loadModel(onProgress);
      }
      state = 'RESTORING_VECTORS';
      store.loadAll(await allVectors());
      state = 'READY';
    } catch (e) {
      state = 'ERROR';
      initError = e instanceof Error ? e.message : String(e);
      ensurePromise = null; // allow retry
      throw e;
    }
  })();
  return ensurePromise;
}

function snapshot(): OffscreenState {
  const res: OffscreenState = { ok: true, state, backend: currentBackend(), vectorCount: store.size };
  if (state === 'DOWNLOADING') {
    res.progress = progress;
    res.currentFile = currentFile;
  }
  if (initError) res.error = initError;
  return res;
}

chrome.runtime.onMessage.addListener(
  (msg: OffscreenRequest, _sender, sendResponse): boolean => {
    if (!msg || (msg as { target?: string }).target !== 'offscreen') return false;

    (async () => {
      switch (msg.type) {
        case 'PING':
          sendResponse(snapshot());
          return;

        case 'ENSURE_MODEL': {
          try {
            await ensureModel();
            sendResponse(snapshot());
          } catch {
            sendResponse(snapshot());
          }
          return;
        }

        case 'EMBED_BATCH': {
          if (state !== 'READY') {
            // Not enabled/ready yet — leave items queued for later.
            sendResponse({ ok: false, error: 'model not ready', vectors: [] } satisfies EmbedBatchResult);
            return;
          }
          try {
            const vecs = await embedPassages(msg.items.map((i) => i.text));
            const out: EmbedBatchResult['vectors'] = [];
            for (let i = 0; i < vecs.length; i++) {
              const { q, scale } = quantizeInt8(vecs[i]);
              const id = msg.items[i].id;
              store.upsert(id, q, scale);
              out.push({ id, q: Array.from(q), scale });
            }
            sendResponse({ ok: true, vectors: out } satisfies EmbedBatchResult);
          } catch (e) {
            sendResponse({ ok: false, error: String(e), vectors: [] } satisfies EmbedBatchResult);
          }
          return;
        }

        case 'VECTOR_SEARCH': {
          if (state !== 'READY') {
            sendResponse({ ok: false, error: 'model not ready', results: [] } satisfies VectorSearchResult);
            return;
          }
          try {
            const raw = await embedQuery(msg.text);
            const results = store.search(l2normalize(raw), msg.topK);
            sendResponse({ ok: true, results } satisfies VectorSearchResult);
          } catch (e) {
            sendResponse({ ok: false, error: String(e), results: [] } satisfies VectorSearchResult);
          }
          return;
        }

        case 'VECTOR_REMOVE':
          store.remove(msg.ids);
          sendResponse({ ok: true });
          return;

        case 'EXPAND_QUERY': {
          try {
            const variants = await expandQuery(msg.text, msg.targets);
            sendResponse({ ok: true, variants });
          } catch {
            sendResponse({ ok: true, variants: [msg.text] });
          }
          return;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    })();

    return true; // async sendResponse
  },
);

console.log('[SpotRecall] offscreen booted, model', MODEL_ID);
