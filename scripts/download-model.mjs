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

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'Xenova/multilingual-e5-small';
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'models', MODEL);

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchFile(rel) {
  const dest = join(OUT, rel);
  if (await exists(dest)) {
    console.log(`✓ cached  ${rel}`);
    return;
  }
  const url = `${BASE}/${rel}`;
  process.stdout.write(`↓ ${rel} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}

console.log(`Fetching ${MODEL} into ${OUT}`);
for (const f of FILES) {
  await fetchFile(f);
}
console.log('\nDone. The model is now bundled; the extension needs no network at runtime.');
