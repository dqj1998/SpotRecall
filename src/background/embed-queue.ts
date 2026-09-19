// Low-priority embedding drainer. Tasks are pulled from the persistent queue and
// only removed inside the atomic persist transaction, so a crash replays them.

import {
  dequeuePeek,
  getRecord,
  persistVectorsAndDequeue,
  removePending,
  isPaused,
  isSemanticEnabled,
  pendingCount,
} from '@storage/dao';
import { embedBatch } from './offscreen-manager';
import { MODEL_ID, MODEL_DIM } from '@shared/protocol';
import type { VectorRecord } from '@shared/types';

const BATCH = 4;
let draining = false;

const idle = () => new Promise<void>((r) => setTimeout(r, 0));

export async function drainQueue(): Promise<void> {
  if (draining) return;
  // Semantic search is opt-in; until enabled (model downloaded) we keep committed
  // pages queued and do no embedding work.
  if (!(await isSemanticEnabled())) return;
  draining = true;
  try {
    for (;;) {
      if (await isPaused()) break;
      const ids = await dequeuePeek(BATCH);
      if (ids.length === 0) break;

      const recs = await Promise.all(ids.map((id) => getRecord(id)));
      const items: { id: string; text: string }[] = [];
      const stale: string[] = [];
      ids.forEach((id, i) => {
        const r = recs[i];
        if (r && r.cleanText) items.push({ id, text: r.cleanText });
        else stale.push(id);
      });
      if (stale.length) await removePending(stale);
      if (items.length === 0) continue;

      const res = await embedBatch(items);
      if (!res.ok) break; // transient failure; retry on next trigger

      const vectors: VectorRecord[] = res.vectors.map((v) => ({
        id: v.id,
        dim: MODEL_DIM,
        q: v.q,
        scale: v.scale,
        modelId: MODEL_ID,
      }));
      await persistVectorsAndDequeue(vectors);
      await idle(); // yield between batches
    }
  } catch (e) {
    console.warn('[SpotRecall] drainQueue error', e);
  } finally {
    draining = false;
  }
}

export async function queueDepth(): Promise<number> {
  return pendingCount();
}
