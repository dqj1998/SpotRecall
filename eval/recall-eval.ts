// Offline recall/MRR evaluation over REAL captured data + a small hand-labeled
// query set. Exercises the actual code paths (BM25, int8 quantize+score, RRF, URL
// normalization) so it doubles as a regression guard for search quality.
//
// Usage:
//   1. In the panel: Export backup (a .zip with records.ndjson).
//   2. Label a few queries in eval/labels.json (see labels.example.json).
//   3. npm run eval:recall -- --backup path/to/backup.zip --labels eval/labels.json
//
// Reports Recall@K / MRR / first-hit for BM25-only, vector-only, and fused (RRF).

import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { pipeline, env } from '@huggingface/transformers';
import { normalizeUrl } from '../src/shared/url';
import { quantizeInt8, scoreInt8, l2normalize } from '../src/shared/quantize';
import { reciprocalRankFusion } from '../src/search/rrf';
import { Bm25Index } from '../src/search/bm25';

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';

interface Rec {
  id: string;
  url: string;
  normalizedUrl?: string;
  title: string;
  domain: string;
  description: string;
  cleanText: string;
}
interface Label {
  query: string;
  relevantUrls: string[];
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function loadRecords(backup?: string, recordsPath?: string): Promise<Rec[]> {
  let ndjson: string;
  if (backup) {
    const zip = unzipSync(await readFile(backup));
    const f = zip['records.ndjson'];
    if (!f) throw new Error('backup has no records.ndjson');
    ndjson = strFromU8(f);
  } else if (recordsPath) {
    ndjson = await readFile(recordsPath, 'utf8');
  } else {
    throw new Error('provide --backup <zip> or --records <ndjson>');
  }
  return ndjson
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec)
    .map((r) => ({ ...r, normalizedUrl: r.normalizedUrl || normalizeUrl(r.url) }))
    .filter((r) => (r.cleanText && r.cleanText.length > 0) || r.title);
}

let extractor: (t: string[], o: unknown) => Promise<{ data: Float32Array; dims: number[] }>;
async function embed(texts: string[], prefix: 'query' | 'passage'): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  const B = 16;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B).map((t) => `${prefix}: ${t}`);
    const res = await extractor(batch, { pooling: 'mean', normalize: false });
    const [n, dim] = res.dims as [number, number];
    for (let j = 0; j < n; j++) out.push(res.data.slice(j * dim, (j + 1) * dim));
    process.stdout.write(`\r  embedding ${prefix}: ${Math.min(i + B, texts.length)}/${texts.length}   `);
  }
  process.stdout.write('\n');
  return out;
}

function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  const top = ranked.slice(0, k);
  let hit = 0;
  for (const id of top) if (relevant.has(id)) hit++;
  return relevant.size ? hit / Math.min(relevant.size, k) : 0;
}
function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (relevant.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

async function main() {
  const backup = arg('backup');
  const recordsPath = arg('records');
  const labelsPath = arg('labels', 'eval/labels.json')!;
  const K = parseInt(arg('k', '10')!, 10);
  const MODEL_ID = arg('model', DEFAULT_MODEL)!;

  const records = await loadRecords(backup, recordsPath);
  const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Label[];
  console.log(`Loaded ${records.length} records, ${labels.length} labeled queries. K=${K}`);
  console.log(`Model: ${MODEL_ID}\n`);

  env.allowRemoteModels = true; // eval downloads the model to a local cache
  console.log('Loading model (first run downloads to cache)…');
  extractor = (await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })) as never;

  // Index (real code paths).
  const bm25 = Bm25Index.fromRecords(records as never);
  const docText = (r: Rec) => `${r.title}\n${r.description}\n${r.cleanText}`.trim();
  const docVecs = await embed(records.map(docText), 'passage');
  const quantized = docVecs.map((v) => quantizeInt8(v));
  const queryVecs = await embed(labels.map((l) => l.query), 'query');

  const agg = {
    bm25: { r: 0, mrr: 0, fh: 0 },
    vec: { r: 0, mrr: 0, fh: 0 },
    fused: { r: 0, mrr: 0, fh: 0 },
  };
  let evaluated = 0;

  labels.forEach((label, qi) => {
    const relNorm = new Set(label.relevantUrls.map((u) => normalizeUrl(u)));
    const relevant = new Set(records.filter((r) => relNorm.has(r.normalizedUrl!)).map((r) => r.id));
    if (relevant.size === 0) {
      console.warn(`! query "${label.query}": no matching records for its relevantUrls — skipped`);
      return;
    }
    evaluated++;

    const bm25Ids = bm25.search(label.query, 100).map((h) => h.id);
    const uq = l2normalize(queryVecs[qi]);
    const vecIds = quantized
      .map((qd, i) => ({ id: records[i].id, s: scoreInt8(qd.q, qd.scale, uq) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.id);
    const fusedIds = reciprocalRankFusion(
      bm25Ids.map((id) => ({ id })),
      vecIds.map((id) => ({ id })),
    ).map((x) => x.id);

    for (const [key, ids] of [
      ['bm25', bm25Ids],
      ['vec', vecIds],
      ['fused', fusedIds],
    ] as const) {
      agg[key].r += recallAtK(ids, relevant, K);
      agg[key].mrr += reciprocalRank(ids, relevant);
      agg[key].fh += ids[0] && relevant.has(ids[0]) ? 1 : 0;
    }
  });

  const n = evaluated || 1;
  const row = (name: string, m: { r: number; mrr: number; fh: number }) =>
    `${name.padEnd(8)}  Recall@${K}=${(m.r / n).toFixed(3)}   MRR=${(m.mrr / n).toFixed(3)}   FirstHit=${(m.fh / n).toFixed(3)}`;

  console.log(`\n=== Results over ${evaluated} evaluated queries ===`);
  console.log(row('BM25', agg.bm25));
  console.log(row('Vector', agg.vec));
  console.log(row('Fused', agg.fused));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
