import { describe, it, expect } from 'vitest';
import { dedupeByContent } from '../src/background/search';

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
