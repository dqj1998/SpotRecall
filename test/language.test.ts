import { describe, expect, it } from 'vitest';
import { countRecordLanguages, normalizeLanguageTag, selectLanguageCandidates } from '@shared/language';
import type { PageRecord } from '@shared/types';

function rec(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: 'id',
    url: 'https://example.com',
    normalizedUrl: 'https://example.com',
    title: 'Title',
    domain: 'example.com',
    description: '',
    cleanText: '',
    contentHash: '',
    status: 'provisional',
    firstSeen: 0,
    lastVisited: 0,
    committedVisits: 0,
    embedModelId: null,
    ...overrides,
  };
}

describe('normalizeLanguageTag', () => {
  it('keeps the traditional Chinese script distinction', () => {
    expect(normalizeLanguageTag('zh-TW')).toBe('zh-Hant');
    expect(normalizeLanguageTag('zh-Hant')).toBe('zh-Hant');
  });

  it('reduces ordinary regional tags to their language', () => {
    expect(normalizeLanguageTag('fr-CA')).toBe('fr');
    expect(normalizeLanguageTag('JA-jp')).toBe('ja');
  });

  it('rejects blank and invalid tags', () => {
    expect(normalizeLanguageTag('')).toBeUndefined();
    expect(normalizeLanguageTag('not a language')).toBeUndefined();
  });
});

describe('countRecordLanguages', () => {
  it('counts searchable records using normalized language tags', () => {
    const distribution = countRecordLanguages([
      rec({ id: 'one', language: 'en-US' }),
      rec({ id: 'two', language: 'zh-TW', status: 'committed' }),
      rec({ id: 'three', language: 'zh-Hant', cleanText: 'body' }),
      rec({ id: 'four', title: '', language: 'ja' }),
      rec({ id: 'five', language: 'invalid tag' }),
    ]);

    expect(distribution).toEqual({ counts: { en: 1, 'zh-Hant': 2 }, recordsCounted: 3 });
  });
});

describe('selectLanguageCandidates', () => {
  const options = {
    browserLocale: 'fr-CA',
    fallbackLanguages: ['en', 'ja', 'zh'],
    coldStartRecordThreshold: 5,
    maxCandidates: 6,
  };

  it('uses corpus languages before a browser UI language with no matching pages', () => {
    const candidates = selectLanguageCandidates(
      { counts: { en: 60, ja: 35 }, recordsCounted: 95 },
      options,
    );

    expect(candidates).toEqual(['en', 'ja']);
  });

  it('adds browser and product fallbacks only during cold start', () => {
    const candidates = selectLanguageCandidates({ counts: { en: 1 }, recordsCounted: 1 }, options);

    expect(candidates).toEqual(['en', 'fr', 'ja', 'zh']);
  });

  it('keeps the candidate list bounded without treating it as the translation budget', () => {
    const candidates = selectLanguageCandidates(
      { counts: { en: 6, ja: 5, de: 4, ko: 3, fr: 2, es: 1 }, recordsCounted: 21 },
      { ...options, maxCandidates: 3 },
    );

    expect(candidates).toEqual(['en', 'ja', 'de']);
  });
});