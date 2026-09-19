#!/usr/bin/env node
// Postbuild: remove the duplicate ORT wasm that Vite emits into dist/assets from
// the import graph. At runtime we serve ORT from dist/ort (via wasmPaths), so the
// bundler's hashed copy is dead weight (~21MB). Runs after `vite build`.

import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'dist', 'assets');

try {
  const files = await readdir(ASSETS);
  let freed = 0;
  for (const f of files) {
    // Only the bundler-hashed ORT wasm (e.g. ort-wasm-simd-threaded.jsep-<hash>.wasm).
    if (/^ort-wasm.*-.*\.wasm$/.test(f)) {
      const p = join(ASSETS, f);
      freed += (await stat(p)).size;
      await rm(p);
      console.log('pruned dist/assets/' + f);
    }
  }
  if (freed) console.log(`freed ${(freed / 1e6).toFixed(1)} MB (ORT served from dist/ort)`);
} catch (e) {
  console.warn('prune-dist skipped:', String(e));
}
