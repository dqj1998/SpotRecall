// Data access. The SW is the only writer. Cross-store writes that must stay
// consistent (embed-persist, GC, LRU) run inside a single readwrite transaction.

import { getDb } from './db';
import type {
  PageRecord,
  VectorRecord,
  EventRecord,
} from '@shared/types';
import { META_KEYS } from '@shared/types';

// ---------- meta ----------
export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const row = await db.get('meta', key);
  return row ? (row.value as T) : fallback;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('meta', { key, value });
}

// ---------- records ----------
export async function getRecord(id: string): Promise<PageRecord | undefined> {
  const db = await getDb();
  return db.get('records', id);
}

export async function allRecords(): Promise<PageRecord[]> {
  const db = await getDb();
  return db.getAll('records');
}

export async function recordCount(): Promise<number> {
  const db = await getDb();
  return db.count('records');
}

export async function pendingCount(): Promise<number> {
  const db = await getDb();
  return db.count('pendingEmbed');
}

/**
 * Stage 1: upsert a provisional record. If new -> committedVisits=0,
 * status='provisional'. Existing records keep their status/content and only
 * bump lastVisited/url/title.
 */
export async function upsertProvisional(input: {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string;
  domain: string;
  description: string;
  now: number;
}): Promise<PageRecord> {
  const db = await getDb();
  const tx = db.transaction('records', 'readwrite');
  const existing = await tx.store.get(input.id);
  let rec: PageRecord;
  if (existing) {
    rec = {
      ...existing,
      url: input.url,
      title: input.title || existing.title,
      description: input.description || existing.description,
      lastVisited: input.now,
    };
  } else {
    rec = {
      id: input.id,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      title: input.title,
      domain: input.domain,
      description: input.description,
      cleanText: '',
      contentHash: '',
      status: 'provisional',
      firstSeen: input.now,
      lastVisited: input.now,
      committedVisits: 0,
      embedModelId: null,
    };
  }
  await tx.store.put(rec);
  await tx.done;
  return rec;
}

/**
 * Stage 3: commit. Returns { record, contentChanged }. Enqueues re-embed only
 * when contentHash changed. `firstCommitForInstance` controls committedVisits++.
 */
export async function commitRecord(input: {
  id: string;
  cleanText: string;
  contentHash: string;
  now: number;
  firstCommitForInstance: boolean;
}): Promise<{ record: PageRecord; contentChanged: boolean } | null> {
  const db = await getDb();
  const tx = db.transaction(['records', 'pendingEmbed'], 'readwrite');
  const rec = await tx.objectStore('records').get(input.id);
  if (!rec) {
    await tx.done;
    return null;
  }
  const contentChanged = rec.contentHash !== input.contentHash;
  const updated: PageRecord = {
    ...rec,
    status: 'committed',
    cleanText: input.cleanText,
    contentHash: input.contentHash,
    lastVisited: input.now,
    committedVisits: rec.committedVisits + (input.firstCommitForInstance ? 1 : 0),
  };
  await tx.objectStore('records').put(updated);
  if (contentChanged) {
    updated.embedModelId = null;
    await tx.objectStore('records').put(updated);
    await tx.objectStore('pendingEmbed').put({ id: input.id, enqueuedAt: input.now });
  }
  await tx.done;
  return { record: updated, contentChanged };
}

/**
 * Stage 4 GC: delete a record only if still provisional and never committed.
 * Caller guarantees refCount==0. Cascades to vectors + pendingEmbed atomically.
 * Returns true if deleted.
 */
export async function gcProvisional(id: string): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(['records', 'vectors', 'pendingEmbed'], 'readwrite');
  const rec = await tx.objectStore('records').get(id);
  let deleted = false;
  if (rec && rec.status === 'provisional' && rec.committedVisits === 0) {
    await tx.objectStore('records').delete(id);
    await tx.objectStore('vectors').delete(id);
    await tx.objectStore('pendingEmbed').delete(id);
    deleted = true;
  }
  await tx.done;
  return deleted;
}

// ---------- embedding pipeline ----------
export async function dequeuePeek(limit: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('pendingEmbed', 'enqueuedAt', undefined, limit);
  return rows.map((r) => r.id);
}

/**
 * Persist computed vectors AND dequeue AND stamp embedModelId — atomically.
 * If the SW crashes before this commits, ids remain queued and are replayed.
 */
