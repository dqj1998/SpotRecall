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

## 2. Stage-2 search tuning (`eval:fusion-dump` + `eval:fusion`)

Tunes the cross-lingual pipeline: query source-language detection
(`src/shared/query-lang.ts`), translation variants, and how BM25 and vector
results are fused and re-weighted (`src/search/fusion.ts`, `FUSION_PARAMS`).
Translation and the extension's vector store only exist in the browser, so this is
a two-step loop:

1. **Capture** (real Chrome via puppeteer-core). This uses a dedicated profile in
   `eval/.cache/`: it imports the backup, waits for the model and downloads the
   translation models. For each labeled query it records translations in **every**
   en/ja/zh direction, the vector results for each text, and the live stage-2
   ranking:

   ```bash
   npm run build
   npm run eval:fusion-dump -- --backup ~/Downloads/spotrecall-backup-XXX.zip
   ```

2. **Replay offline** with the production detection / `Bm25Index` / fusion / priors:

   ```bash
   npm run eval:fusion -- --backup …              # production vs baseline, per tag + parity
   npm run eval:fusion -- --backup … --ablation   # each improvement alone and stacked
   npm run eval:fusion -- --backup … --cv         # 2-fold: tune on half, test on the other
   npm run eval:fusion -- --backup … --grid       # parameter sweep
   npm run eval:fusion -- --backup … --verbose    # per-query ranks + variants
   npm run eval:fusion -- --backup … --bookmarked-backfill   # worst case, see below
   npm run eval:fusion -- --backup … --rrf-k 5 --contentless-w 0.7   # overrides
   ```

The **parity** table compares the live ranking with the offline replay; with a
dump from the current build it should show `top-10 identical: n/n`. Two things
broke parity during development, and both are handled now:
- A reused Chrome profile runs the *previous* build's service worker from cache.
  The dump script clears that cache before each launch.
- Node's and Chrome's ICU segment punctuation differently. The tokenizer re-splits
  on punctuation, so both engines produce identical tokens.

`--bookmarked-backfill` simulates the worst case for title-only records. These are
backfilled bookmarks, and in a real profile they also get `BOOKMARK_BOOST`, but the
dump profile has no bookmarks.

Labels go in `eval/labels-fusion.json`. The file is git-ignored because it reveals
your browsing; see [`labels-fusion.example.json`](labels-fusion.example.json).
- Each `match` entry is a regex, `url:…` or `title:…`; any match counts as
  relevant.
- `tag` groups queries in the per-category columns, e.g. `xling` (cross-lingual),
  `same`, `kanji` (Han-only Japanese), `bookmark` (title-only targets).
- Re-run the dump after adding queries or rebuilding.
- Accept a change only if it holds up per tag, in the worst case, *and* under
  `--cv`. A few dozen queries overfit easily: on our set, the grid's best
  parameters did not beat production on held-out queries.

Measured on a 1088-record backup with 54 mixed zh/ja/en queries. All numbers are
live-identical:

| configuration | MRR | Hit@1 | Hit@10 | worst-case MRR |
|---|---|---|---|---|
| k=60, equal weights, untrimmed vectors (original) | 0.30* | — | — | — |
| k=3, translations ×0.7, trimmed vectors (baseline) | 0.803 | 38 | 53 | 0.770 |
| + Han hints, ambiguous Han ⇒ translate from zh and ja | 0.809 | 38 | 54 | 0.787 |
| + title-only records ×0.5 unless they match every term of a variant | **0.828** | 39 | 54 | **0.826** |

\* measured on the first 32 queries only.

Tried and rejected:
- Dropping BM25 lists of low-coverage translations helped kanji queries but hurt
  cross-lingual ones, and was unstable under `--cv`.
- A recency prior buried old bookmarks.

## 3. Micro-benchmark (`eval:bench`)

Pure-JS hot paths (no browser, no model): BM25 build+search and the int8
brute-force vector scan. Produces P50/P95 for the dev-plan §11.1 protocol.

```bash
npm run eval:bench -- --n 50000 --queries 200
```

The full in-product semantic latency additionally includes query embedding
(tens of ms), which is measured in-browser (panel shows the backend in use).
