// Backup export/import. Semantics: CUMULATIVE SNAPSHOT.
// Merge is field-wise MAX/MIN (never summed) => re-importing the same file is
// idempotent (dev plan §7.3). Container: single ZIP.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { getDb } from './db';
import { allRecords, allVectors, setMeta } from './dao';
import type { PageRecord, VectorRecord } from '@shared/types';
import { META_KEYS } from '@shared/types';
import { MODEL_ID, MODEL_DIM } from '@shared/protocol';

export const BACKUP_SCHEMA_VERSION = 1;
const MAX_RECORDS = 5_000_000;

export interface BackupMeta {
  backupSchemaVersion: number;
  modelId: string;
  modelDim: number;
  exportId: string;
  sourceDeviceId: string;
  exportedAt: number;
  recordCount: number;
  includesVectors: boolean;
}

/**
 * Idempotent field-wise merge of two records for the same id.
 * MAX/MIN only — committedVisits is MAX (never summed) so re-import is a no-op.
 */
export function mergeRecord(local: PageRecord | undefined, incoming: PageRecord): PageRecord {
  if (!local) return { ...incoming };
  const newer = incoming.lastVisited > local.lastVisited ? incoming : local;
  return {
    ...newer,
    id: local.id,
    firstSeen: Math.min(local.firstSeen, incoming.firstSeen),
    lastVisited: Math.max(local.lastVisited, incoming.lastVisited),
    committedVisits: Math.max(local.committedVisits, incoming.committedVisits),
    language: newer.language ?? local.language ?? incoming.language,
    // status: committed dominates provisional
    status: local.status === 'committed' || incoming.status === 'committed' ? 'committed' : newer.status,
  };
}

export async function exportBackup(includeVectors = false, deviceId = 'unknown'): Promise<Blob> {
  const records = await allRecords();
  const meta: BackupMeta = {
    backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    modelId: MODEL_ID,
    modelDim: MODEL_DIM,
    exportId: crypto.randomUUID(),
    sourceDeviceId: deviceId,
    exportedAt: Date.now(),
    recordCount: records.length,
    includesVectors: includeVectors,
  };
  const files: Record<string, Uint8Array> = {
    'meta.json': strToU8(JSON.stringify(meta, null, 2)),
    'records.ndjson': strToU8(records.map((r) => JSON.stringify(r)).join('\n')),
  };
  if (includeVectors) {
    const vectors = await allVectors();
    files['vectors.ndjson'] = strToU8(vectors.map((v) => JSON.stringify(v)).join('\n'));
  }
  const zipped = zipSync(files, { level: 6 });
  // Copy into a fresh ArrayBuffer to satisfy BlobPart typing across TS lib versions.
  const buf = zipped.slice();
  return new Blob([buf], { type: 'application/zip' });
}

function parseNdjson<T>(text: string): T[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export interface ImportResult {
  imported: number;
  requeued: number;
  modelMismatch: boolean;
}

/**
 * Atomic import: parse & validate fully in memory, then apply in ONE transaction.
 * On any parse/validation error nothing is written. Model mismatch => import
 * records only and requeue everything for re-embedding.
 */
export async function importBackup(fileBytes: Uint8Array): Promise<ImportResult> {
  const unzipped = unzipSync(fileBytes);
  const metaRaw = unzipped['meta.json'];
  const recRaw = unzipped['records.ndjson'];
  if (!metaRaw || !recRaw) throw new Error('backup missing meta.json or records.ndjson');

  const meta = JSON.parse(strFromU8(metaRaw)) as BackupMeta;
  if (meta.backupSchemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`unsupported backup schema ${meta.backupSchemaVersion}`);
  }
  const incoming = parseNdjson<PageRecord>(strFromU8(recRaw));
  if (incoming.length > MAX_RECORDS) throw new Error('backup too large');

  const modelMismatch = meta.modelId !== MODEL_ID || meta.modelDim !== MODEL_DIM;
  const incomingVectors: VectorRecord[] =
    !modelMismatch && meta.includesVectors && unzipped['vectors.ndjson']
      ? parseNdjson<VectorRecord>(strFromU8(unzipped['vectors.ndjson']))
      : [];
  const vectorIds = new Set(incomingVectors.map((v) => v.id));

  const db = await getDb();
  const tx = db.transaction(['records', 'vectors', 'pendingEmbed'], 'readwrite');
  let requeued = 0;
  for (const inc of incoming) {
    const local = await tx.objectStore('records').get(inc.id);
    const merged = mergeRecord(local, inc);
    // Requeue when we have no usable vector for this record.
    const hasVector = vectorIds.has(inc.id);
    if (!hasVector && merged.status === 'committed' && merged.cleanText) {
      merged.embedModelId = null;
      await tx.objectStore('pendingEmbed').put({ id: merged.id, enqueuedAt: Date.now() });
      requeued++;
    }
    await tx.objectStore('records').put(merged);
  }
  for (const v of incomingVectors) {
    await tx.objectStore('vectors').put(v);
  }
  await tx.done;

  await setMeta(META_KEYS.modelId, MODEL_ID);
  await setMeta(META_KEYS.modelDim, MODEL_DIM);
  return { imported: incoming.length, requeued, modelMismatch };
}
