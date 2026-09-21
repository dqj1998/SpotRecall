import { describe, it, expect } from 'vitest';
import { bucketByTime } from '@search/timeline';
import type { SearchHit } from '@shared/types';

function hit(id: string, lastVisited: number): SearchHit {
  return { id, url: `https://x/${id}`, title: id, domain: 'x', description: '', snippet: '', lastVisited, score: 1 };
}

describe('bucketByTime', () => {
  const now = new Date('2026-09-19T12:00:00').getTime();
  const DAY = 24 * 60 * 60 * 1000;

  it('sorts hits into today/yesterday/week/older and drops empty buckets', () => {
    const hits = [
      hit('today', now - 60_000),
      hit('yst', now - DAY - 3600_000),
      hit('week', now - 3 * DAY),
      hit('old', now - 30 * DAY),
    ];
    const buckets = bucketByTime(hits, now);
    expect(buckets.map((b) => b.key)).toEqual(['today', 'yesterday', 'week', 'older']);
    expect(buckets[0].items[0].id).toBe('today');
  });

  it('omits buckets with no items', () => {
    const buckets = bucketByTime([hit('t', now)], now);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('today');
  });
});
