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

### Cross-lingual note

When the query language differs from the page language, keyword (BM25) can't
match and the small model's cross-lingual alignment is weak — the right page
often lands in the top-10 but not at #1. The extension addresses this at runtime
with **on-device query translation** (Chrome Translation API): the query is
translated into the UI languages and every variant is searched, turning a
cross-lingual query into a same-language one.

`--model` lets you compare embedding models (e.g. `Xenova/multilingual-e5-base`).
Measured on a real 243-doc corpus, 7 cross-lingual queries:

| approach | Recall@10 | MRR | FirstHit |
|---|---|---|---|
| e5-small (raw cross-lingual) | 0.71 | 0.40 | 0.29 |
| e5-large (raw cross-lingual) | 0.86 | 0.53 | 0.43 |
| e5-small + translation | 1.00 | 0.87 | 0.86 |

i.e. translating the query beats a 4× larger model. Node has no Translation API,
so the translation path is validated offline via a hand-translated label set
(`labels-translated.json`) and verified for real in the browser.

## 2. Micro-benchmark (`eval:bench`)

Pure-JS hot paths (no browser, no model): BM25 build+search and the int8
brute-force vector scan. Produces P50/P95 for the dev-plan §11.1 protocol.

```bash
npm run eval:bench -- --n 50000 --queries 200
```

The full in-product semantic latency additionally includes query embedding
(tens of ms), which is measured in-browser (panel shows the backend in use).