export async function persistVectorsAndDequeue(
  vectors: VectorRecord[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['records', 'vectors', 'pendingEmbed'], 'readwrite');
  for (const v of vectors) {
    await tx.objectStore('vectors').put(v);
    await tx.objectStore('pendingEmbed').delete(v.id);
    const rec = await tx.objectStore('records').get(v.id);
    if (rec) {
      rec.embedModelId = v.modelId;
      await tx.objectStore('records').put(rec);
    }
  }
  await tx.done;
}

export async function allVectors(): Promise<VectorRecord[]> {
  const db = await getDb();
  return db.getAll('vectors');
}

/** Drop queue entries with no embeddable record (deleted / empty text). */
export async function removePending(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('pendingEmbed', 'readwrite');
  for (const id of ids) await tx.store.delete(id);
  await tx.done;
}

// ---------- LRU retention ----------
/**
 * Delete the oldest records (by lastVisited) beyond `limit`, cascading to
 * vectors + queue. Returns the removed ids (so the offscreen buffer can drop them).
 */
export async function enforceRetention(limit: number): Promise<string[]> {
  const db = await getDb();
  const total = await db.count('records');
  if (total <= limit) return [];
  const overflow = total - limit;
  const tx = db.transaction(['records', 'vectors', 'pendingEmbed'], 'readwrite');
  const removed: string[] = [];
  let cursor = await tx.objectStore('records').index('lastVisited').openCursor();
  while (cursor && removed.length < overflow) {
    const id = cursor.value.id;
    removed.push(id);
    await tx.objectStore('records').delete(id);
    await tx.objectStore('vectors').delete(id);
    await tx.objectStore('pendingEmbed').delete(id);
    cursor = await cursor.continue();
  }
  await tx.done;
  return removed;
}

/**
 * Seed metadata-only records (title + URL, no body text) for pages the user
 * already has — bookmarks and open tabs — so they are keyword-searchable from
 * first run. Inserts ONLY when absent: an already-visited/committed record is
 * never touched (so its content and real lastVisited are preserved). No network,
 * no embedding (empty cleanText is not queued). Returns count of records created.
 */
export async function backfillRecords(
  items: {
    id: string;
    url: string;
    normalizedUrl: string;
    title: string;
    domain: string;
    ts: number;
  }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const db = await getDb();
  const tx = db.transaction('records', 'readwrite');
  let created = 0;
  for (const it of items) {
    if (await tx.store.get(it.id)) continue; // never overwrite an existing record
    await tx.store.put({
      id: it.id,
      url: it.url,
      normalizedUrl: it.normalizedUrl,
      title: it.title,
      domain: it.domain,
      description: '',
      cleanText: '',
      contentHash: '',
      status: 'provisional',
      firstSeen: it.ts,
      lastVisited: it.ts,
      committedVisits: 0,
      embedModelId: null,
    });
    created++;
  }
  await tx.done;
  return created;
}

/** Hard-delete records (any status) + their vectors + queue entries, atomically. */
export async function deleteRecordsCascade(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const tx = db.transaction(['records', 'vectors', 'pendingEmbed'], 'readwrite');
  for (const id of ids) {
    await tx.objectStore('records').delete(id);
    await tx.objectStore('vectors').delete(id);
    await tx.objectStore('pendingEmbed').delete(id);
  }
  await tx.done;
}

// ---------- events ----------
export async function addEvent(ev: EventRecord): Promise<void> {
  const db = await getDb();
  await db.add('events', ev);
}
export async function allEvents(): Promise<EventRecord[]> {
  const db = await getDb();
  return db.getAll('events');
}
export async function clearEvents(): Promise<void> {
  const db = await getDb();
  await db.clear('events');
}

// ---------- danger: wipe everything ----------
export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['records', 'vectors', 'pendingEmbed', 'events'], 'readwrite');
  await tx.objectStore('records').clear();
  await tx.objectStore('vectors').clear();
  await tx.objectStore('pendingEmbed').clear();
  await tx.objectStore('events').clear();
  await tx.done;
}

// ---------- config convenience ----------
export async function isPaused(): Promise<boolean> {
  return getMeta<boolean>(META_KEYS.paused, false);
}
export async function getBlacklist(): Promise<string[]> {
  return getMeta<string[]>(META_KEYS.blacklist, []);
}
export async function getRetentionLimit(): Promise<number> {
  return getMeta<number>(META_KEYS.retentionLimit, 100_000);
}
export async function isSemanticEnabled(): Promise<boolean> {
  // Semantic search is on by default: the model auto-downloads on first run.
  return getMeta<boolean>(META_KEYS.semanticEnabled, true);
}
