import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers';
import { mergeRecord, exportBackup, importBackup } from '../src/storage/backup';
import { planTidy } from '../src/storage/tidy';
import { normalizeUrl } from '../src/shared/url';
import { zipSync, strToU8 } from 'fflate';
import { upsertProvisional, commitRecord, getRecord, recordCount } from '../src/storage/dao';
import type { PageRecord } from '../src/shared/types';

beforeEach(() => resetDb());

function rec(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: 'a',
    url: 'https://x.com/a',
    normalizedUrl: 'https://x.com/a',
    title: 't',
    domain: 'x.com',
    description: '',
    cleanText: 'body',
    contentHash: 'h',
    status: 'committed',
    firstSeen: 100,
    lastVisited: 200,
    committedVisits: 1,
    embedModelId: null,
    ...overrides,
  };
}

describe('mergeRecord idempotency (dev plan §7.3, P0-3)', () => {
  it('merging a record with itself is a no-op (idempotent)', () => {
    const r = rec({});
    const merged = mergeRecord(r, r);
    expect(merged.committedVisits).toBe(1); // NOT summed
    expect(merged).toEqual(r);
  });

  it('uses MAX/MIN, never sum', () => {
    const local = rec({ firstSeen: 100, lastVisited: 200, committedVisits: 3 });
    const incoming = rec({ firstSeen: 50, lastVisited: 300, committedVisits: 2 });
    const merged = mergeRecord(local, incoming);
    expect(merged.firstSeen).toBe(50);
    expect(merged.lastVisited).toBe(300);
    expect(merged.committedVisits).toBe(3);
  });

  it('committed status dominates provisional', () => {
    const local = rec({ status: 'provisional', committedVisits: 0 });
    const incoming = rec({ status: 'committed', committedVisits: 1, lastVisited: 50 });
    expect(mergeRecord(local, incoming).status).toBe('committed');
  });

  it('newer content wins by lastVisited', () => {
    const local = rec({ cleanText: 'old', lastVisited: 100 });
    const incoming = rec({ cleanText: 'new', lastVisited: 200 });
    expect(mergeRecord(local, incoming).cleanText).toBe('new');
  });

  it('keeps a known language when a newer legacy record has none', () => {
    const local = rec({ language: 'ja', lastVisited: 100 });
    const incoming = rec({ lastVisited: 200 });

    expect(mergeRecord(local, incoming).language).toBe('ja');
  });
});

describe('backup round-trip idempotency (dev plan §11.3-9)', () => {
  it('importing the same ZIP twice leaves records byte-identical', async () => {
    const now = 1_000_000;
    await upsertProvisional({
      id: 'a', url: 'https://x.com/a', normalizedUrl: 'https://x.com/a',
      title: 't', domain: 'x.com', description: '', now,
    });
    await commitRecord({ id: 'a', cleanText: 'body', contentHash: 'h', now, firstCommitForInstance: true });

    const before = await getRecord('a');
    const blob = await exportBackup(false, 'dev1');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const first = await importBackup(bytes);
    expect(first.imported).toBe(1);
    const afterFirst = await getRecord('a');

    await importBackup(bytes); // second import
    const afterSecond = await getRecord('a');

    expect(afterFirst).toEqual(before);
    expect(afterSecond).toEqual(before);
    expect(await recordCount()).toBe(1);
  });

  it('re-import does not inflate committedVisits', async () => {
    const now = 2_000_000;
    await upsertProvisional({
      id: 'b', url: 'https://x.com/b', normalizedUrl: 'https://x.com/b',
      title: 't', domain: 'x.com', description: '', now,
    });
    await commitRecord({ id: 'b', cleanText: 'body', contentHash: 'h', now, firstCommitForInstance: true });

    const blob = await exportBackup(false, 'dev1');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await importBackup(bytes);
    await importBackup(bytes);
    await importBackup(bytes);
    expect((await getRecord('b'))?.committedVisits).toBe(1);
  });
});

