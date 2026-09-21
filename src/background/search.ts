// Two-stage search (dev plan §5.2): BM25 immediate (stage 1), vector rerank
// pushed async (stage 2). Both stages carry the same queryId so a late stage-2
// from an old query can be ignored by the palette.

import { getBm25 } from './bm25-manager';
import { vectorSearch, expandQuery } from './offscreen-manager';
import { getRecord, allRecords } from '@storage/dao';
import { fuseRanked } from '@search/rrf';
import { bucketByTime } from '@search/timeline';
import type { PageRecord, SearchHit, TimelineBucket } from '@shared/types';
import { type SearchResultsUpdateMsg, TRANSLATE_TARGETS } from '@shared/protocol';

const TOP_K = 50;
const BM25_WEIGHT = 1.2;
const VEC_WEIGHT = 1.0;

// Search results are ranked by RELEVANCE, not time. We return a single flat
// bucket in score order; the UI shows a relative-time label per row for context.
// (Time bucketing is reserved for an empty-query "recent" browse mode.)
function relevanceBuckets(hits: SearchHit[]): TimelineBucket[] {
  if (hits.length === 0) return [];
  return [{ key: 'today', label: '', items: hits }];
}

function toHit(r: PageRecord, score: number): SearchHit {
  return {
    id: r.id,
    url: r.url,
    title: r.title || r.url,
    domain: r.domain,
    description: r.description,
    favicon: r.favicon,
    lastVisited: r.lastVisited,
    score,
  };
}

async function hitsFor(ids: { id: string; score: number }[]): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  for (const { id, score } of ids) {
    const r = await getRecord(id);
    if (r) out.push(toHit(r, score));
  }
  return out;
}

/** Empty-query browse mode: most-recently-visited pages, grouped by time. */
export async function recentBuckets(limit = 50): Promise<TimelineBucket[]> {
  const hits = (await allRecords())
    .filter((r) => r.status === 'committed' || r.title)
    .sort((a, b) => b.lastVisited - a.lastVisited)
    .slice(0, limit)
    .map((r) => toHit(r, 0));
  return bucketByTime(hits);
}

/** Stage 1: synchronous BM25, ranked by relevance. */
export async function bm25Stage(text: string): Promise<TimelineBucket[]> {
  const bm25 = await getBm25();
  const ranked = bm25.search(text, TOP_K);
  const scored = ranked.map((r, i) => ({ id: r.id, score: 1 / (i + 1) }));
  return relevanceBuckets(await hitsFor(scored));
}

/**
 * Stage 2: cross-lingual query expansion (on-device translation) + BM25 and
 * vector over every variant, fused via weighted RRF, broadcast to the palette
 * popup. Turning a cross-lingual query into same-language variants beats relying
 * on the model's cross-lingual alignment (see eval). Falls back to the original
 * query alone when translation is unavailable.
 */
export async function vectorStage(queryId: string, text: string): Promise<void> {
  const variants = (await expandQuery(text, TRANSLATE_TARGETS).catch(() => ({ variants: [text] })))
    .variants;

  const bm25 = await getBm25();
  const lists: { ids: string[]; weight: number }[] = [];
  for (const v of variants) {
    lists.push({ ids: bm25.search(v, TOP_K).map((r) => r.id), weight: BM25_WEIGHT });
  }

  let anyVector = false;
  for (const v of variants) {
    const res = await vectorSearch(v, TOP_K);
    if (res.ok) {
      anyVector = true;
      lists.push({ ids: res.results.map((r) => r.id), weight: VEC_WEIGHT });
    }
  }
  // Nothing beyond the instant stage-1 (no translation, no vector) — skip.
  if (!anyVector && variants.length === 1) return;

  const fused = fuseRanked(lists);
  const buckets = relevanceBuckets(await hitsFor(fused.slice(0, TOP_K)));
  const msg: SearchResultsUpdateMsg = {
    type: 'SEARCH_RESULTS_UPDATE',
    queryId,
    resultVersion: 2,
    buckets,
  };
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // no palette listening (closed) — ignore
  }
}
