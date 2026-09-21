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
function tokenize(text: string): string[] {
  const seg = getSegmenter();
  if (!seg) return text.split(/[\s\p{P}]+/u).filter(Boolean);
  const out: string[] = [];
  for (const part of seg.segment(text)) {
    if (part.isWordLike) out.push(part.segment);
  }
  return out;
}

const OPTIONS = {
  fields: ['title', 'url', 'domain', 'description', 'cleanText'],
  storeFields: ['id'],
  tokenize,
  searchOptions: {
    boost: { title: 3, url: 2, domain: 2, description: 1.5, cleanText: 1 },
    prefix: true,
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
    return this.ms.search(query).slice(0, limit).map((r) => ({ id: r.id as string }));
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
