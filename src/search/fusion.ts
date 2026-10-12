// Stage-2 fusion (dev plan §5.3): BM25 + vector lists over the original query and
// its translations, fused via weighted RRF. Pure & shared with eval/fusion-eval.ts
// so offline tuning measures exactly what ships.

import { fuseRanked } from './rrf';
import { coversAllTerms } from './bm25';
import { isAuthUrl } from '@shared/url';

export interface FusionParams {
  bm25Weight: number;
  vecWeight: number;
  /** RRF smoothing. Textbook k=60 makes ranks nearly flat (#1 ≈ #20), so a doc that
   *  is mediocre in many correlated lists beats the clear #1 of one. */
  rrfK: number;
  /** Machine translations are lossy (and kanji-only Japanese can be mis-detected as
   *  Chinese), so translated variants count less than the user's own words. */
  translationWeight: number;
  /** Vector search always returns topK, however weak the match. Keep only hits within
   *  this cosine margin of the best one (e5 scores sit in a narrow ~0.75–0.9 band). */
  vecMargin: number;
  vecDepth: number;
  /** Score multiplier for a title-only (provisional) record that does not contain
   *  every term of any query variant, e.g. a backfilled bookmark sharing one stray
   *  word with the query. Short titles otherwise score high on a single term. 1 = off. */
  contentlessWeight: number;
  /** Score multiplier for login / security-check pages: their few words (and generic
   *  embeddings) match many queries, but they are never what the user is looking for. */
  interstitialWeight: number;
  /** A sign-in URL only counts as an interstitial below this much captured text, so a
   *  real page under such a path (OAuth docs, a long consent screen) keeps its rank.
   *  Real auth steps measured ≤ ~800 chars; the median content page hits the 2000 cap. */
  interstitialMaxChars: number;
}

// Tuned with eval/fusion-eval.ts on real captured data; see eval/README.md.
export const FUSION_PARAMS: FusionParams = {
  bm25Weight: 1.2,
  vecWeight: 1.0,
  rrfK: 3,
  translationWeight: 0.7,
  vecMargin: 0.06,
  vecDepth: 20,
  contentlessWeight: 0.5,
  interstitialWeight: 0.3,
  interstitialMaxChars: 1000,
};

/** Trim a score-sorted vector list to hits close to the top score. */
export function trimVectorHits<T extends { score: number }>(
  results: T[],
  { vecMargin, vecDepth }: Pick<FusionParams, 'vecMargin' | 'vecDepth'> = FUSION_PARAMS,
): T[] {
  if (results.length === 0) return results;
  const floor = results[0].score - vecMargin;
  return results.slice(0, vecDepth).filter((r) => r.score >= floor);
}

/**
 * Fuse per-variant result lists. Index 0 is the user's original query; the rest are
 * translations. `vecLists[i]` is null when vector search was unavailable for that
 * variant. Embeddings of a query and its translations are near-duplicates, so the
 * vector weight is split across variants instead of multiplying with their count.
 */
export function fuseVariants(
  bm25Lists: string[][],
  vecLists: ({ id: string; score: number }[] | null)[],
  params: FusionParams = FUSION_PARAMS,
): { id: string; score: number }[] {
  const variantWeight = (i: number) => (i === 0 ? 1 : params.translationWeight);
  const vecWeight = params.vecWeight / bm25Lists.length;
  const lists: { ids: string[]; weight: number }[] = [];
  bm25Lists.forEach((ids, i) => lists.push({ ids, weight: params.bm25Weight * variantWeight(i) }));
  vecLists.forEach((res, i) => {
    if (!res) return;
    lists.push({ ids: trimVectorHits(res, params).map((r) => r.id), weight: vecWeight * variantWeight(i) });
  });
  return fuseRanked(lists, params.rrfK);
}

/** Sign-in / security-check step: auth-looking URL AND little captured text. */
export function isInterstitial(
  r: { url: string; cleanText?: string },
  { interstitialMaxChars }: Pick<FusionParams, 'interstitialMaxChars'> = FUSION_PARAMS,
): boolean {
  return (r.cleanText ?? '').length < interstitialMaxChars && isAuthUrl(r.url);
}

/**
 * Query-dependent score multiplier for a record: penalize a title-only record
 * unless it contains every term of some variant (`variantTerms`, from queryTerms),
 * and always penalize sign-in interstitials.
 */
export function recordPrior(
  r: { status: string; title: string; url: string; cleanText?: string },
  variantTerms: string[][],
  params: Pick<FusionParams, 'contentlessWeight' | 'interstitialWeight' | 'interstitialMaxChars'> = FUSION_PARAMS,
): number {
  const auth = isInterstitial(r, params) ? params.interstitialWeight : 1;
  if (r.status !== 'provisional' || params.contentlessWeight === 1) return auth;
  const text = `${r.title} ${r.url}`;
  return auth * (variantTerms.some((terms) => coversAllTerms(text, terms)) ? 1 : params.contentlessWeight);
}

/**
 * Collapse entries that share a non-empty key, keeping the first (i.e. the
 * best-ranked / most-recent, since callers pass ordered lists). Used with the
 * contentHash to hide URL-distinct but content-identical pages (typically
 * login/OAuth pages whose URLs differ only by per-visit auth params). Empty keys
 * never collapse.
 */
export function dedupeByContent<T>(items: T[], hashOf: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const h = hashOf(it);
    if (!h) return true;
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

/** The row text the palette shows; used to build the display dedupe key. */
export function snippetOf(r: { description?: string; cleanText?: string }): string {
  return (r.description || r.cleanText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Same title + same visible snippet reads as a duplicate row even when the captured
 *  bodies differ slightly (e.g. two ChatGPT sessions). */
export function displayKey(title: string, snippet: string): string {
  return title ? `${title}\n${snippet}` : '';
}
