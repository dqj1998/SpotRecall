// MiniSearch wrapper. In-memory BM25 index; snapshot is a rebuildable CACHE
// only — records store is the source of truth (dev plan §4.2).

import MiniSearch from 'minisearch';
import type { PageRecord } from '@shared/types';

export interface IndexDoc {
  id: string;
  title: string;
  url: string;
  domain: string;
  description: string;
  cleanText: string;
}

function toDoc(r: PageRecord): IndexDoc {
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    domain: r.domain,
    description: r.description,
    cleanText: r.cleanText,
  };
}

// CJK-aware tokenizer. MiniSearch's default splits only on spaces/punctuation,
// so Japanese/Chinese (no spaces) collapse into one giant token and keyword
// search fails for multi-word CJK queries. Intl.Segmenter (word granularity)
// segments ja/zh/en correctly; falls back to the whitespace split if absent.
let segmenter: Intl.Segmenter | null | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}
// ICU builds disagree on punctuation inside words ("Amazon.co.jp" is one segment
// in Node's ICU, three in Chrome's), so word-like segments are split again on
// punctuation/symbols. Tokens then no longer depend on the ICU version — an index
// snapshot stays consistent across Chrome updates, and eval/ (Node) builds the
// same index as the extension.
const SPLIT = /[\s\p{P}\p{S}]+/u;
function tokenize(text: string): string[] {
  const seg = getSegmenter();
  if (!seg) return text.split(SPLIT).filter(Boolean);
  const out: string[] = [];
  for (const part of seg.segment(text)) {
    if (!part.isWordLike) continue;
    for (const t of part.segment.split(SPLIT)) if (t) out.push(t);
  }
  return out;
}

// Query-side noise terms. With OR semantics + prefix matching, a lone particle
// like 的/の or "of" matches (or prefix-matches) a large share of the corpus and
// floods the candidate list with irrelevant pages.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was',
  'be', 'by', 'at', 'as', 'with', 'from', 'it', 'this', 'that', 'what', 'how',
  '的', '了', '和', '与', '是', '在', '把', '吗', '呢', '个',
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や', 'か', 'な',
]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Drop stopwords from a query (unless that would leave nothing). Exported for tests. */
export function queryTerms(query: string): string[] {
  const terms = tokenize(query);
  const kept = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return kept.length > 0 ? kept : terms;
}

// Prefix-match only terms long enough to be specific: "gar" → "gardening" is
// useful, but "訳" or "of" as a prefix matches far too much.
function usePrefix(term: string): boolean {
  return CJK.test(term) ? term.length >= 2 : term.length >= 3;
}

/**
 * True when every query term occurs in `text` (with the same prefix rule as
 * search). Used to tell a title-only record that genuinely matches the query from
 * one that only shares a stray term with it.
 */
export function coversAllTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const tokens = tokenize(text).map((t) => t.toLowerCase());
  return terms.every((term) => {
    const q = term.toLowerCase();
    return tokens.some((d) => d === q || (usePrefix(q) && d.startsWith(q)));
  });
}

const OPTIONS = {
  fields: ['title', 'url', 'domain', 'description', 'cleanText'],
  storeFields: ['id'],
  tokenize,
  searchOptions: {
    boost: { title: 3, url: 2, domain: 2, description: 1.5, cleanText: 1 },
    prefix: usePrefix,
    // OR so long natural-language queries don't require every term to be present;
    // BM25 still ranks docs with more/rarer term matches higher.
    combineWith: 'OR' as const,
    tokenize,
  },
};

export class Bm25Index {
  private ms: MiniSearch<IndexDoc>;

  constructor() {
    this.ms = new MiniSearch<IndexDoc>(OPTIONS);
  }

  upsert(r: PageRecord): void {
    const doc = toDoc(r);
    if (this.ms.has(r.id)) this.ms.replace(doc);
    else this.ms.add(doc);
  }

  remove(id: string): void {
    if (this.ms.has(id)) this.ms.discard(id);
  }

  search(query: string, limit = 50): { id: string }[] {
    if (!query.trim()) return [];
    return this.ms
      .search(queryTerms(query).join(' '))
      .slice(0, limit)
      .map((r) => ({ id: r.id as string }));
  }

  get size(): number {
    return this.ms.documentCount;
  }

  serialize(): string {
    return JSON.stringify(this.ms.toJSON());
  }

  static fromSnapshot(json: string): Bm25Index {
    const idx = new Bm25Index();
    idx.ms = MiniSearch.loadJSON<IndexDoc>(json, OPTIONS);
    return idx;
  }

  static fromRecords(records: PageRecord[]): Bm25Index {
    const idx = new Bm25Index();
    idx.ms.addAll(records.map(toDoc));
    return idx;
  }
}
