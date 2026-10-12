// Bulk record cleanup when capture/dedup rules change: applied once on update
// and after every backup import, so stored data matches what capture produces now.
//  1. re-key records whose normalizedUrl changed, merging those that now share an id
//     (e.g. many visits to one sign-in step);
//  2. fold the URL's user-typed text into the stored page text (withUrlText);
//  3. drop keystroke intermediates (typing into a URL-mirrored input, isTypingStep).

import { allRecords, replaceRecords } from './dao';
import { normalizeUrl, withUrlText, typingStep } from '@shared/url';
import { recordIdFor, sha256Hex } from '@shared/hash';
import type { PageRecord } from '@shared/types';

/**
 * Idempotent field-wise merge of two records for the same id.
 * MAX/MIN only — committedVisits is MAX (never summed) so re-import is a no-op.
 */
export function mergeRecord(local: PageRecord | undefined, incoming: PageRecord): PageRecord {
  if (!local) return { ...incoming };
  const newer = incoming.lastVisited > local.lastVisited ? incoming : local;
  return {
    ...newer,
    id: local.id,
    firstSeen: Math.min(local.firstSeen, incoming.firstSeen),
    lastVisited: Math.max(local.lastVisited, incoming.lastVisited),
    committedVisits: Math.max(local.committedVisits, incoming.committedVisits),
    language: newer.language ?? local.language ?? incoming.language,
    // status: committed dominates provisional
    status: local.status === 'committed' || incoming.status === 'committed' ? 'committed' : newer.status,
  };
}

// How long a superseded input state may have lived and still count as a keystroke
// intermediate. Typing back over a state revisits it, so visit counts say nothing;
// age does: a translation reopened days later and edited keeps its old record.
// Rewrites (IME composition) come in quick succession; a slow one that only
// shares the first/last character is more likely a new entry.
export const TYPING_EXTEND_MAX_AGE_MS = 2 * 60_000;
export const TYPING_REWRITE_MAX_AGE_MS = 60_000;

/** True if `prev` was only a transient state on the way to `nextUrl` (seen at `nextSeen`). */
export function isTypingIntermediate(prev: PageRecord, nextUrl: string, nextSeen: number): boolean {
  const step = typingStep(prev.url, nextUrl);
  const age = nextSeen - prev.firstSeen;
  if (step === 'extend') return age <= TYPING_EXTEND_MAX_AGE_MS;
  if (step === 'rewrite') return age <= TYPING_REWRITE_MAX_AGE_MS;
  return false;
}

export interface TidyPlan {
  remove: string[];
  put: PageRecord[];
}

/** Pure apart from hashing; exported for tests. */
export async function planTidy(records: PageRecord[]): Promise<TidyPlan> {
  const live = new Map(records.map((r) => [r.id, r]));
  const removed = new Set<string>();
  const dirty = new Set<string>();
  const drop = (id: string) => {
    live.delete(id);
    dirty.delete(id);
    removed.add(id);
  };

  // 1. Re-key.
  const groups = new Map<string, { normalizedUrl: string; members: PageRecord[] }>();
  for (const r of records) {
    const normalizedUrl = normalizeUrl(r.url);
    if (normalizedUrl === r.normalizedUrl) continue;
    const id = await recordIdFor(normalizedUrl);
    const g = groups.get(id) ?? { normalizedUrl, members: [] };
    g.members.push(r);
    groups.set(id, g);
  }
  for (const [id, { normalizedUrl, members }] of groups) {
    const target = live.get(id);
    const all = target && !members.includes(target) ? [target, ...members] : members;
    let merged = all.reduce<PageRecord | undefined>((acc, r) => mergeRecord(acc, r), undefined)!;
    // mergeRecord takes the newest record wholesale; keep text if only an older one has it.
    if (!merged.cleanText) {
      const withText = all.filter((r) => r.cleanText).sort((a, b) => b.lastVisited - a.lastVisited)[0];
      if (withText) merged = { ...merged, cleanText: withText.cleanText, contentHash: withText.contentHash };
    }
    for (const m of members) if (m.id !== id) drop(m.id);
    // Vectors were keyed by the old ids: re-embed.
    live.set(id, { ...merged, id, normalizedUrl, embedModelId: null });
    removed.delete(id);
    dirty.add(id);
  }

  // 2. Typing intermediates: per page, in order of appearance.
  const byPage = new Map<string, PageRecord[]>();
  for (const r of live.values()) {
    try {
      const u = new URL(r.url);
      const key = u.origin + u.pathname;
      byPage.set(key, [...(byPage.get(key) ?? []), r]);
    } catch {
      /* not a URL */
    }
  }
  for (const list of byPage.values()) {
    list.sort((a, b) => a.firstSeen - b.firstSeen);
    for (let i = 0; i + 1 < list.length; i++) {
      if (isTypingIntermediate(list[i], list[i + 1].url, list[i + 1].firstSeen)) drop(list[i].id);
    }
  }

  // 3. URL text into page text.
  for (const r of live.values()) {
    if (r.status !== 'committed') continue;
    const cleanText = withUrlText(r.url, r.cleanText);
    if (cleanText === r.cleanText) continue;
    live.set(r.id, { ...r, cleanText, contentHash: cleanText ? await sha256Hex(cleanText) : '', embedModelId: null });
    dirty.add(r.id);
  }

  return { remove: [...removed], put: [...dirty].map((id) => live.get(id)!) };
}

/** Apply planTidy to the store. Returns removed ids (callers drop them from caches). */
export async function tidyAllRecords(): Promise<string[]> {
  const { remove, put } = await planTidy(await allRecords());
  await replaceRecords(remove, put);
  return remove;
}
