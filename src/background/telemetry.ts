import { addEvent } from '@storage/dao';
import type { EventRecord, EventType } from '@shared/types';

const sessionId = crypto.randomUUID();

export function logEvent(
  type: EventType,
  queryId?: string,
  payload?: Record<string, unknown>,
): void {
  const ev: EventRecord = { ts: Date.now(), type, sessionId, queryId, payload };
  void addEvent(ev).catch(() => {});
}
