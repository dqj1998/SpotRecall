// Light micro-benchmark of the search hot paths (no browser, no model needed).
// Produces real P50/P95 numbers for the dev-plan §11.1 acceptance protocol and
// guards against perf regressions. Uses the real BM25 index and int8 scoring.
//
//   npm run eval:bench -- --n 50000 --queries 200

import { quantizeInt8, l2normalize } from '../src/shared/quantize';
import { Bm25Index } from '../src/search/bm25';

const DIM = 384;

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : def;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function report(label: string, times: number[]): void {
  console.log(
    `${label.padEnd(28)} P50=${pct(times, 50).toFixed(3)}ms  P95=${pct(times, 95).toFixed(3)}ms  ` +
      `mean=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)}ms`,
  );
}

const WORDS = ['error', 'typeerror', 'github', 'issue', '税务', '申报', 'config', 'backend', 'v3', 'null', '报错', '登录'];
const rnd = (n: number) => Math.floor(Math.random() * n);
const phrase = (k: number) => Array.from({ length: k }, () => WORDS[rnd(WORDS.length)]).join(' ');

function main() {
  const N = arg('n', 50000);
  const Q = arg('queries', 200);
  console.log(`Benchmark: N=${N} records/vectors, ${Q} queries, dim=${DIM}\n`);

  // ---- BM25 build + search ----
  const t0 = performance.now();
  const records = Array.from({ length: N }, (_, i) => ({
    id: `r${i}`,
    url: `https://ex.com/${i}`,
    normalizedUrl: `https://ex.com/${i}`,
    title: phrase(4),
    domain: 'ex.com',
    description: phrase(6),
    cleanText: phrase(40),
    contentHash: '',
    status: 'committed',
    firstSeen: 0,
    lastVisited: i,
    committedVisits: 1,
    embedModelId: null,
  }));
  const bm25 = Bm25Index.fromRecords(records as never);
  console.log(`BM25 index build: ${(performance.now() - t0).toFixed(0)}ms for ${N} docs\n`);

  const bm25Times: number[] = [];
  for (let q = 0; q < Q; q++) {
    const query = phrase(2);
    const s = performance.now();
    bm25.search(query, 50);
    bm25Times.push(performance.now() - s);
  }
  report('BM25 search', bm25Times);

  // ---- int8 vector build + brute-force scan (mirrors VectorStore.search) ----
  const data = new Int8Array(N * DIM);
  const scales = new Float32Array(N);
  const tmp = new Float32Array(DIM);
  const tq = performance.now();
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < DIM; d++) tmp[d] = Math.random() * 2 - 1;
    const { q, scale } = quantizeInt8(tmp);
    data.set(q, i * DIM);
    scales[i] = scale;
  }
  console.log(`\nint8 quantize: ${(performance.now() - tq).toFixed(0)}ms for ${N} vectors`);

  const scanTimes: number[] = [];
  const scores = new Float32Array(N);
  for (let q = 0; q < Q; q++) {
    for (let d = 0; d < DIM; d++) tmp[d] = Math.random() * 2 - 1;
    const uq = l2normalize(tmp);
    const s = performance.now();
    for (let i = 0; i < N; i++) {
      const base = i * DIM;
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += data[base + d] * uq[d];
      scores[i] = dot * scales[i];
    }
    // top-k selection cost is negligible vs the scan; include a simple max pass
    let best = -Infinity;
    for (let i = 0; i < N; i++) if (scores[i] > best) best = scores[i];
    scanTimes.push(performance.now() - s);
  }
  report('Vector brute-force scan', scanTimes);

  console.log('\nNote: full semantic latency also includes query embedding (~tens of ms,');
  console.log('measured in-browser). This bench covers the pure JS hot paths.');
}

main();
