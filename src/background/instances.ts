// Page-instance table (dev plan §3). Distinguishes a *page instance*
// (${tabId}:${frameId} + documentId) from a *content record* (dedup by URL).
// GC targets instances via refCount, never the shared record key directly.
//
// This is SW-memory state; the persisted records store never depends on it.
// SPA route changes keep the same documentId, so a route change is detected by
// a changed recordId within the same instance.

interface Instance {
  recordId: string;
  documentId?: string;
  committedByThis: boolean;
}

const instances = new Map<string, Instance>(); // key `${tabId}:${frameId}`
const refCount = new Map<string, number>(); // recordId -> live instances

function keyOf(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

function acquire(recordId: string): void {
  refCount.set(recordId, (refCount.get(recordId) ?? 0) + 1);
}

/** Returns true if refCount for recordId dropped to zero (GC candidate). */
function release(recordId: string): boolean {
  const n = (refCount.get(recordId) ?? 0) - 1;
  if (n <= 0) {
    refCount.delete(recordId);
    return true;
  }
  refCount.set(recordId, n);
  return false;
}

/**
 * Register/refresh the instance for a provisional record. Returns recordIds
 * whose refCount hit zero as a result of displacement (GC candidates).
 */
export function registerProvisional(
  tabId: number,
  frameId: number,
  documentId: string | undefined,
  recordId: string,
): string[] {
  const key = keyOf(tabId, frameId);
  const gc: string[] = [];
  const prev = instances.get(key);
  if (prev) {
    const docChanged = prev.documentId !== documentId;
    if (prev.recordId !== recordId) {
      if (release(prev.recordId)) gc.push(prev.recordId);
      acquire(recordId);
    }
    // reload of same URL (recordId same, new document) -> allow re-commit
    instances.set(key, {
      recordId,
      documentId,
      committedByThis: prev.recordId === recordId && !docChanged ? prev.committedByThis : false,
    });
  } else {
    acquire(recordId);
    instances.set(key, { recordId, documentId, committedByThis: false });
  }
  return gc;
}

/** Validate that a message came from the current live document for this frame. */
export function isCurrentDocument(
  tabId: number,
  frameId: number,
  documentId: string | undefined,
): boolean {
  const inst = instances.get(keyOf(tabId, frameId));
  if (!inst) return false;
  // If we never recorded a documentId, accept (older Chrome path); otherwise must match.
  if (inst.documentId === undefined || documentId === undefined) return true;
  return inst.documentId === documentId;
}

export function currentRecordId(tabId: number, frameId: number): string | undefined {
  return instances.get(keyOf(tabId, frameId))?.recordId;
}

/** Mark committed; returns true if this is the first commit for the instance. */
export function markCommitted(tabId: number, frameId: number): boolean {
  const inst = instances.get(keyOf(tabId, frameId));
  if (!inst) return false;
  if (inst.committedByThis) return false;
  inst.committedByThis = true;
  return true;
}

/** Release one frame. Returns the recordId to GC-check, or null. */
export function releaseFrame(tabId: number, frameId: number): string | null {
  const key = keyOf(tabId, frameId);
  const inst = instances.get(key);
  if (!inst) return null;
  instances.delete(key);
  return release(inst.recordId) ? inst.recordId : null;
}

/** Release all frames of a tab. Returns recordIds to GC-check. */
export function releaseTab(tabId: number): string[] {
  const gc: string[] = [];
  for (const key of [...instances.keys()]) {
    if (key.startsWith(`${tabId}:`)) {
      const inst = instances.get(key)!;
      instances.delete(key);
      if (release(inst.recordId)) gc.push(inst.recordId);
    }
  }
  return gc;
}

/** Test-only reset. */
export function __resetInstances(): void {
  instances.clear();
  refCount.clear();
}
