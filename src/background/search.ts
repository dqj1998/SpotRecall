// Two-stage search (dev plan §5.2): BM25 immediate (stage 1), vector rerank
// pushed async (stage 2). Both stages carry the same queryId so a late stage-2
// from an old query can be ignored by the palette.

import { getBm25 } from './bm25-manager';
import { vectorSearch } from './offscreen-manager';
import { getRecord } from '@storage/dao';
import { reciprocalRankFusion } from '@search/rrf';
import { bucketByTime } from '@search/timeline';
import type { PageRecord, SearchHit, TimelineBucket } from '@shared/types';
import type { SearchResultsUpdateMsg } from '@shared/protocol';

const TOP_K = 50;

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

/** Stage 1: synchronous BM25 buckets. */
export async function bm25Stage(text: string): Promise<TimelineBucket[]> {
  const bm25 = await getBm25();
  const ranked = bm25.search(text, TOP_K);
  const scored = ranked.map((r, i) => ({ id: r.id, score: 1 / (i + 1) }));
  return bucketByTime(await hitsFor(scored));
}

/**
 * Stage 2: vector + RRF fusion, broadcast to the palette popup via runtime
 * messaging (the action popup has no tab, so tabs.sendMessage cannot reach it).
 * The palette matches on queryId and ignores stale/other messages.
 */
export async function vectorStage(queryId: string, text: string): Promise<void> {
  const bm25 = await getBm25();
  const bm25Ranked = bm25.search(text, TOP_K);
  const vec = await vectorSearch(text, TOP_K);
  if (!vec.ok) return; // stay with stage-1 results

  const fused = reciprocalRankFusion(
    bm25Ranked.map((r) => ({ id: r.id })),
    vec.results.map((r) => ({ id: r.id })),
  );
  const buckets = bucketByTime(await hitsFor(fused.slice(0, TOP_K)));
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
