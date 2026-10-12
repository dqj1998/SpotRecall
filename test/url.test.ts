import { describe, it, expect } from 'vitest';
import { normalizeUrl, isAuthUrl, urlUserText, withUrlText, typingStep } from '@shared/url';

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

  it('strips volatile auth/session params so one login page dedupes to one id', () => {
    const a = normalizeUrl(
      'https://login.live.com/oauth20?client_id=app&nonce=AAA&code_challenge=X1&client-request-id=r1&session_state=s1',
    );
    const b = normalizeUrl(
      'https://login.live.com/oauth20?client_id=app&nonce=BBB&code_challenge=X2&client-request-id=r2&session_state=s2',
    );
    expect(a).toBe(b);
    expect(a).toBe('https://login.live.com/oauth20?client_id=app');
  });

  it('strips csrf / correlation / token families', () => {
    expect(
      normalizeUrl('https://x.com/p?csrf_token=1&correlation_id=2&access_token=3&keep=yes'),
    ).toBe('https://x.com/p?keep=yes');
  });

  it('keeps generic content params (state/code) — too ambiguous to strip', () => {
    // These can carry real content; only content-hash dedup (query-time) merges them.
    expect(normalizeUrl('https://x.com/p?state=CA')).toBe('https://x.com/p?state=CA');
    expect(normalizeUrl('https://x.com/p?code=PROMO')).toBe('https://x.com/p?code=PROMO');
  });

  it('collapses sign-in steps: opaque path tokens and digit-bearing / redirect params dropped', () => {
    const a = normalizeUrl(
      'https://www.linkedin.com/checkpoint/challenge/AgEUlznZvRqHDgAAAaDynWgqPrwdKASgGGMBRtchvwAAxfOD_Z30?ut=2YMt8ZZ687qYs1',
    );
    const b = normalizeUrl(
      'https://www.linkedin.com/checkpoint/challenge/AgGj3sL0Lr-23QAAAaDyYK8gMuM17V4LxXSQKeDzN4b-Uh_dtMeG?ut=0UCtNm-fj5qIs1',
    );
    expect(a).toBe(b);
    expect(a).toBe('https://www.linkedin.com/checkpoint/challenge');
    expect(normalizeUrl('https://accounts.google.com/v3/signin/challenge/pwd?TL=ADG-GRS7f&authuser=0')).toBe(
      'https://accounts.google.com/v3/signin/challenge/pwd',
    );
    expect(normalizeUrl('https://login.jpid.pf.japanpost.jp/login?login_challenge=UcIEsrbE')).toBe(
      'https://login.jpid.pf.japanpost.jp/login',
    );
  });

  it('keeps distinct sign-in steps apart and leaves ordinary pages alone', () => {
    expect(normalizeUrl('https://accounts.google.com/v3/signin/challenge/selection?TL=x')).not.toBe(
      normalizeUrl('https://accounts.google.com/v3/signin/challenge/pwd?TL=x'),
    );
    // Word-only params on a sign-in step still identify it (which app is signing in).
    expect(
      normalizeUrl('https://accounts.google.com/v3/signin/accountchooser?app_domain=https%3A%2F%2Fclaude.ai&dsh=S1795%3A179&continue=https%3A%2F%2Fx'),
    ).toBe('https://accounts.google.com/v3/signin/accountchooser?app_domain=https%3A%2F%2Fclaude.ai');
    // Non-auth pages keep their query, and their token-like path segments (doc ids).
    expect(normalizeUrl('https://github.com/o/r/issues/5?q=login')).toBe('https://github.com/o/r/issues/5?q=login');
    expect(normalizeUrl('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit')).toBe(
      'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
    );
  });

  it('keeps every translation distinct (user text is content, not noise)', () => {
    expect(normalizeUrl('https://translate.google.com/?sl=zh-CN&tl=ja&text=%E9%92%A2%E7%90%B4&op=translate')).not.toBe(
      normalizeUrl('https://translate.google.com/?sl=zh-CN&tl=ja&text=%E5%8D%95%E4%BA%BA%E5%BA%8A&op=translate'),
    );
  });
});

describe('isAuthUrl', () => {
  it('flags sign-in / verification pages', () => {
    for (const u of [
      'https://www.linkedin.com/checkpoint/challenge/AgEU?ut=1',
      'https://www.linkedin.com/authwall?trk=x',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=1',
      'https://accounts.google.com/v3/signin/confirmidentifier?continue=x',
      'https://github.com/login/oauth/select_account',
      'https://www.amazon.co.jp/ap/mfa',
      'https://git.example.com/user/two_factor',
    ])
      expect(isAuthUrl(u), u).toBe(true);
  });

  it('does not flag content pages', () => {
    for (const u of [
      'https://www.linkedin.com/feed/',
      'https://developer.chrome.com/docs/webstore',
      'https://github.com/o/r/issues/5?q=login',
      'https://example.com/blog/how-to-login-faster',
      'not a url',
    ])
      expect(isAuthUrl(u), u).toBe(false);
  });
});

describe('URL user text', () => {
  const tr = (text: string) => `https://translate.google.com/?sl=zh-CN&tl=ja&text=${encodeURIComponent(text)}&op=translate`;

  it('extracts decoded typed text from known params only', () => {
    expect(urlUserText(tr('木质五斗橱'))).toBe('木质五斗橱');
    expect(urlUserText('https://www.google.com/search?q=chrome+store+dev&sca_esv=abc')).toBe('chrome store dev');
    expect(urlUserText('https://x.com/p?id=5')).toBe('');
  });

  it('withUrlText puts typed text first, idempotently', () => {
    const once = withUrlText(tr('钢琴'), 'テキスト翻訳 中国語');
    expect(once).toBe('钢琴 テキスト翻訳 中国語');
    expect(withUrlText(tr('钢琴'), once)).toBe(once);
    expect(withUrlText('https://x.com/a', '  body \n text ')).toBe('body text');
  });

  it('typingStep: extend / rewrite / new entry', () => {
    expect(typingStep('https://translate.google.com/?sl=en', tr('h').replace('sl=zh-CN&tl=ja&', 'sl=en&').replace('&op=translate', ''))).toBe('extend');
    expect(typingStep(tr('These time'), tr('These time slots'))).toBe('extend');
    expect(typingStep(tr('These time slots'), tr('These time'))).toBe('extend'); // backspace
    expect(typingStep(tr('ju shen'), tr('具身zh n'))).toBe('rewrite'); // IME converted the start
    expect(typingStep(tr('具身zh n'), tr('具身智能'))).toBe('rewrite');
    expect(typingStep(tr('白色多斗柜'), tr('mu白色多斗柜'))).toBe('rewrite');
    expect(typingStep(tr('钢琴'), tr('单人床'))).toBe(null);
    // Other params differ (language direction) or a non-text param changes: not typing.
    expect(typingStep(tr('钢琴'), tr('钢琴').replace('tl=ja', 'tl=en'))).toBe(null);
    expect(typingStep('https://x.com/list?page=1', 'https://x.com/list?page=10')).toBe(null);
  });
});

