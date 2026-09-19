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

const OPTIONS = {
  fields: ['title', 'url', 'domain', 'description', 'cleanText'],
  storeFields: ['id'],
  searchOptions: {
    boost: { title: 3, url: 2, domain: 2, description: 1.5, cleanText: 1 },
    prefix: true,
    fuzzy: 0.1,
    combineWith: 'AND' as const,
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
