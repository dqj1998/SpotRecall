#!/usr/bin/env node
// Capture the browser-only inputs of stage-2 search for offline tuning: on-device
// translations in every en/ja/zh direction (Chrome Translator API) and vector
// results (the extension's own model + vector store). Drives the REAL built
// extension in system Chrome via puppeteer-core. eval/fusion-eval.ts then replays
// BM25 + fusion in Node over the same backup, so parameters can be swept in
// seconds without rebuilding the extension.
//
// Usage:
//   npm run build
//   npm run eval:fusion-dump -- --backup ~/Downloads/spotrecall-backup-XXX.zip
//
// Options: --labels eval/labels-fusion.json  --out eval/.cache/fusion-dump.json
//          --profile eval/.cache/chrome-profile  --chrome <path to Chrome binary>
//
// The profile is reused across runs, so the embedding and translation models are
// downloaded only once. A headful window opens: Chrome only downloads translation
// models after a user gesture, which the script simulates with a click.

import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['en', 'ja', 'zh']; // keep in sync with TRANSLATE_TARGETS
const VECTOR_TOPK = 200;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const backup = arg('backup');
const labelsPath = resolve(arg('labels', join(ROOT, 'eval/labels-fusion.json')));
const outPath = resolve(arg('out', join(ROOT, 'eval/.cache/fusion-dump.json')));
const profile = resolve(arg('profile', join(ROOT, 'eval/.cache/chrome-profile')));
const chromePath = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const dist = join(ROOT, 'dist');

await access(join(dist, 'manifest.json')).catch(() => {
  throw new Error('dist/ not found — run `npm run build` first');
});
const labels = JSON.parse(await readFile(labelsPath, 'utf8'));

// A reused profile keeps the previous build's service worker script cached, so the
// SW would run stale code while extension pages load the new build. Drop the SW
// cache (records live in IndexedDB, untouched); the extension re-registers it.
await rm(join(profile, 'Default', 'Service Worker'), { recursive: true, force: true });

// Branded Chrome ignores --load-extension; enableExtensions installs over CDP.
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  userDataDir: profile,
  enableExtensions: [dist],
  pipe: true,
  args: ['--no-first-run', '--no-default-browser-check'],
  defaultViewport: null,
});

try {
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 60_000 },
  );
  const ext = sw.url().match(/^chrome-extension:\/\/[^/]+/)[0]; // URL.origin is 'null' here
  const page = await browser.newPage();
  await page.goto(`${ext}/src/ui/options.html`);
  const send = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  // 1. Import the backup unless this profile already holds data.
  let settings = await send({ type: 'GET_SETTINGS' });
  if (settings.total === 0) {
    if (!backup) throw new Error('profile is empty — pass --backup <zip>');
    const input = await page.waitForSelector('input[type=file]');
    await input.uploadFile(resolve(backup));
    for (let i = 0; i < 120 && settings.total === 0; i++) {
      await sleep(1000);
      settings = await send({ type: 'GET_SETTINGS' });
    }
    await sleep(3000); // let REFRESH_CACHES rebuild BM25 + reload vectors
  }
  console.log(`records: ${settings.total}`);

  // 2. Semantic search on; wait for the embedding model (first run downloads it).
  await send({ type: 'SET_SEMANTIC', enabled: true });
  let model;
  for (let i = 0; i < 300; i++) {
    model = await send({ type: 'GET_MODEL_STATUS' });
    if (model?.state === 'READY' || model?.state === 'ERROR') break;
    if (i % 10 === 0) console.log(`model: ${model?.state ?? 'starting'}…`);
    await sleep(2000);
  }
  if (model?.state !== 'READY') throw new Error(`model not ready: ${JSON.stringify(model)}`);
  console.log(`model READY (${model.backend}), vectors: ${model.vectorCount}`);

  // 3. Download translation models: one simulated user gesture per create().
  const jobs = [['detector']];
  for (const s of TARGETS) for (const t of TARGETS) if (s !== t) jobs.push([s, t]);
  for (const [s, t] of jobs) {
    const status = await page.evaluate(async (s, t) => {
      if (s === 'detector') {
        if (typeof LanguageDetector === 'undefined') return 'unsupported';
        return LanguageDetector.availability();
      }
      if (typeof Translator === 'undefined') return 'unsupported';
      return Translator.availability({ sourceLanguage: s, targetLanguage: t });
    }, s, t);
    if (status === 'downloadable' || status === 'downloading') {
      await page.evaluate((s, t) => {
        document.getElementById('sr-warm')?.remove();
        const b = document.createElement('button');
        b.id = 'sr-warm';
        b.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;width:60px;height:30px';
        b.onclick = () => {
          const p = s === 'detector'
            ? LanguageDetector.create()
            : Translator.create({ sourceLanguage: s, targetLanguage: t });
          window.__srWarm = p.then(() => 'available', (e) => String(e));
        };
        document.body.appendChild(b);
      }, s, t);
      await page.click('#sr-warm');
      console.log(`${s === 'detector' ? 'LanguageDetector' : `${s}->${t}`}: ${await page.evaluate(() => window.__srWarm)}`);
    } else {
      console.log(`${s === 'detector' ? 'LanguageDetector' : `${s}->${t}`}: ${status}`);
    }
  }

  // 4. Per query: every en/ja/zh translation direction (so eval can replay any
  //    source-language strategy), raw vector results for each distinct text, the
  //    detector's verdict, and the live stage-2 ranking of this build (parity check).
  const queries = [];
  for (const label of labels) {
    const r = await page.evaluate(async (text, targets, topK) => {
      let detected = null;
      try {
        if (typeof LanguageDetector !== 'undefined' && (await LanguageDetector.availability()) === 'available') {
          const top = (await (await LanguageDetector.create()).detect(text))[0];
          detected = top && top.confidence > 0.3 ? top.detectedLanguage : null;
        }
      } catch {}
      const translations = {};
      for (const s of targets) for (const t of targets) {
        if (s === t) continue;
        try {
          translations[`${s}>${t}`] = await (await Translator.create({ sourceLanguage: s, targetLanguage: t })).translate(text);
        } catch {}
      }
      const vec = {};
      for (const v of new Set([text, ...Object.values(translations)])) {
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'VECTOR_SEARCH', text: v, topK });
        vec[v] = res.ok ? res.results : null;
      }
      const exp = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'EXPAND_QUERY', text, targets });
      const queryId = `eval-${Math.random()}`;
      const update = new Promise((done) => {
        const h = (m) => {
          if (m.type === 'SEARCH_RESULTS_UPDATE' && m.queryId === queryId) {
            chrome.runtime.onMessage.removeListener(h);
            done(m);
          }
        };
        chrome.runtime.onMessage.addListener(h);
        setTimeout(() => done(null), 60_000);
      });
      await chrome.runtime.sendMessage({ type: 'SEARCH_QUERY', queryId, text });
      const upd = await update;
      const live = upd ? upd.buckets.flatMap((b) => b.items).map((h) => h.id) : null;
      return { detected, translations, vec, liveVariants: exp.variants, live };
    }, label.query, TARGETS, VECTOR_TOPK);
    queries.push({ query: label.query, ...r });
    console.log(`${label.query} => ${JSON.stringify(r.liveVariants)}`);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ createdAt: Date.now(), vectorCount: model.vectorCount, queries }));
  console.log(`\nwrote ${queries.length} queries -> ${outPath}`);
} finally {
  await browser.close();
}
