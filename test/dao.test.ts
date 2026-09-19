import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers';
import {
  upsertProvisional,
  commitRecord,
  gcProvisional,
  getRecord,
  persistVectorsAndDequeue,
  dequeuePeek,
  enforceRetention,
  recordCount,
  allVectors,
  pendingCount,
} from '../src/storage/dao';

beforeEach(() => resetDb());

const base = (id: string, url: string, now: number) => ({
  id,
  url,
  normalizedUrl: url,
  title: `t-${id}`,
  domain: 'x.com',
  description: '',
  now,
});

describe('capture lifecycle DAO (dev plan §3, §4)', () => {
  it('provisional -> committed -> vectorized pipeline, atomic dequeue', async () => {
    const now = Date.now();
    await upsertProvisional(base('a', 'https://x.com/a', now));
    let rec = await getRecord('a');
    expect(rec?.status).toBe('provisional');
    expect(rec?.committedVisits).toBe(0);

    const res = await commitRecord({
      id: 'a',
      cleanText: 'hello world',
      contentHash: 'h1',
      now: now + 1,
      firstCommitForInstance: true,
    });
    expect(res?.contentChanged).toBe(true);
    rec = await getRecord('a');
    expect(rec?.status).toBe('committed');
    expect(rec?.committedVisits).toBe(1);
    expect(await dequeuePeek(10)).toEqual(['a']);

    await persistVectorsAndDequeue([{ id: 'a', dim: 2, q: [1, 2], scale: 0.1, modelId: 'm' }]);
    expect(await pendingCount()).toBe(0);
    expect((await allVectors())).toHaveLength(1);
    expect((await getRecord('a'))?.embedModelId).toBe('m');
  });

  it('re-commit with same contentHash does not re-enqueue', async () => {
    const now = Date.now();
    await upsertProvisional(base('a', 'https://x.com/a', now));
    await commitRecord({ id: 'a', cleanText: 't', contentHash: 'h', now, firstCommitForInstance: true });
    await persistVectorsAndDequeue([{ id: 'a', dim: 1, q: [1], scale: 1, modelId: 'm' }]);
    const res = await commitRecord({ id: 'a', cleanText: 't', contentHash: 'h', now: now + 1, firstCommitForInstance: false });
    expect(res?.contentChanged).toBe(false);
    expect(await pendingCount()).toBe(0);
  });

  it('GC deletes never-committed provisional and cascades', async () => {
    const now = Date.now();
    await upsertProvisional(base('p', 'https://x.com/p', now));
    expect(await gcProvisional('p')).toBe(true);
    expect(await getRecord('p')).toBeUndefined();
  });

  it('GC refuses to delete a committed record', async () => {
    const now = Date.now();
    await upsertProvisional(base('c', 'https://x.com/c', now));
    await commitRecord({ id: 'c', cleanText: 't', contentHash: 'h', now, firstCommitForInstance: true });
    expect(await gcProvisional('c')).toBe(false);
    expect(await getRecord('c')).toBeDefined();
  });

  it('upsert of same id keeps status/content, bumps lastVisited', async () => {
    const now = Date.now();
    await upsertProvisional(base('a', 'https://x.com/a', now));
    await commitRecord({ id: 'a', cleanText: 'body', contentHash: 'h', now, firstCommitForInstance: true });
    await upsertProvisional(base('a', 'https://x.com/a', now + 5000));
    const rec = await getRecord('a');
    expect(rec?.status).toBe('committed');
    expect(rec?.cleanText).toBe('body');
    expect(rec?.lastVisited).toBe(now + 5000);
  });

  it('LRU retention removes oldest beyond limit, cascading vectors', async () => {
    for (let i = 0; i < 5; i++) {
      await upsertProvisional(base(`r${i}`, `https://x.com/${i}`, 1000 + i));
      await persistVectorsAndDequeue([{ id: `r${i}`, dim: 1, q: [1], scale: 1, modelId: 'm' }]);
    }
    const removed = await enforceRetention(3);
    expect(removed.sort()).toEqual(['r0', 'r1']);
    expect(await recordCount()).toBe(3);
    expect((await allVectors()).map((v) => v.id).sort()).toEqual(['r2', 'r3', 'r4']);
  });
});
