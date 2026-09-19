import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PageRecord, VectorRecord, PendingEmbed, EventRecord } from '@shared/types';

export const DB_NAME = 'spotrecall';
export const SCHEMA_VERSION = 1;

export interface SpotRecallDB extends DBSchema {
  records: {
    key: string;
    value: PageRecord;
    indexes: { lastVisited: number; domain: string; status: string; contentHash: string };
  };
  vectors: {
    key: string;
    value: VectorRecord;
  };
  pendingEmbed: {
    key: string;
    value: PendingEmbed;
    indexes: { enqueuedAt: number };
  };
  events: {
    key: number;
    value: EventRecord;
    indexes: { ts: number; type: string };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

let dbPromise: Promise<IDBPDatabase<SpotRecallDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<SpotRecallDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SpotRecallDB>(DB_NAME, SCHEMA_VERSION, {
      upgrade(db, oldVersion) {
        // Versioned migrations run in order; v0 -> v1 creates the base schema.
        if (oldVersion < 1) {
          const records = db.createObjectStore('records', { keyPath: 'id' });
          records.createIndex('lastVisited', 'lastVisited');
          records.createIndex('domain', 'domain');
          records.createIndex('status', 'status');
          records.createIndex('contentHash', 'contentHash');

          db.createObjectStore('vectors', { keyPath: 'id' });

          const pending = db.createObjectStore('pendingEmbed', { keyPath: 'id' });
          pending.createIndex('enqueuedAt', 'enqueuedAt');

          const events = db.createObjectStore('events', { keyPath: 'seq', autoIncrement: true });
          events.createIndex('ts', 'ts');
          events.createIndex('type', 'type');

          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/** Test-only: close the connection and forget the cached promise. */
export async function __closeDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}