describe('planTidy: re-key (dedup-key migration)', () => {
  const challenge = (token: string, o: Partial<PageRecord>) =>
    rec({
      id: token,
      url: `https://www.linkedin.com/checkpoint/challenge/${token}?ut=2YMt8ZZ`,
      normalizedUrl: `https://www.linkedin.com/checkpoint/challenge/${token}?ut=2YMt8ZZ`,
      title: 'Security Verification | LinkedIn',
      domain: 'www.linkedin.com',
      ...o,
    });

  it('merges records whose URLs now collapse to one key', async () => {
    const a = challenge('AgEUlznZvRqHDgAAAaDynWgqPrwd1', { cleanText: 'quick check', lastVisited: 300, firstSeen: 10 });
    const b = challenge('AgGj3sL0Lr23QAAAaDyYK8gMuM12', { cleanText: '', contentHash: '', status: 'provisional', lastVisited: 500, firstSeen: 50 });
    const { remove, put } = await planTidy([a, b, rec({})]);
    expect(remove.sort()).toEqual([a.id, b.id].sort());
    expect(put).toHaveLength(1);
    const [to] = put;
    expect(to.normalizedUrl).toBe('https://www.linkedin.com/checkpoint/challenge');
    expect(to.lastVisited).toBe(500);
    expect(to.firstSeen).toBe(10);
    expect(to.status).toBe('committed');
    expect(to.cleanText).toBe('quick check'); // newest had no text; kept the older body
  });

  it('import re-keys a backup made under older rules', async () => {
    const a = challenge('AgEUlznZvRqHDgAAAaDynWgqPrwd1', {});
    const b = challenge('AgGj3sL0Lr23QAAAaDyYK8gMuM12', {});
    const zip = zipSync({
      'meta.json': strToU8(JSON.stringify({ backupSchemaVersion: 1, modelId: 'm', modelDim: 1, includesVectors: false })),
      'records.ndjson': strToU8([a, b].map((r) => JSON.stringify(r)).join('\n')),
    });
    await importBackup(zip);
    expect(await recordCount()).toBe(1);
    expect(await getRecord(a.id)).toBeUndefined();
  });
});

describe('planTidy: typing intermediates and URL text', () => {
  const tr = (text: string, firstSeen: number, o: Partial<PageRecord> = {}) => {
    const url = `https://translate.google.com/?sl=zh-CN&tl=ja&text=${encodeURIComponent(text)}&op=translate`;
    return rec({ id: text, url, normalizedUrl: normalizeUrl(url), domain: 'translate.google.com', title: 'Google 翻訳', cleanText: 'テキスト翻訳', firstSeen, lastVisited: firstSeen, ...o });
  };

  it('keeps the final state of each input, and every separate translation', async () => {
    const { remove } = await planTidy([
      tr('g', 0),
      tr('g qin', 2_000, { committedVisits: 3 }), // typed back over it: visit count doesn't matter
      tr('钢琴', 5_000), // IME conversion of "g qin": shares neither start nor end -> kept
      tr('钢', 6_000), // backspace right after: "钢琴" was an intermediate
      tr('单人床', 600_000), // a new translation
      tr('单人床x', 600_000 + 3 * 60_000), // extended long after: the earlier one stays
    ]);
    expect(remove.sort()).toEqual(['g', '钢琴'].sort());
  });

  it('keeps an old translation reopened and edited later', async () => {
    const { remove } = await planTidy([tr('Gardening', 0), tr('Gardening tools', 10 * 86_400_000)]);
    expect(remove).toEqual([]);
  });

  it('folds URL text into committed records and re-queues them', async () => {
    const { put } = await planTidy([tr('木质五斗橱', 0)]);
    expect(put[0].cleanText).toBe('木质五斗橱 テキスト翻訳');
    expect(put[0].embedModelId).toBeNull();
    expect(put[0].contentHash).not.toBe('h');
  });

  it('is idempotent', async () => {
    const first = await planTidy([tr('a', 0), tr('ab', 1_000), tr('单人床', 600_000)]);
    const rm = new Set(first.remove);
    const after = [tr('a', 0), tr('ab', 1_000), tr('单人床', 600_000)]
      .filter((r) => !rm.has(r.id))
      .map((r) => first.put.find((p) => p.id === r.id) ?? r);
    expect(await planTidy(after)).toEqual({ remove: [], put: [] });
  });
});

