// Core persistent data model. `records` is the single source of truth.

export type RecordStatus = 'provisional' | 'committed';

export interface PageRecord {
  /** sha256(normalizedUrl) first 16 bytes hex — dedup key across visits/tabs. */
  id: string;
  url: string;
  normalizedUrl: string;
  title: string;
  domain: string;
  description: string;
  favicon?: string;
  /** Cleaned visible text, capped at 2000 chars. Empty until committed. */
  cleanText: string;
  /** sha256(cleanText); re-embed only when this changes. */
  contentHash: string;
  status: RecordStatus;
  firstSeen: number;
  lastVisited: number;
  /** Number of distinct commits. Merged via MAX (never summed) — see backup. */
  committedVisits: number;
  /** Model id whose embedding is stored; null until embedded. */
  embedModelId: string | null;
}

export interface VectorRecord {
  id: string;
  dim: number;
  /** int8 symmetric quantization, zero_point == 0. */
  q: number[];
  scale: number;
  modelId: string;
}

export interface PendingEmbed {
  id: string;
  enqueuedAt: number;
}

export type EventType =
  | 'palette_open'
  | 'query_input'
  | 'results_shown'
  | 'result_click'
  | 'open_attempt'
  | 'open_success'
  | 'palette_close';

export interface EventRecord {
  seq?: number;
  ts: number;
  type: EventType;
  sessionId: string;
  queryId?: string;
  payload?: Record<string, unknown>;
}

export interface TimelineBucket {
  key: 'today' | 'yesterday' | 'week' | 'older';
  label: string;
  items: SearchHit[];
}

export interface SearchHit {
  id: string;
  url: string;
  title: string;
  domain: string;
  description: string;
  /** Short content excerpt shown under the title (2-line clamp; full text in tooltip). */
  snippet: string;
  favicon?: string;
  lastVisited: number;
  score: number;
  /** URL is in the user's bookmarks — surfaced with an icon and ranked higher. */
  isBookmark?: boolean;
}

export interface IndexStatus {
  total: number;
  pending: number;
  paused: boolean;
  semanticEnabled: boolean;
}

export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  modelId: 'modelId',
  modelDim: 'modelDim',
  sourceDeviceId: 'sourceDeviceId',
  persistGranted: 'persistGranted',
  paused: 'paused',
  blacklist: 'blacklist',
  retentionLimit: 'retentionLimit',
  semanticEnabled: 'semanticEnabled',
} as const;
