// Weighted Reciprocal Rank Fusion (dev plan §5.3). Pure & unit-tested.

export interface Ranked {
  id: string;
}

export interface RrfOptions {
  k?: number;
  bm25Weight?: number;
  vectorWeight?: number;
}

/**
 * Fuse two ranked lists by weighted reciprocal rank. BM25 is weighted higher
 * by default to favor exact matches (error codes, versions, precise URLs).
 * Returns fused ids with scores, highest first.
 */
export function reciprocalRankFusion<T extends Ranked>(
  bm25: T[],
  vec: T[],
  { k = 60, bm25Weight = 1.2, vectorWeight = 1.0 }: RrfOptions = {},
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  const fuse = (list: T[], w: number) => {
    list.forEach((item, i) => {
      const prev = scores.get(item.id) ?? 0;
      scores.set(item.id, prev + w * (1 / (k + i + 1)));
    });
  };
  fuse(bm25, bm25Weight);
  fuse(vec, vectorWeight);
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
