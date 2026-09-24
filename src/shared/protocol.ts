// Message protocol. Page->SW messages never carry self-reported identity;
// the SW reads the authoritative identity from chrome.runtime.MessageSender.

import type { IndexStatus, TimelineBucket } from './types';

export const MODEL_ID = 'Xenova/multilingual-e5-small';
export const MODEL_DIM = 384;

// ---- Page (content) -> Service Worker ----
export interface InitProvisionalMsg {
  type: 'INIT_PROVISIONAL_RECORD';
  data: { url: string; title: string; description: string; domain: string; lang?: string };
}
export interface CommitPageMsg {
  type: 'COMMIT_PAGE_RECORD';
  data: { url: string; content: string };
}

// ---- Service Worker -> Page (content) ----
export interface SpaNavigatedMsg {
  type: 'SPA_NAVIGATED';
}
export interface StopCaptureMsg {
  type: 'STOP_CAPTURE';
}
export interface TogglePaletteMsg {
  type: 'TOGGLE_PALETTE';
}

// ---- Palette (UI) -> Service Worker ----
export interface SearchQueryMsg {
  type: 'SEARCH_QUERY';
  queryId: string;
  text: string;
}
export interface OpenResultMsg {
  type: 'OPEN_RESULT';
  queryId: string;
  resultVersion: 1 | 2;
  rank: number;
  id: string;
  url: string;
}
export interface GetIndexStatusMsg {
  type: 'GET_INDEX_STATUS';
}
export interface TelemetryMsg {
  type: 'TELEMETRY';
  event: {
    type:
      | 'palette_open'
      | 'query_input'
      | 'results_shown'
      | 'palette_close';
    queryId?: string;
    payload?: Record<string, unknown>;
  };
}

// ---- Service Worker -> Palette (pushed second stage) ----
export interface SearchResultsUpdateMsg {
  type: 'SEARCH_RESULTS_UPDATE';
  queryId: string;
  resultVersion: 2;
  buckets: TimelineBucket[];
}

// ---- Service Worker <-> Offscreen (discriminated by target) ----
export interface EmbedBatchMsg {
  target: 'offscreen';
  type: 'EMBED_BATCH';
  items: { id: string; text: string }[];
}
export interface VectorSearchMsg {
  target: 'offscreen';
  type: 'VECTOR_SEARCH';
  text: string;
  topK: number;
}
export interface VectorRemoveMsg {
  target: 'offscreen';
  type: 'VECTOR_REMOVE';
  ids: string[];
}
export interface OffscreenPingMsg {
  target: 'offscreen';
  type: 'PING';
}
export interface EnsureModelMsg {
  target: 'offscreen';
  type: 'ENSURE_MODEL';
}
export interface ExpandQueryMsg {
  target: 'offscreen';
  type: 'EXPAND_QUERY';
  text: string;
  targets: string[];
}
export interface ScoreAgainstMsg {
  target: 'offscreen';
  type: 'SCORE_AGAINST';
  /** Context signals, each embedded as a `query:` vector. */
  signals: string[];
  /** Candidate document (record) ids to score. */
  ids: string[];
}

export type OffscreenRequest =
  | EmbedBatchMsg
  | VectorSearchMsg
  | VectorRemoveMsg
  | OffscreenPingMsg
  | EnsureModelMsg
  | ExpandQueryMsg
  | ScoreAgainstMsg;

export interface ExpandQueryResult {
  ok: boolean;
  variants: string[]; // original query + available translations (deduped)
}

// UI languages we translate cross-lingual queries into.
export const TRANSLATE_TARGETS = ['en', 'ja', 'zh'];

export interface EmbedBatchResult {
  ok: boolean;
  error?: string;
  vectors: { id: string; q: number[]; scale: number }[];
}
export interface VectorSearchResult {
  ok: boolean;
  error?: string;
  results: { id: string; score: number }[];
}
export interface ScoreAgainstResult {
  ok: boolean;
  error?: string;
  /** Per-id best cosine across all signals; -1 when the id has no stored vector. */
  scores: { id: string; score: number }[];
}
export type ModelState =
  | 'IDLE' // not loaded, not downloaded yet
  | 'DOWNLOADING'
  | 'LOADING_MODEL'
  | 'RESTORING_VECTORS'
  | 'READY'
  | 'ERROR';

export interface OffscreenState {
  ok: boolean;
  state: ModelState;
  backend?: string;
  vectorCount?: number;
  progress?: number; // 0..100 during DOWNLOADING
  currentFile?: string;
  error?: string;
}

// Immediate response to SEARCH_QUERY (stage 1, BM25).
export interface SearchResponse {
  queryId: string;
  resultVersion: 1;
  buckets: TimelineBucket[];
}

export type PageInbound = InitProvisionalMsg | CommitPageMsg;
export type PaletteInbound =
  | SearchQueryMsg
  | OpenResultMsg
  | GetIndexStatusMsg
  | TelemetryMsg;

export type SwResponse = SearchResponse | IndexStatus | { ok: boolean };
