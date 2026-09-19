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
];

function isTracking(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((re) => re.test(key));
}

/**
 * Produce a stable, dedup-friendly URL string:
 *  - lowercased host
 *  - fragment removed
 *  - tracking query params stripped, remaining params sorted
 *  - trailing slash on path normalized (but "/" kept)
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

  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTracking(k)) kept.push([k, v]);
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
