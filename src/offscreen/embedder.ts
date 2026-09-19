// Transformers.js embedder. e5 requires "query:"/"passage:" prefixes.
//
// Model loading strategy — supports BOTH:
//   1. Bundled/offline: if `npm run download-model` baked the model into
//      dist/models, it loads locally (air-gapped/enterprise builds).
//   2. First-run download (default): otherwise it downloads once from the model
//      host and caches to the browser Cache API, then works offline forever.
// User data never leaves the device either way — only the public model is fetched.

import { pipeline, env } from '@huggingface/transformers';
import { MODEL_ID } from '@shared/protocol';

// Loosely typed to avoid Transformers.js's huge option union blowing up tsc.
type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>;

// Try local (bundled) first; fall back to a one-time remote download that is
// then cached in the browser Cache API for offline reuse.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.localModelPath = chrome.runtime.getURL('models/');
// Serve the ONNX Runtime wasm + jsep(.mjs) loader from the extension origin.
// Otherwise the WebGPU backend dynamically imports the .mjs from a CDN, which the
// extension CSP (script-src 'self') blocks. Single-threaded: the offscreen
// document is not cross-origin isolated (no SharedArrayBuffer).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  env.backends.onnx.wasm.numThreads = 1;
}
// Quiet ORT's benign warnings (e.g. "some nodes not assigned to preferred EP",
// which is normal for the WebGPU backend assigning shape ops to CPU).
if (env.backends?.onnx) {
  (env.backends.onnx as { logLevel?: string }).logLevel = 'error';
}

let extractor: Extractor | null = null;
let backend = 'unknown';

export interface LoadProgress {
  status: string;
  file?: string;
  progress?: number; // 0..100
  loaded?: number;
  total?: number;
}

interface PipelineOpts {
  device: string;
  dtype: string;
  progress_callback?: (p: LoadProgress) => void;
  session_options?: { logSeverityLevel?: number };
}
const makePipeline = pipeline as unknown as (
  task: string,
  model: string,
  opts: PipelineOpts,
) => Promise<Extractor>;

export function currentBackend(): string {
  return backend;
}

export function isModelLoaded(): boolean {
  return extractor !== null;
}

export async function loadModel(onProgress?: (p: LoadProgress) => void): Promise<void> {
  if (extractor) return;
  // logSeverityLevel 3 = error: silence benign ORT session warnings.
  const opts: Omit<PipelineOpts, 'device'> = {
    dtype: 'q8',
    progress_callback: onProgress,
    session_options: { logSeverityLevel: 3 },
  };
  // Prefer WebGPU; fall back to WASM.
  try {
    extractor = await makePipeline('feature-extraction', MODEL_ID, { device: 'webgpu', ...opts });
    backend = 'webgpu';
    return;
  } catch (e) {
    console.warn('[SpotRecall] WebGPU unavailable, falling back to WASM', e);
  }
  extractor = await makePipeline('feature-extraction', MODEL_ID, { device: 'wasm', ...opts });
  backend = 'wasm';
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!extractor) throw new Error('model not loaded');
  const output = await extractor(texts, { pooling: 'mean', normalize: false });
  const [n, dim] = output.dims as [number, number];
  const flat = output.data as Float32Array;
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) out.push(flat.slice(i * dim, (i + 1) * dim));
  return out;
}

export function embedPassages(texts: string[]): Promise<Float32Array[]> {
  return embed(texts.map((t) => `passage: ${t}`));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [v] = await embed([`query: ${text}`]);
  return v;
}
