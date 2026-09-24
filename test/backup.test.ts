import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers';
import { mergeRecord, exportBackup, importBackup } from '../src/storage/backup';
import { upsertProvisional, commitRecord, getRecord, recordCount } from '../src/storage/dao';
import type { PageRecord } from '../src/shared/types';

beforeEach(() => resetDb());

function rec(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: 'a',
    url: 'https://x.com/a',
    normalizedUrl: 'https://x.com/a',
    title: 't',
    domain: 'x.com',
    description: '',
    cleanText: 'body',
    contentHash: 'h',
    status: 'committed',
    firstSeen: 100,
    lastVisited: 200,
    committedVisits: 1,
    embedModelId: null,
    ...overrides,
  };
}

describe('mergeRecord idempotency (dev plan §7.3, P0-3)', () => {
  it('merging a record with itself is a no-op (idempotent)', () => {
    const r = rec({});
    const merged = mergeRecord(r, r);
    expect(merged.committedVisits).toBe(1); // NOT summed
    expect(merged).toEqual(r);
  });

  it('uses MAX/MIN, never sum', () => {
    const local = rec({ firstSeen: 100, lastVisited: 200, committedVisits: 3 });
    const incoming = rec({ firstSeen: 50, lastVisited: 300, committedVisits: 2 });
    const merged = mergeRecord(local, incoming);
    expect(merged.firstSeen).toBe(50);
    expect(merged.lastVisited).toBe(300);
    expect(merged.committedVisits).toBe(3);
  });

  it('committed status dominates provisional', () => {
    const local = rec({ status: 'provisional', committedVisits: 0 });
    const incoming = rec({ status: 'committed', committedVisits: 1, lastVisited: 50 });
    expect(mergeRecord(local, incoming).status).toBe('committed');
  });

  it('newer content wins by lastVisited', () => {
    const local = rec({ cleanText: 'old', lastVisited: 100 });
    const incoming = rec({ cleanText: 'new', lastVisited: 200 });
    expect(mergeRecord(local, incoming).cleanText).toBe('new');
  });

  it('keeps a known language when a newer legacy record has none', () => {
    const local = rec({ language: 'ja', lastVisited: 100 });
    const incoming = rec({ lastVisited: 200 });

    expect(mergeRecord(local, incoming).language).toBe('ja');
  });
});

describe('backup round-trip idempotency (dev plan §11.3-9)', () => {
  it('importing the same ZIP twice leaves records byte-identical', async () => {
    const now = 1_000_000;
    await upsertProvisional({
      id: 'a', url: 'https://x.com/a', normalizedUrl: 'https://x.com/a',
      title: 't', domain: 'x.com', description: '', now,
    });
    await commitRecord({ id: 'a', cleanText: 'body', contentHash: 'h', now, firstCommitForInstance: true });

    const before = await getRecord('a');
    const blob = await exportBackup(false, 'dev1');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const first = await importBackup(bytes);
    expect(first.imported).toBe(1);
    const afterFirst = await getRecord('a');

    await importBackup(bytes); // second import
    const afterSecond = await getRecord('a');

    expect(afterFirst).toEqual(before);
    expect(afterSecond).toEqual(before);
    expect(await recordCount()).toBe(1);
  });

  it('re-import does not inflate committedVisits', async () => {
    const now = 2_000_000;
    await upsertProvisional({
      id: 'b', url: 'https://x.com/b', normalizedUrl: 'https://x.com/b',
      title: 't', domain: 'x.com', description: '', now,
    });
    await commitRecord({ id: 'b', cleanText: 'body', contentHash: 'h', now, firstCommitForInstance: true });

    const blob = await exportBackup(false, 'dev1');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await importBackup(bytes);
    await importBackup(bytes);
    await importBackup(bytes);
    expect((await getRecord('b'))?.committedVisits).toBe(1);
  });
});
