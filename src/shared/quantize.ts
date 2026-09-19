// int8 vector quantization + similarity scoring contract (dev plan §4.3).
// Contract:
//   1. L2-normalize before quantizing (both doc and query).
//   2. Symmetric int8 quantization, zero_point === 0.
//   3. Query kept as normalized float32 (not quantized) for accuracy.
//   4. score = Σ_i (q_i · scale) · uq_i  ≈ cosine similarity.
// Pure & unit-tested against a float32 baseline.

export function l2normalize(v: Float32Array | number[]): Float32Array {
  const n = v.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += (v[i] as number) * (v[i] as number);
  const norm = Math.sqrt(s) || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (v[i] as number) / norm;
  return out;
}

export interface Quantized {
  q: Int8Array;
  scale: number;
}

/** Normalize then symmetric-quantize to int8 (zero_point = 0). */
export function quantizeInt8(v: Float32Array | number[]): Quantized {
  const u = l2normalize(v);
  let max = 0;
  for (let i = 0; i < u.length; i++) {
    const a = Math.abs(u[i]);
    if (a > max) max = a;
  }
  const scale = max / 127 || 1e-8;
  const q = new Int8Array(u.length);
  for (let i = 0; i < u.length; i++) {
    let qi = Math.round(u[i] / scale);
    if (qi > 127) qi = 127;
    else if (qi < -128) qi = -128;
    q[i] = qi;
  }
  return { q, scale };
}

export function dequantize(q: Int8Array | number[], scale: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] as number) * scale;
  return out;
}

/** score(doc int8, scale) vs query (must already be L2-normalized float32). */
export function scoreInt8(
  q: Int8Array | number[],
  scale: number,
  queryNormalized: Float32Array,
): number {
  let dot = 0;
  const n = q.length;
  for (let i = 0; i < n; i++) dot += (q[i] as number) * queryNormalized[i];
  return dot * scale;
}

/** Plain cosine of two raw vectors — the float32 baseline for correctness tests. */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) * (a[i] as number);
    nb += (b[i] as number) * (b[i] as number);
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
