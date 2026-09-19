// SHA-256 helpers via Web Crypto (available in SW & offscreen).

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

/** Dedup id = first 16 bytes (32 hex chars) of sha256(normalizedUrl). */
export async function recordIdFor(normalizedUrl: string): Promise<string> {
  return (await sha256Hex(normalizedUrl)).slice(0, 32);
}
