// Two-stage search (dev plan §5.2): BM25 immediate (stage 1), vector rerank
// pushed async (stage 2). Both stages carry the same queryId so a late stage-2
// from an old query can be ignored by the palette.

import { getBm25 } from './bm25-manager';
import { queryTerms } from '@search/bm25';
import { vectorSearch, expandQuery } from './offscreen-manager';
import { getBookmarkedIds } from './bookmarks';
import { getRecord, allRecords } from '@storage/dao';
import { fuseVariants, recordPrior, dedupeByContent, snippetOf, displayKey as keyOf } from '@search/fusion';
import { bucketByTime } from '@search/timeline';
import type { PageRecord, SearchHit, TimelineBucket } from '@shared/types';
import { type SearchResultsUpdateMsg, TRANSLATE_TARGETS } from '@shared/protocol';

const TOP_K = 50;
const BOOKMARK_BOOST = 1.5;

/**
 * Tag bookmarked hits and (when boosting) lift them via a score multiplier, then
 * re-sort. Pure: exported for tests. Browse mode marks without re-ordering.
 */
export function decorateBookmarks(
  hits: SearchHit[],
  bookmarked: Set<string>,
  boost: boolean,
): SearchHit[] {
  if (bookmarked.size === 0) return hits;
  const out = hits.map((h) =>
    bookmarked.has(h.id)
      ? { ...h, isBookmark: true, score: boost ? h.score * BOOKMARK_BOOST : h.score }
      : h,
  );
  return boost ? out.sort((a, b) => b.score - a.score) : out;
}

// Search results are ranked by RELEVANCE, not time. We return a single flat
// bucket in score order; the UI shows a relative-time label per row for context.
// (Time bucketing is reserved for an empty-query "recent" browse mode.)
function relevanceBuckets(hits: SearchHit[]): TimelineBucket[] {
  if (hits.length === 0) return [];
  return [{ key: 'today', label: '', items: hits }];
}

function toHit(r: PageRecord, score: number): SearchHit {
  const snippet = snippetOf(r);
  return {
    id: r.id,
    url: r.url,
    title: r.title || r.url,
    domain: r.domain,
    description: r.description,
    snippet,
    favicon: r.favicon,
    lastVisited: r.lastVisited,
    score,
  };
}

const displayKey = (h: SearchHit) => keyOf(h.title, h.snippet);

async function hitsFor(ids: { id: string; score: number }[], variants: string[]): Promise<SearchHit[]> {
  const variantTerms = variants.map(queryTerms);
  const scored: { rec: PageRecord; score: number }[] = [];
  for (const { id, score } of ids) {
    const r = await getRecord(id);
    if (r) scored.push({ rec: r, score: score * recordPrior(r, variantTerms) });
  }
  scored.sort((a, b) => b.score - a.score); // stable: no-op while priors are neutral
  const hits = dedupeByContent(scored, (x) => x.rec.contentHash).map((x) => toHit(x.rec, x.score));
  return dedupeByContent(hits, displayKey);
}

/** Empty-query browse mode: most-recently-visited pages, grouped by time. */
export async function recentBuckets(limit = 50): Promise<TimelineBucket[]> {
  const ordered = (await allRecords())
    .filter((r) => r.status === 'committed' || r.title)
    .sort((a, b) => b.lastVisited - a.lastVisited);
  const hits = dedupeByContent(
    dedupeByContent(ordered, (r) => r.contentHash).map((r) => toHit(r, 0)),
    displayKey,
  ).slice(0, limit);
  return bucketByTime(decorateBookmarks(hits, await getBookmarkedIds(), false));
}

/** Stage 1: synchronous BM25, ranked by relevance. */
export async function bm25Stage(text: string): Promise<TimelineBucket[]> {
  const bm25 = await getBm25();
  const ranked = bm25.search(text, TOP_K);
  const scored = ranked.map((r, i) => ({ id: r.id, score: 1 / (i + 1) }));
  const hits = decorateBookmarks(await hitsFor(scored, [text]), await getBookmarkedIds(), true);
  return relevanceBuckets(hits);
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
  const bm25Lists = variants.map((v) => bm25.search(v, TOP_K).map((r) => r.id));
  const vecLists: ({ id: string; score: number }[] | null)[] = [];
  for (const v of variants) {
    const res = await vectorSearch(v, TOP_K);
    vecLists.push(res.ok ? res.results : null);
  }
  // Nothing beyond the instant stage-1 (no translation, no vector) — skip.
  if (variants.length === 1 && !vecLists[0]) return;

  const fused = fuseVariants(bm25Lists, vecLists);
  const hits = decorateBookmarks(await hitsFor(fused.slice(0, TOP_K), variants), await getBookmarkedIds(), true);
  const buckets = relevanceBuckets(hits);
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
