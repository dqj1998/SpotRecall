import { describe, it, expect, beforeEach } from 'vitest';
import { decorateBookmarks } from '../src/background/search';
import { backfillRecords, getRecord, commitRecord } from '../src/storage/dao';
import type { SearchHit } from '../src/shared/types';
import { resetDb } from './helpers';

function hit(id: string, score: number): SearchHit {
  return {
    id,
    url: `https://x.com/${id}`,
    title: id,
    domain: 'x.com',
    description: '',
    snippet: '',
    lastVisited: 0,
    score,
  };
}

describe('decorateBookmarks (feature 2: bookmark flag + boost)', () => {
  it('is a no-op when nothing is bookmarked', () => {
    const hits = [hit('a', 1), hit('b', 0.9)];
    expect(decorateBookmarks(hits, new Set(), true)).toEqual(hits);
  });

  it('marks and lifts bookmarked hits above higher-scored non-bookmarks', () => {
    const hits = [hit('a', 1.0), hit('b', 0.9)];
    const out = decorateBookmarks(hits, new Set(['b']), true);
    expect(out.map((h) => h.id)).toEqual(['b', 'a']); // b boosted 0.9*1.5=1.35 > 1.0
    expect(out.find((h) => h.id === 'b')?.isBookmark).toBe(true);
    expect(out.find((h) => h.id === 'a')?.isBookmark).toBeUndefined();
  });

  it('browse mode (boost=false) marks without reordering', () => {
    const hits = [hit('a', 1.0), hit('b', 0.9)];
    const out = decorateBookmarks(hits, new Set(['b']), false);
    expect(out.map((h) => h.id)).toEqual(['a', 'b']);
    expect(out.find((h) => h.id === 'b')?.isBookmark).toBe(true);
  });
});

describe('backfillRecords (feature 1: metadata seeding)', () => {
  beforeEach(() => resetDb());

  it('creates provisional metadata records (searchable, no content)', async () => {
    const created = await backfillRecords([
      { id: 'r1', url: 'https://a.com', normalizedUrl: 'https://a.com', title: 'A', domain: 'a.com', ts: 100 },
    ]);
    expect(created).toBe(1);
    const rec = await getRecord('r1');
    expect(rec?.status).toBe('provisional');
    expect(rec?.title).toBe('A');
    expect(rec?.cleanText).toBe('');
    expect(rec?.committedVisits).toBe(0);
  });

  it('never overwrites an already-visited (committed) record', async () => {
    await backfillRecords([
      { id: 'r1', url: 'https://a.com', normalizedUrl: 'https://a.com', title: 'A', domain: 'a.com', ts: 100 },
    ]);
    await commitRecord({
      id: 'r1',
      cleanText: 'real captured content',
      contentHash: 'h1',
      now: 5000,
      firstCommitForInstance: true,
    });
    // Re-run backfill with a different title/ts — must be ignored.
    const created = await backfillRecords([
      { id: 'r1', url: 'https://a.com', normalizedUrl: 'https://a.com', title: 'STALE', domain: 'a.com', ts: 999 },
    ]);
    expect(created).toBe(0);
    const rec = await getRecord('r1');
    expect(rec?.status).toBe('committed');
    expect(rec?.cleanText).toBe('real captured content');
    expect(rec?.lastVisited).toBe(5000); // not clobbered to 999
  });
});
