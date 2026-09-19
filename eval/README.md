# SpotRecall evaluation

Offline scripts that exercise the **real** search code paths (BM25, int8
quantize+score, weighted RRF, URL normalization) to produce reproducible numbers
and guard against quality/perf regressions.

## 1. Recall / MRR (`eval:recall`)

Measures semantic quality on **your own captured data** + a small hand-labeled
query set. This is the only objective check that semantic search is actually
finding the right pages — run it after any change to the model, e5 prefixes, RRF
weights, or quantization.

**Workflow**

1. In the extension panel, click **Export backup** (produces a `.zip` with
   `records.ndjson`). Vectors are not needed — the script re-embeds.
2. Create `eval/labels.json` from [`labels.example.json`](labels.example.json):
   a list of `{ "query": "...", "relevantUrls": ["...", ...] }`. The
   `relevantUrls` are matched to captured records by normalized URL, so paste the
   real URLs of the pages you'd expect that query to recall (5–30 queries is
   plenty to start; more is better).
3. Run:

   ```bash
   npm run eval:recall -- --backup ~/Downloads/spotrecall-backup-XX; --labels eval/labels.json --k 10
   ```

   (First run downloads the model to a local Node cache; afterwards it is offline.)

**Output** — Recall@K / MRR / FirstHit for `BM25`, `Vector`, and `Fused` (RRF),
so you can see what each layer contributes:

```
=== Results over 12 evaluated queries ===
BM25      Recall@10=0.583   MRR=0.612   FirstHit=0.500
Vector    Recall@10=0.750   MRR=0.688   FirstHit=0.583
Fused     Recall@10=0.833   MRR=0.741   FirstHit=0.667
```

> A labeled set only measures what it encodes — a small or careless set gives
> false confidence. Add queries that reflect how you actually search.

## 2. Micro-benchmark (`eval:bench`)

Pure-JS hot paths (no browser, no model): BM25 build+search and the int8
brute-force vector scan. Produces P50/P95 for the dev-plan §11.1 protocol.

```bash
npm run eval:bench -- --n 50000 --queries 200
```

The full in-product semantic latency additionally includes query embedding
(tens of ms), which is measured in-browser (panel shows the backend in use).
