import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, fuseRanked } from '@search/rrf';

describe('reciprocalRankFusion', () => {
  it('ranks an item appearing high in both lists first', () => {
    const bm25 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const vec = [{ id: 'a' }, { id: 'x' }, { id: 'y' }];
    const fused = reciprocalRankFusion(bm25, vec);
    expect(fused[0].id).toBe('a');
  });

  it('includes items present in only one list', () => {
    const fused = reciprocalRankFusion([{ id: 'a' }], [{ id: 'b' }]);
    const ids = fused.map((f) => f.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('applies bm25 weight advantage on exact-match style ties', () => {
    // Same rank position in each list; bm25Weight>vectorWeight should favor the bm25 top.
    const bm25 = [{ id: 'exact' }, { id: 'z' }];
    const vec = [{ id: 'fuzzy' }, { id: 'exact' }];
    const fused = reciprocalRankFusion(bm25, vec, { bm25Weight: 1.5, vectorWeight: 1.0 });
    expect(fused[0].id).toBe('exact');
  });

  it('is deterministic and sorted descending by score', () => {
    const fused = reciprocalRankFusion([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });
});

describe('fuseRanked (N lists, cross-variant fusion)', () => {
  it('a doc hit by multiple variants outranks a single-list top hit', () => {
    const fused = fuseRanked([
      { ids: ['a', 'shared'], weight: 1 }, // variant1 bm25
      { ids: ['b', 'shared'], weight: 1 }, // variant2 bm25
      { ids: ['shared', 'c'], weight: 1 }, // vector
    ]);
    expect(fused[0].id).toBe('shared');
  });

  it('respects per-list weights', () => {
    const fused = fuseRanked([
      { ids: ['x'], weight: 2 },
      { ids: ['y'], weight: 1 },
    ]);
    expect(fused[0].id).toBe('x');
  });

  it('empty lists yield empty result', () => {
    expect(fuseRanked([])).toEqual([]);
  });
});
