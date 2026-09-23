#!/usr/bin/env node
// OPTIONAL build-time model fetch — for air-gapped / enterprise / fully-offline
// builds. By default the extension does NOT bundle the model: it downloads it
// once at runtime (on user opt-in) and caches it locally. Run this ONLY if you
// want the model baked into the package so the extension needs no network ever:
//   npm run download-model && npm run build
//
// Downloads multilingual-e5-small (q8) + tokenizer into public/models, which
// Vite copies to dist/models. Transformers.js then loads them via localModelPath
// (local is tried before remote), yielding a ~155MB fully-offline package.
//
// Robustness (fixes the 0% panel-download / "SyntaxError: Unexpected end of JSON
// input" failure mode caused by a broken run leaving 0-byte files):
//   * every file is validated: non-empty, size floor, JSON parses and has the
//     required keys (config.json), not an HTTP-proxy HTML stub, Content-Length
//     matches the received bytes (when the header is present).
//   * pre-existing files are RE-validated — a stale 0-byte file from a broken
//     run is re-downloaded instead of trusted as "cached".
//   * downloads go to `<file>.part` and are atomically renamed only after
//     validation passes — a failed run never leaves a corrupt file behind.
//   * transient failures retry up to 3x with exponential backoff and fail loudly
//     (nonzero exit) instead of silently writing bad files.
//
// Env: SR_MODEL_BASE_URL overrides the model host (mirrors/proxies, tests).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_BASE = `https://huggingface.co/${MODEL}/resolve/main`;
export const BASE = process.env.SR_MODEL_BASE_URL ?? DEFAULT_BASE;

export const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

// Size floors (bytes) — ~60% of the real files' sizes, calibrated from
// Xenova/multilingual-e5-small (config 658B, tokenizer_config 443B,
// special_tokens_map 167B, tokenizer ~17MB, onnx ~118MB). Still catches
// 0-byte writes, truncation and proxy error stubs without false positives.
export const DEFAULT_MIN_SIZES = {
  'config.json': 400,
  'tokenizer_config.json': 250,
  'special_tokens_map.json': 100,
  'tokenizer.json': 5_000_000,
  'onnx/model_quantized.onnx': 50_000_000,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML_RE = /^\s*<(?:!doctype|html)/i;

/**
 * Validate downloaded model file content.
 * Returns { ok: true } or { ok: false, reason }.
 * `headers` may be a fetch Response.headers (has .get) or a plain object.
 */
export function validateModelFile(rel, buf, headers = null, opts = {}) {
  if (!buf || buf.length === 0) return { ok: false, reason: 'empty body (0 bytes)' };
  const minSizes = opts.minSizes ?? DEFAULT_MIN_SIZES;
  const min = minSizes[rel] ?? 0;
  if (buf.length < min) {
    return { ok: false, reason: `only ${buf.length} bytes, below the ${min}-byte sanity floor` };
  }
  // A transparent proxy / captive portal answering HTTP 200 with an HTML stub.
  if (HTML_RE.test(buf.toString('latin1').slice(0, 512))) {
    return { ok: false, reason: 'response looks like an HTML page, not a model file (intercepted?)' };
  }
  const contentLength =
    typeof headers?.get === 'function' ? headers.get('content-length') : headers?.['content-length'];
  if (contentLength && !(typeof headers?.get === 'function' ? headers.get('content-encoding') : headers?.['content-encoding'])) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > 0 && n !== buf.length) {
      return { ok: false, reason: `Content-Length says ${n} bytes but ${buf.length} bytes arrived (truncated)` };
    }
  }
  if (rel.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      return { ok: false, reason: `invalid JSON: ${e?.message ?? e}` };
    }
    if (rel === 'config.json') {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, reason: 'config.json is not a JSON object' };
      }
      if (typeof parsed.model_type !== 'string' || parsed.model_type.length === 0) {
        return { ok: false, reason: 'config.json is missing "model_type"' };
      }
      if (!Array.isArray(parsed.architectures) || parsed.architectures.length === 0) {
        return { ok: false, reason: 'config.json is missing "architectures"' };
      }
    }
  }
  return { ok: true };
}

/**
 * Download + validate a single file with retries and exponential backoff.
 * Throws after `attempts` failures; never resolves with an invalid body.
 */
export async function downloadFileWithRetry({
  baseUrl = BASE,
  rel,
  attempts = 3,
  backoffMs = 2_000,
  minSizes = DEFAULT_MIN_SIZES,
  fetchImpl = fetch,
  onAttempt,
  log = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    onAttempt?.(rel, attempt);
    try {
      const res = await fetchImpl(`${baseUrl}/${rel}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const v = validateModelFile(rel, buf, res.headers, { minSizes });
      if (!v.ok) throw new Error(`invalid content: ${v.reason}`);
      return { buf };
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        log(`  retry ${attempt}/${attempts - 1} for ${rel}: ${e?.message ?? e}`);
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(
    `failed to download "${rel}" after ${attempts} attempts (last error: ${lastError?.message ?? lastError})`,
  );
}

/**
 * Ensure a single model file exists and is valid at `dest`.
 * Re-validates any pre-existing file (a stale 0-byte file is re-downloaded);
 * writes via `<dest>.part` and atomically renames only after validation passes.
 */
export async function ensureModelFile({
  baseUrl = BASE,
  rel,
  dest,
  attempts = 3,
  backoffMs = 2_000,
  minSizes = DEFAULT_MIN_SIZES,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  // Re-validate what's already on disk — the old "exists → cached" shortcut let
  // a broken run's 0-byte files poison every later run.
  let existing = null;
  try {
    existing = await readFile(dest);
  } catch {
    // not on disk yet
  }
  if (existing) {
    const v = validateModelFile(rel, existing, null, { minSizes });
    if (v.ok) {
      log(`✓ valid   ${rel} (${(existing.length / 1e6).toFixed(1)} MB)`);
      return;
    }
    log(`! re-downloading ${rel}: existing file is corrupt (${v.reason})`);
  }

  log(`↓ ${rel} … `);
  const start = Date.now();
  const { buf } = await downloadFileWithRetry({ baseUrl, rel, attempts, backoffMs, minSizes, fetchImpl, log });

  // Atomic-ish: never leave a partial file that future runs would trust.
  const part = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(part, buf);
  await rename(part, dest);
  log(`${(buf.length / 1e6).toFixed(1)} MB in ${((Date.now() - start) / 1_000).toFixed(1)}s`);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'models', MODEL);

export async function main() {
  console.log(`Fetching ${MODEL} into ${OUT}${BASE !== DEFAULT_BASE ? ` (from ${BASE})` : ''}`);
  for (const rel of FILES) {
    await ensureModelFile({ baseUrl: BASE, rel, dest: join(OUT, rel) });
  }
  console.log('\nDone. The model is now bundled; the extension needs no network at runtime.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  });
}