// In-memory int8 vector buffer + brute-force search. Rebuilt from IndexedDB on
// offscreen (re)start; runtime additions are cached here after EMBED_BATCH.

import { MODEL_DIM } from '@shared/protocol';
import { l2normalize } from '@shared/quantize';
import type { VectorRecord } from '@shared/types';

export class VectorStore {
  readonly dim = MODEL_DIM;
  private ids: string[] = [];
  private rowOf = new Map<string, number>();
  private scales: number[] = [];
  private data = new Int8Array(0);
  private count = 0;

  get size(): number {
    return this.count;
  }

  loadAll(vectors: VectorRecord[]): void {
    this.ids = [];
    this.rowOf.clear();
    this.scales = [];
    this.count = 0;
    this.data = new Int8Array(vectors.length * this.dim);
    for (const v of vectors) this.upsert(v.id, v.q, v.scale);
  }

  private ensureCapacity(rows: number): void {
    const needed = rows * this.dim;
    if (needed <= this.data.length) return;
    const next = new Int8Array(Math.max(needed, this.data.length * 2 || this.dim * 16));
    next.set(this.data);
    this.data = next;
  }

  upsert(id: string, q: number[] | Int8Array, scale: number): void {
    let row = this.rowOf.get(id);
    if (row === undefined) {
      row = this.count;
      this.ensureCapacity(this.count + 1);
      this.rowOf.set(id, row);
      this.ids[row] = id;
      this.count++;
    }
    this.scales[row] = scale;
    this.data.set(q instanceof Int8Array ? q : Int8Array.from(q), row * this.dim);
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      const row = this.rowOf.get(id);
      if (row === undefined) continue;
      const last = this.count - 1;
      if (row !== last) {
        // Move last row into the hole.
        this.data.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim);
        const lastId = this.ids[last];
        this.ids[row] = lastId;
        this.scales[row] = this.scales[last];
        this.rowOf.set(lastId, row);
      }
      this.ids.pop();
      this.scales.pop();
      this.rowOf.delete(id);
      this.count--;
    }
  }

  /**
   * Score a single stored vector (by id) against an L2-normalized float32 query.
   * Returns null when the id is not in the buffer. Used by SCORE_AGAINST to rank
   * specific candidate tabs rather than the whole buffer.
   */
  scoreOne(query: Float32Array, id: string): number | null {
    const row = this.rowOf.get(id);
    if (row === undefined) return null;
    const uq = query.length === this.dim ? query : l2normalize(query);
    const base = row * this.dim;
    let dot = 0;
    for (let i = 0; i < this.dim; i++) dot += this.data[base + i] * uq[i];
    return dot * this.scales[row];
  }

  /** query must be L2-normalized float32. Returns top-K by approx cosine. */
  search(query: Float32Array, topK: number): { id: string; score: number }[] {
    const uq = query.length === this.dim ? query : l2normalize(query);
    const results: { id: string; score: number }[] = [];
    for (let row = 0; row < this.count; row++) {
      const base = row * this.dim;
      let dot = 0;
      for (let i = 0; i < this.dim; i++) dot += this.data[base + i] * uq[i];
      results.push({ id: this.ids[row], score: dot * this.scales[row] });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
