// Capture lifecycle orchestration (dev plan §3). The SW is the sole authority:
// it reads identity from the MessageSender, enforces the privacy gate, dedups by
// normalized-URL id, and GCs by page-instance refCount (never by URL key).

import { normalizeUrl, domainOf } from '@shared/url';
import { recordIdFor, sha256Hex } from '@shared/hash';
import {
  upsertProvisional,
  commitRecord,
  gcProvisional,
  isPaused,
  getBlacklist,
} from '@storage/dao';
import {
  registerProvisional,
  isCurrentDocument,
  markCommitted,
  releaseFrame,
  releaseTab,
} from './instances';
import { bm25Upsert, bm25Remove } from './bm25-manager';
import { vectorRemove } from './offscreen-manager';
import { drainQueue } from './embed-queue';

function domainBlacklisted(domain: string, blacklist: string[]): boolean {
  return blacklist.some((b) => {
    const d = b.trim().toLowerCase();
    return d && (domain === d || domain.endsWith(`.${d}`));
  });
}

/** Returns true if capture should proceed; false means send STOP_CAPTURE. */
export async function shouldCapture(sender: chrome.runtime.MessageSender, domain: string): Promise<boolean> {
  if (sender.tab?.incognito) return false;
  if (await isPaused()) return false;
  const blacklist = await getBlacklist();
  if (domainBlacklisted(domain, blacklist)) return false;
  return true;
}

async function gcAll(ids: string[]): Promise<void> {
  for (const id of ids) {
    const deleted = await gcProvisional(id);
    if (deleted) {
      await bm25Remove(id);
      await vectorRemove([id]).catch(() => {});
    }
  }
}

export async function handleInit(
  sender: chrome.runtime.MessageSender,
  data: { url: string; title: string; description: string; domain: string },
): Promise<{ stop: boolean }> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { stop: true };
  const frameId = sender.frameId ?? 0;
  const domain = data.domain || domainOf(data.url);

  if (!(await shouldCapture(sender, domain))) return { stop: true };

  const normalizedUrl = normalizeUrl(data.url);
  const id = await recordIdFor(normalizedUrl);
  const now = Date.now();

  const displaced = registerProvisional(tabId, frameId, sender.documentId, id);
  await gcAll(displaced);

  const rec = await upsertProvisional({
    id,
    url: data.url,
    normalizedUrl,
    title: data.title,
    domain,
    description: data.description,
    now,
  });
  await bm25Upsert(rec);
  return { stop: false };
}

export async function handleCommit(
  sender: chrome.runtime.MessageSender,
  data: { url: string; content: string },
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const frameId = sender.frameId ?? 0;

  // Reject stale messages from a superseded document.
  if (!isCurrentDocument(tabId, frameId, sender.documentId)) return;

  const normalizedUrl = normalizeUrl(data.url);
  const id = await recordIdFor(normalizedUrl);
  const cleanText = data.content.slice(0, 2000);
  const contentHash = cleanText ? await sha256Hex(cleanText) : '';
  const firstCommit = markCommitted(tabId, frameId);

  const result = await commitRecord({
    id,
    cleanText,
    contentHash,
    now: Date.now(),
    firstCommitForInstance: firstCommit,
  });
  if (!result) return;
  await bm25Upsert(result.record);
  if (result.contentChanged) void drainQueue();
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  await gcAll(releaseTab(tabId));
}

export async function handleFrameGone(tabId: number, frameId: number): Promise<void> {
  const id = releaseFrame(tabId, frameId);
  if (id) await gcAll([id]);
}
