import { describe, it, expect } from 'vitest';
import { quantizeInt8, scoreInt8, l2normalize, cosine } from '@shared/quantize';

// Deterministic PRNG for reproducible synthetic vectors.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randVec(rng: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng() * 2 - 1;
  return v;
}

function topK(scores: { id: number; s: number }[], k: number): number[] {
  return [...scores].sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.id);
}

describe('int8 quantization scoring contract (dev plan §4.3)', () => {
  it('zero_point is 0: quantizing zero vector stays zero', () => {
    const { q } = quantizeInt8(new Float32Array(8));
    expect([...q].every((x) => x === 0)).toBe(true);
  });

  it('int8 ranking matches float32 cosine baseline within thresholds', () => {
    const rng = mulberry32(42);
    const dim = 64;
    const N = 400;
    const docs = Array.from({ length: N }, () => randVec(rng, dim));
    const quantized = docs.map((d) => quantizeInt8(d));

    const QUERIES = 50;
    const K = 10;
    let recallSum = 0;
    let mrrInt8 = 0;
    let mrrFloat = 0;

    for (let qi = 0; qi < QUERIES; qi++) {
      const query = randVec(rng, dim);
      const uq = l2normalize(query);

      const floatScores = docs.map((d, id) => ({ id, s: cosine(d, query) }));
      const int8Scores = quantized.map((qd, id) => ({ id, s: scoreInt8(qd.q, qd.scale, uq) }));

      const floatTop = topK(floatScores, K);
      const int8Top = topK(int8Scores, K);

      const overlap = int8Top.filter((id) => floatTop.includes(id)).length;
      recallSum += overlap / K;

      const gold = floatTop[0];
      const int8Rank = topK(int8Scores, N).indexOf(gold);
      mrrInt8 += 1 / (int8Rank + 1);
      mrrFloat += 1; // baseline gold is rank 0 in float
    }

    const recall = recallSum / QUERIES;
    const mrrDrop = mrrFloat / QUERIES - mrrInt8 / QUERIES;

    // Contract: Recall@10 drop < 2%, MRR drop < 0.02 vs float32 baseline.
    expect(recall).toBeGreaterThan(0.98);
    expect(mrrDrop).toBeLessThan(0.02);
  });
});
