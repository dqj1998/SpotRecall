// Group hits into timeline buckets by lastVisited. Pure & unit-tested.

import type { SearchHit, TimelineBucket } from '@shared/types';

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketByTime(hits: SearchHit[], now = Date.now()): TimelineBucket[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY;
  const weekStart = todayStart - 6 * DAY; // last 7 days incl. today

  const buckets: Record<TimelineBucket['key'], SearchHit[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };

  for (const h of hits) {
    if (h.lastVisited >= todayStart) buckets.today.push(h);
    else if (h.lastVisited >= yesterdayStart) buckets.yesterday.push(h);
    else if (h.lastVisited >= weekStart) buckets.week.push(h);
    else buckets.older.push(h);
  }

  const labels: Record<TimelineBucket['key'], string> = {
    today: '今天',
    yesterday: '昨天',
    week: '本周',
    older: '更早',
  };

  const order: TimelineBucket['key'][] = ['today', 'yesterday', 'week', 'older'];
  return order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: labels[key], items: buckets[key] }));
}
