#!/usr/bin/env node
// Copy onnxruntime-web assets shipped by Transformers.js into public/ort so they
// are packaged and served from the extension origin. Required because the WebGPU
// (jsep) backend otherwise dynamically imports its .mjs loader from a CDN, which
// the extension CSP (script-src 'self') blocks. Runs before every build.

import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist');
const OUT = join(ROOT, 'public', 'ort');

await mkdir(OUT, { recursive: true });
const files = (await readdir(SRC)).filter((f) => /^ort-.*\.(wasm|mjs)$/.test(f));
if (files.length === 0) {
  console.error('No ORT assets found in', SRC);
  process.exit(1);
}
for (const f of files) {
  await copyFile(join(SRC, f), join(OUT, f));
  console.log('✓ ort/' + f);
}
console.log(`Copied ${files.length} ORT asset(s) to public/ort`);
