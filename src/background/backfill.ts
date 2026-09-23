// One-time metadata backfill (feature 1, "zero-network core"). Seeds
// keyword-searchable records from the user's existing bookmarks and open tabs
// using only locally-available title/URL — no page fetching, no embedding, no
// new sensitive permission. Visiting a backfilled URL later upgrades it to a
// full committed record via the normal capture path (same normalized-URL id).

import { normalizeUrl, domainOf } from '@shared/url';
import { recordIdFor } from '@shared/hash';
import { backfillRecords } from '@storage/dao';
import { resetBm25 } from './bm25-manager';
import { collectBookmarks, type BookmarkItem } from './bookmarks';

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

interface RawItem {
  url: string;
  title: string;
  ts: number;
}

async function prepare(raw: RawItem[]): Promise<
  { id: string; url: string; normalizedUrl: string; title: string; domain: string; ts: number }[]
> {
  const out = [];
  for (const it of raw) {
    if (!isHttpUrl(it.url)) continue;
    const normalizedUrl = normalizeUrl(it.url);
    out.push({
      id: await recordIdFor(normalizedUrl),
      url: it.url,
      normalizedUrl,
      title: it.title,
      domain: domainOf(it.url),
      ts: it.ts,
    });
  }
  return out;
}

/** Seed records for all current bookmarks + open tabs. Safe to call repeatedly. */
export async function runBackfill(): Promise<number> {
  const raw: RawItem[] = [];

  for (const bm of await collectBookmarks()) {
    raw.push({ url: bm.url, title: bm.title, ts: bm.dateAdded });
  }

  try {
    const now = Date.now();
    for (const tab of await chrome.tabs.query({})) {
      const url = tab.url || tab.pendingUrl || '';
      if (!url || tab.incognito) continue;
      raw.push({ url, title: tab.title || url, ts: now });
    }
  } catch {
    /* tabs unavailable */
  }

  const created = await backfillRecords(await prepare(raw));
  if (created > 0) await resetBm25();
  return created;
}

/** Seed a single newly-created bookmark. */
export async function backfillOneBookmark(item: BookmarkItem): Promise<void> {
  const created = await backfillRecords(await prepare([{ url: item.url, title: item.title, ts: item.dateAdded }]));
  if (created > 0) await resetBm25();
}
