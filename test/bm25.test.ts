import { describe, it, expect } from 'vitest';
import { Bm25Index, queryTerms } from '@search/bm25';
import type { PageRecord } from '@shared/types';

function rec(id: string, title: string, cleanText: string, url = `https://x/${id}`): PageRecord {
  return {
    id,
    url,
    normalizedUrl: url,
    title,
    domain: 'x',
    description: '',
    cleanText,
    contentHash: '',
    status: 'committed',
    firstSeen: 0,
    lastVisited: 0,
    committedVisits: 1,
    embedModelId: null,
  };
}

describe('BM25 CJK tokenization (dev plan §5; ja/zh keyword search)', () => {
  const idx = Bm25Index.fromRecords([
    rec('docomo', 'ドコモ光 10G', '10G の高速インターネット接続サービス。ドコモ光。'),
    rec('other', 'クレジットカード', 'ポイント還元のご案内'),
    rec('zh', '宽带套餐', '10G 千兆光纤宽带上网服务'),
  ]);

  it('short alphanumeric query still hits', () => {
    expect(idx.search('10G').map((h) => h.id)).toContain('docomo');
  });

  it('long Japanese natural-language query hits (was lost with default tokenizer)', () => {
    const ids = idx.search('10Gのインターネット接続サービス').map((h) => h.id);
    expect(ids).toContain('docomo');
    expect(ids[0]).toBe('docomo'); // and ranks first
  });

  it('Chinese multi-word query hits', () => {
    expect(idx.search('宽带上网服务').map((h) => h.id)).toContain('zh');
  });

  it('does not require every term (OR semantics)', () => {
    // "10G" + an absent term should still return the 10G docs.
    expect(idx.search('10G 不存在的词').map((h) => h.id)).toContain('docomo');
  });
});

describe('BM25 query noise (stopwords / short-prefix)', () => {
  const idx = Bm25Index.fromRecords([
    rec('particle', '我的日记', '今天的天气很好，我的心情也很好'),
    rec('office', 'Office 365', 'Microsoft office offers productivity tools'),
    rec('gt', 'Google 翻訳', '単語、フレーズを日本語から翻訳できる'),
  ]);

  it('drops particles like 的 so they do not match unrelated pages', () => {
    expect(queryTerms('Gardening的日语翻译')).toEqual(['Gardening', '日语', '翻译']);
    expect(idx.search('Gardening的日语翻译').map((h) => h.id)).not.toContain('particle');
  });

  it('does not prefix-match short stopwords ("of" ≠ "office")', () => {
    expect(idx.search('Japanese translation of Gardening').map((h) => h.id)).not.toContain('office');
  });

  it('keeps stopwords when the query is nothing but stopwords', () => {
    expect(queryTerms('the')).toEqual(['the']);
  });
});
