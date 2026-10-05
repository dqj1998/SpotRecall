import { describe, it, expect } from 'vitest';
import { dedupeByContent, trimVectorHits } from '@search/fusion';

describe('dedupeByContent (query-time content dedup)', () => {
  it('collapses entries sharing a non-empty contentHash, keeping the first', () => {
    const items = [
      { id: 'a', contentHash: 'H1' },
      { id: 'b', contentHash: 'H1' }, // dup of a
      { id: 'c', contentHash: 'H2' },
      { id: 'd', contentHash: 'H1' }, // dup of a
    ];
    expect(dedupeByContent(items, (x) => x.contentHash).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('never collapses empty contentHash (provisional / uncaptured)', () => {
    const items = [
      { id: 'a', contentHash: '' },
      { id: 'b', contentHash: '' },
      { id: 'c', contentHash: '' },
    ];
    expect(dedupeByContent(items, (x) => x.contentHash).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves order and keeps the best-ranked representative', () => {
    // Simulates a ranked list: the highest-ranked identical-content hit survives.
    const ranked = [
      { id: 'top', contentHash: 'DUP' },
      { id: 'mid', contentHash: 'UNIQUE' },
      { id: 'low', contentHash: 'DUP' },
    ];
    expect(dedupeByContent(ranked, (x) => x.contentHash).map((x) => x.id)).toEqual(['top', 'mid']);
  });
});

describe('trimVectorHits (drop weak vector matches)', () => {
  it('keeps only hits within the margin of the top score', () => {
    const res = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.87 },
      { id: 'c', score: 0.8 },
    ];
    expect(trimVectorHits(res).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(trimVectorHits([])).toEqual([]);
  });
});
