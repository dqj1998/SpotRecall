// Bookmark signal for search (feature 2). Bookmarks are a strong user-curated
// importance prior: we mark bookmarked results with an icon and rank them higher.
// The bookmarked-id set is derived on demand (URLs -> normalized -> record id)
// and cached in SW memory, invalidated on any bookmark change — always fresh,
// no schema change, no stored flag to keep in sync.

import { normalizeUrl } from '@shared/url';
import { recordIdFor } from '@shared/hash';

export interface BookmarkItem {
  url: string;
  title: string;
  dateAdded: number;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function walk(nodes: chrome.bookmarks.BookmarkTreeNode[], out: BookmarkItem[]): void {
  for (const n of nodes) {
    if (n.url && isHttpUrl(n.url)) {
      out.push({ url: n.url, title: n.title || n.url, dateAdded: n.dateAdded ?? Date.now() });
    }
    if (n.children) walk(n.children, out);
  }
}

/** All http(s) bookmarks, flattened. */
export async function collectBookmarks(): Promise<BookmarkItem[]> {
  const out: BookmarkItem[] = [];
  try {
    walk(await chrome.bookmarks.getTree(), out);
  } catch {
    /* bookmarks unavailable */
  }
  return out;
}

let cache: Set<string> | null = null;

/** Drop the cached set; next getBookmarkedIds() rebuilds it. */
export function invalidateBookmarks(): void {
  cache = null;
}

/** Set of record ids (sha256(normalizedUrl)) that are currently bookmarked. */
export async function getBookmarkedIds(): Promise<Set<string>> {
  if (cache) return cache;
  const ids = new Set<string>();
  for (const bm of await collectBookmarks()) {
    ids.add(await recordIdFor(normalizeUrl(bm.url)));
  }
  cache = ids;
  return ids;
}
