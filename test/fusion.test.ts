import { describe, it, expect } from 'vitest';
import { fuseVariants, recordPrior, FUSION_PARAMS } from '@search/fusion';
import { coversAllTerms, queryTerms } from '@search/bm25';

describe('coversAllTerms', () => {
  it('requires every term, with the search prefix rule', () => {
    expect(coversAllTerms('熊猫直播 https://live.ipanda.com/', queryTerms('熊猫直播'))).toBe(true);
    expect(coversAllTerms('Japan Patent Office', queryTerms('japan patent'))).toBe(true);
    expect(coversAllTerms('Japan Patent Office', queryTerms('japan pat'))).toBe(true); // prefix ≥ 3
    expect(coversAllTerms('买手网，您身边的网购帮手', queryTerms('门牌 网购'))).toBe(false);
    expect(coversAllTerms('anything', [])).toBe(false);
  });
});

describe('recordPrior (title-only records)', () => {
  const provisional = { status: 'provisional', title: '买手网，您身边的网购帮手', url: 'https://www.maishou.com/' };
  const committed = { ...provisional, status: 'committed' };

  it('penalizes a title-only record that shares only a stray term', () => {
    expect(recordPrior(provisional, [queryTerms('门牌 网购')])).toBe(FUSION_PARAMS.contentlessWeight);
  });

  it('keeps a title-only record that matches every term of some variant', () => {
    expect(recordPrior(provisional, [queryTerms('门牌 网购'), queryTerms('网购帮手')])).toBe(1);
  });

  it('never touches records with captured content, or when disabled', () => {
    expect(recordPrior(committed, [queryTerms('门牌 网购')])).toBe(1);
    expect(recordPrior(provisional, [queryTerms('门牌 网购')], { contentlessWeight: 1, interstitialWeight: 1, interstitialMaxChars: 1000 })).toBe(1);
  });
});

describe('recordPrior (auth interstitials)', () => {
  const page = { status: 'committed', title: 'Security Verification | LinkedIn', url: 'https://www.linkedin.com/checkpoint/challenge' };

  it('demotes sign-in / security-check pages, even with content', () => {
    expect(recordPrior(page, [queryTerms('linkedin')])).toBe(FUSION_PARAMS.interstitialWeight);
  });

  it('stacks with the contentless prior', () => {
    const p = recordPrior({ ...page, status: 'provisional' }, [queryTerms('chrome dashboard')]);
    expect(p).toBeCloseTo(FUSION_PARAMS.interstitialWeight * FUSION_PARAMS.contentlessWeight);
  });

  it('does not demote a sign-in URL with real content (e.g. OAuth docs)', () => {
    const docs = { status: 'committed', title: 'OAuth 2.0', url: 'https://developers.example.com/identity/oauth2', cleanText: 'x'.repeat(1500) };
    expect(recordPrior(docs, [queryTerms('oauth')])).toBe(1);
  });

  it('leaves ordinary pages alone', () => {
    expect(recordPrior({ ...page, url: 'https://www.linkedin.com/feed' }, [queryTerms('linkedin')])).toBe(1);
  });
});

describe('fuseVariants', () => {
  it('weights translations below the original query', () => {
    // Same rank in each list: the original variant's top hit must win.
    const fused = fuseVariants([['orig'], ['trans']], [null, null]);
    expect(fused.map((f) => f.id)).toEqual(['orig', 'trans']);
  });

  it('trims weak vector hits before fusing', () => {
    const fused = fuseVariants([[]], [[{ id: 'a', score: 0.9 }, { id: 'weak', score: 0.7 }]]);
    expect(fused.map((f) => f.id)).toEqual(['a']);
  });
});
