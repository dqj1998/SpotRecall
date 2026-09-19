import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '@shared/url';

describe('normalizeUrl', () => {
  it('strips tracking params and fragment, lowercases host', () => {
    expect(normalizeUrl('https://Example.com/Path?utm_source=x&id=5#frag')).toBe(
      'https://example.com/Path?id=5',
    );
  });

  it('sorts remaining query params for stable dedup', () => {
    const a = normalizeUrl('https://x.com/p?b=2&a=1');
    const b = normalizeUrl('https://x.com/p?a=1&b=2');
    expect(a).toBe(b);
  });

  it('removes multiple tracking families', () => {
    expect(normalizeUrl('https://x.com/?gclid=1&fbclid=2&spm=3&q=keep')).toBe(
      'https://x.com/?q=keep',
    );
  });

  it('normalizes trailing slash on non-root paths', () => {
    expect(normalizeUrl('https://x.com/a/b/')).toBe('https://x.com/a/b');
    expect(normalizeUrl('https://x.com/')).toBe('https://x.com/');
  });

  it('same URL with different tracking yields identical key', () => {
    const a = normalizeUrl('https://github.com/o/r/issues/5?utm_campaign=a');
    const b = normalizeUrl('https://github.com/o/r/issues/5');
    expect(a).toBe(b);
  });

  it('is a no-op-ish for non-URLs', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});
