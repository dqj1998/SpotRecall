// URL normalization for dedup keys. Pure & unit-tested.

const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^yclid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^spm$/i,
  /^scm$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^trk$/i,
];

// Per-request random auth/CSRF/session params. Stripping them collapses the many
// distinct URLs of the SAME login/OAuth page into one dedup id. Deliberately
// conservative: only names that are unambiguously nonces/tokens/correlation ids
// (never page-content selectors), so two genuinely different pages can't collide.
// `state`, `code`, and bare `token` are intentionally NOT listed — too generic.
const VOLATILE_PARAM_PATTERNS: RegExp[] = [
  /^nonce$/i,
  /^sso_nonce$/i,
  /^session_state$/i,
  /^code_challenge$/i,
  /^code_verifier$/i,
  /^client[-_]request[-_]id$/i,
  /^request[-_]?id$/i,
  /^correlation[-_]?id$/i,
  /^_?csrf(_token)?$/i,
  /^xsrf(_token)?$/i,
  /^uaid$/i,
  /^access_token$/i,
  /^id_token$/i,
  /^(login|consent)_challenge$/i,
];

// Sign-in / verification URLs: pages a user passes THROUGH. Their URLs carry
// per-visit tokens (in the path or query), so without collapsing each visit
// becomes its own near-empty record. This is a URL-only signal: it decides the
// dedup key (content is not known yet), while ranking also requires thin
// content (see fusion.ts) so e.g. an OAuth docs page is not demoted.
const AUTH_HOSTS = ['login.microsoftonline.com', 'login.live.com'];
const AUTH_PATH_SEGMENTS = new Set([
  'login',
  'signin',
  'sign-in',
  'sso',
  'oauth',
  'oauth2',
  'authorize',
  'authwall',
  'checkpoint',
  'challenge',
  'two_factor',
  '2fa',
  'mfa',
  'authfinish.srf',
]);

// Where to go AFTER signing in — varies per visit, never identifies the auth step.
const REDIRECT_PARAM = /^(continue|next|followup|redirect|redirect_uri|redirect_url|return_?to|return_?url|session_?redirect)$/i;

/** A per-visit token path segment: long, base64/hex-like, mixes letters and digits. */
function isOpaqueSegment(v: string): boolean {
  return v.length >= 24 && /^[A-Za-z0-9_.~=+/-]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
}

function authSegmentIndex(u: URL): number {
  if (AUTH_HOSTS.includes(u.hostname.toLowerCase())) return 0;
  return u.pathname
    .toLowerCase()
    .split('/')
    .findIndex((seg) => AUTH_PATH_SEGMENTS.has(seg));
}

/** URL looks like a sign-in / security-check / OAuth step (heuristic). */
export function isAuthUrl(raw: string): boolean {
  try {
    return authSegmentIndex(new URL(raw)) >= 0;
  } catch {
    return false;
  }
}

// Params that carry what the user typed (search box, translate input). Their
// values are page content, not noise: never stripped, and indexed as text.
const USER_TEXT_PARAMS = new Set(['q', 'query', 'text', 'search', 'search_query', 'keyword', 'keywords', 'k', 'p', 'wd']);

/** Decoded user-typed text carried in the URL (e.g. Google Translate's `text=`), or ''. */
export function urlUserText(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  const out: string[] = [];
  for (const [k, v] of u.searchParams.entries()) {
    const t = v.replace(/\s+/g, ' ').trim();
    if (USER_TEXT_PARAMS.has(k.toLowerCase()) && t && !out.includes(t)) out.push(t);
  }
  return out.join(' ');
}

/** Page text to store: the URL's user-typed text first (it IS the content of e.g. a
 *  translate page), then the captured body. Idempotent. */
export function withUrlText(url: string, content: string, max = 2000): string {
  const t = urlUserText(url);
  const body = content.replace(/\s+/g, ' ').trim();
  return (t && !body.startsWith(t) ? `${t} ${body}` : body).slice(0, max).trim();
}

/**
 * How `next` relates to `prev` if it looks like the same input being edited: same
 * page and params except one user-text param (typing into an input that mirrors
 * itself into the URL, like Google Translate).
 *  - 'extend':  one value is a prefix of the other (typed / deleted at the end)
 *  - 'rewrite': only the start or end matches (IME composition, "ju shen" -> "具身智能";
 *               inserting at the front, "白色" -> "mu白色")
 * Replacing the whole text usually shares neither, so is a new entry (null).
 */
export function typingStep(prev: string, next: string): 'extend' | 'rewrite' | null {
  let a: URL, b: URL;
  try {
    a = new URL(prev);
    b = new URL(next);
  } catch {
    return null;
  }
  if (a.origin !== b.origin || a.pathname !== b.pathname) return null;
  const pa = [...a.searchParams.entries()];
  const pb = [...b.searchParams.entries()];
  if (pa.map(([k]) => k).sort().join('&') !== pb.map(([k]) => k).sort().join('&')) {
    // Typing into an empty input adds the param: `?sl=en` -> `?sl=en&text=h`.
    const extra = pb.filter(([k]) => !a.searchParams.has(k));
    const added =
      extra.length === 1 &&
      pb.length === pa.length + 1 &&
      USER_TEXT_PARAMS.has(extra[0][0].toLowerCase()) &&
      pa.every(([k, v]) => b.searchParams.get(k) === v);
    return added ? 'extend' : null;
  }
  const diff = pa.filter(([k, v]) => b.searchParams.get(k) !== v);
  if (diff.length !== 1 || !USER_TEXT_PARAMS.has(diff[0][0].toLowerCase())) return null;
  const va = diff[0][1].trim();
  const vb = (b.searchParams.get(diff[0][0]) ?? '').trim();
  if (!va || !vb) return va || vb ? 'extend' : null;
  if (va.startsWith(vb) || vb.startsWith(va)) return 'extend';
  return va[0] === vb[0] || va.at(-1) === vb.at(-1) ? 'rewrite' : null;
}

function isStrippable(key: string): boolean {
  return (
    TRACKING_PARAM_PATTERNS.some((re) => re.test(key)) ||
    VOLATILE_PARAM_PATTERNS.some((re) => re.test(key))
  );
}

/**
 * Produce a stable, dedup-friendly URL string:
 *  - lowercased host
 *  - fragment removed
 *  - tracking + volatile auth/session params stripped, remaining params sorted
 *  - trailing slash on path normalized (but "/" kept)
 *  - on sign-in URLs, per-visit tokens (opaque path segments, digit-bearing values)
 *    and redirect targets are dropped too, so each sign-in step shares one id
 * Non-http(s) URLs are returned lowercased-origin best-effort.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  u.protocol = u.protocol.toLowerCase();

  const auth = authSegmentIndex(u);
  if (auth >= 0) {
    // Drop per-visit token segments after the auth keyword (e.g. /checkpoint/challenge/<token>).
    u.pathname = u.pathname
      .split('/')
      .filter((seg, i) => i <= auth || !isOpaqueSegment(seg))
      .join('/');
  }

  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (isStrippable(k)) continue;
    // On sign-in steps, also drop redirect targets and any value with a digit (tokens,
    // session ids, timestamps); word-only values (mkt=zh-CN, app_domain=…) stay.
    if (auth >= 0 && !USER_TEXT_PARAMS.has(k.toLowerCase()) && (REDIRECT_PARAM.test(k) || /\d/.test(v))) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Normalize a bare trailing slash on the root only; keep meaningful trailing slashes off.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}
