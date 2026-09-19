import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvisional,
  isCurrentDocument,
  markCommitted,
  releaseFrame,
  releaseTab,
  currentRecordId,
  __resetInstances,
} from '../src/background/instances';

beforeEach(() => __resetInstances());

describe('page-instance table (dev plan §3, P0-1 & P0-6)', () => {
  it('same URL in two tabs shares the record; closing one does NOT GC it', () => {
    registerProvisional(1, 0, 'docA', 'rec1');
    registerProvisional(2, 0, 'docB', 'rec1');
    // Tab 1 closes: refCount 2 -> 1, so no GC candidate.
    expect(releaseTab(1)).toEqual([]);
    // Tab 2 closes: refCount 1 -> 0, GC candidate.
    expect(releaseTab(2)).toEqual(['rec1']);
  });

  it('rejects stale messages from a superseded document', () => {
    registerProvisional(1, 0, 'docA', 'rec1');
    expect(isCurrentDocument(1, 0, 'docA')).toBe(true);
    expect(isCurrentDocument(1, 0, 'docOLD')).toBe(false);
  });

  it('SPA route change (same doc, new recordId) releases old record for GC', () => {
    registerProvisional(1, 0, 'docA', 'recOld');
    const gc = registerProvisional(1, 0, 'docA', 'recNew');
    expect(gc).toEqual(['recOld']);
    expect(currentRecordId(1, 0)).toBe('recNew');
  });

  it('committedVisits bump only on first commit per instance', () => {
    registerProvisional(1, 0, 'docA', 'rec1');
    expect(markCommitted(1, 0)).toBe(true);
    expect(markCommitted(1, 0)).toBe(false);
  });

  it('reload (same URL, new document) allows re-commit', () => {
    registerProvisional(1, 0, 'docA', 'rec1');
    markCommitted(1, 0);
    registerProvisional(1, 0, 'docB', 'rec1'); // reload -> new documentId
    expect(markCommitted(1, 0)).toBe(true);
  });

  it('releaseFrame returns GC candidate only when refCount hits zero', () => {
    registerProvisional(1, 0, 'docA', 'rec1');
    registerProvisional(1, 1, 'docF', 'rec1'); // subframe, same record
    expect(releaseFrame(1, 0)).toBeNull();
    expect(releaseFrame(1, 1)).toBe('rec1');
  });
});
