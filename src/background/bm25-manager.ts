// BM25 index singleton for the SW. Snapshot is a rebuildable CACHE stored in
// meta; the records store is the source of truth.

import { Bm25Index } from '@search/bm25';
import { allRecords, getMeta, setMeta, getRecord } from '@storage/dao';
import type { PageRecord } from '@shared/types';

const SNAPSHOT_KEY = 'minisearch_snapshot';
let index: Bm25Index | null = null;
let ready: Promise<Bm25Index> | null = null;
let dirtyCount = 0;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

async function build(): Promise<Bm25Index> {
  const snap = await getMeta<string | null>(SNAPSHOT_KEY, null);
  if (snap) {
    try {
      return Bm25Index.fromSnapshot(snap);
    } catch {
      // Corrupt snapshot -> rebuild from source of truth.
    }
  }
  const records = (await allRecords()).filter((r) => r.status === 'committed' || r.cleanText || r.title);
  return Bm25Index.fromRecords(records);
}

export async function getBm25(): Promise<Bm25Index> {
  if (index) return index;
  if (!ready) ready = build().then((idx) => (index = idx));
  return ready;
}

function scheduleSnapshot(): void {
  dirtyCount++;
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    if (!index) return;
    dirtyCount = 0;
    await setMeta(SNAPSHOT_KEY, index.serialize());
  }, 5000);
}

export async function bm25Upsert(record: PageRecord): Promise<void> {
  const idx = await getBm25();
  idx.upsert(record);
  scheduleSnapshot();
}

export async function bm25Remove(id: string): Promise<void> {
  const idx = await getBm25();
  idx.remove(id);
  scheduleSnapshot();
}

export async function bm25UpsertById(id: string): Promise<void> {
  const rec = await getRecord(id);
  if (rec) await bm25Upsert(rec);
}

/** Force a rebuild from the source of truth (after import / clear). */
export async function resetBm25(): Promise<void> {
  index = null;
  ready = null;
  await setMeta(SNAPSHOT_KEY, null);
  await getBm25();
}
