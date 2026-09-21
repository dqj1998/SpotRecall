#!/usr/bin/env node
// Generate Chrome/Edge store screenshots (1280x800) by rendering the REAL palette
// UI (its actual CSS) with realistic mock data via headless Chrome. Faithful to
// the shipped UI, crisp, and complete. Uses the system Chrome (puppeteer-core).
//   npm run make-screenshots

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const pexec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release-screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const tokens = await readFile(join(ROOT, 'src/ui/tokens.css'), 'utf8');
const layout = await readFile(join(ROOT, 'src/ui/palette-layout.css'), 'utf8');

const EXTRA = `
  *{box-sizing:border-box;}
  html,body{margin:0;width:1280px;height:800px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB',Roboto,Arial,sans-serif;}
  body{display:flex;align-items:center;gap:36px;padding:0 72px;
    background:radial-gradient(1200px 700px at 110% -10%, rgba(52,208,122,.22), transparent),
               radial-gradient(1100px 700px at -10% 110%, rgba(47,128,255,.20), transparent),
               #eef4fb;}
  .copy{width:520px;flex:0 0 auto;}
  .copy h1{font-size:52px;line-height:1.12;margin:0 0 20px;color:#0f1b2d;font-weight:750;letter-spacing:-1px;}
  .copy p{font-size:23px;line-height:1.5;margin:0;color:#42566f;}
  .copy .brandbar{display:inline-flex;align-items:center;gap:12px;margin-bottom:26px;}
  .copy .brandbar img{width:40px;height:40px;border-radius:10px;}
  .copy .brandbar b{font-size:22px;background:var(--sr-header-grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:750;}
  .stage{flex:1;display:flex;justify-content:center;}
  .device{transform:scale(1.34);transform-origin:center;}
  .card{width:400px;height:544px;background:var(--sr-bg-solid);border-radius:20px;overflow:hidden;
        box-shadow:0 40px 90px -30px rgba(20,44,90,.5),0 10px 30px -12px rgba(20,44,90,.35);}
  .favicon{display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;}
  .hist-del{opacity:1 !important;}
  /* show a partial 4th row so the recent-searches list reads as scrollable */
  .hist-scroll{max-height:128px;}
  .badge-local{position:absolute;bottom:64px;right:20px;display:inline-flex;align-items:center;gap:7px;
    background:rgba(255,255,255,.92);color:#127a3e;font-size:13px;font-weight:650;padding:7px 13px;border-radius:999px;
    box-shadow:0 6px 18px -6px rgba(20,44,90,.4);}
`;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SEARCH_SVG =
  '<svg class="s-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const CLOCK_SVG =
  '<svg class="hist-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

function fav(letter, color) {
  return `<div class="favicon" style="background:${color}">${esc(letter)}</div>`;
}
function row(r) {
  return `<div class="row">${fav(r.l, r.c)}<div class="row-main"><div class="row-title">${esc(r.title)}</div><div class="row-snippet">${esc(r.snippet)}</div></div><div class="row-time">${esc(r.time)}</div></div>`;
}
function histRow(q) {
  return `<div class="hist-row">${CLOCK_SVG}<span class="hist-q">${esc(q)}</span><button class="hist-del">×</button></div>`;
}

function palette({ value, mode, semantic, hist, sections, badge }) {
  const chip = value ? `<span class="mode-chip">${mode}</span>` : '';
  const inputHtml = value
    ? `<input class="input" value="${esc(value)}" readonly/>`
    : `<input class="input" placeholder="Search where you've been…" readonly/>`;
  const histHtml = hist
    ? `<div><div class="bucket-label">Recent searches</div><div class="hist-wrap"><div class="hist-scroll more">${hist.map(histRow).join('')}</div>${hist.length > 3 ? '<div class="hist-fade"></div>' : ''}</div></div>`
    : '';
  const listHtml = (sections || [])
    .map((s) => `${s.label ? `<div class="bucket-label">${esc(s.label)}</div>` : ''}${s.rows.map(row).join('')}`)
    .join('');
  return `<div class="device"><div class="card" style="position:relative">
    ${badge ? `<div class="badge-local">🔒 ${esc(badge)}</div>` : ''}
    <div class="topbar"><span class="app-name">SpotRecall</span><div class="topbar-actions">
      <div class="lang-seg"><button class="on">EN</button><button>日本語</button><button>简体</button></div>
      <button class="panel-btn">Open panel</button></div></div>
    <div class="searchbar">${SEARCH_SVG}${inputHtml}${chip}</div>
    <div class="list">${histHtml}${listHtml}</div>
    <div class="footer"><span>All indexed · 342</span></div>
  </div></div>`;
  void semantic;
}

const AC1 = { l: 'a', c: '#ff9900', title: "Amazon | 【標準取付工事費込み】COMFEE' エアコン 6畳 2.2kw", snippet: '大風量快適 冷暖房 静音 除湿 内部清浄 ルームエアコン 上下ルーバー 一人暮らし 保証1年', time: '7 min ago' };
const AC2 = { l: 'a', c: '#ff9900', title: "Amazon.co.jp: [2026年モデル] COMFEE' エアコン 10畳", snippet: 'オンライン通販のAmazon公式サイトなら COMFEE インバーター冷暖房 省エネ 6畳〜10畳', time: '8 min ago' };
const KAK = { l: '価', c: '#2f80ff', title: '価格.com - エアコン 人気売れ筋ランキング', snippet: '自分にピッタリのエアコンを選べる 比較・検討 メーカー・畳数・価格で絞り込み', time: 'yesterday' };
const CART = { l: 'a', c: '#ff9900', title: 'Amazon.co.jp ショッピングカート', snippet: 'お届け先 ご注文内容の確認 レジに進む', time: '1 min ago' };

const scenes = [
  {
    name: 'screenshot-1',
    h: 'Recall any page,<br/>instantly',
    p: "Blazing-fast keyword search across everything you've visited — error codes, versions, exact titles.",
    body: palette({ value: 'COMFEE エアコン', mode: 'Keyword', sections: [{ rows: [AC1, AC2, KAK] }] }),
  },
  {
    name: 'screenshot-2',
    h: 'Search by meaning —<br/>across languages',
    p: 'Type in English, find that Japanese page. An on-device model understands intent and bridges languages.',
    body: palette({ value: 'air conditioner installation', mode: 'Semantic', sections: [{ rows: [AC1, AC2, KAK] }] }),
  },
  {
    name: 'screenshot-3',
    h: 'Pick up where<br/>you left off',
    p: 'Recent searches are one click away — run again, or remove any with a tap.',
    body: palette({
      hist: ['電気の価格比較', 'air conditioner installation', 'キッチン 収納', 'LLM benchmark', 'RLCD 強化学習'],
      sections: [],
    }),
  },
  {
    name: 'screenshot-4',
    h: 'Your recent pages,<br/>grouped by time',
    p: 'Reopen anything from today, yesterday, or earlier — with a content preview, not a cryptic URL.',
    body: palette({
      sections: [
        { label: 'Today', rows: [CART, AC1] },
        { label: 'Yesterday', rows: [KAK] },
      ],
    }),
  },
  {
    name: 'screenshot-5',
    h: 'Private by design.<br/>Nothing leaves<br/>your device.',
    p: 'No cloud, no account, no tracking. Fully offline after a one-time setup. Open source.',
    body: palette({ value: 'COMFEE エアコン', mode: 'Keyword', badge: '100% on-device', sections: [{ rows: [AC1, AC2, KAK] }] }),
  },
];

const iconB64 = (await readFile(join(ROOT, 'src/ui/assets/icon128.png'))).toString('base64');

function pageHtml(scene) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${layout}\n${EXTRA}</style></head>
  <body>
    <div class="copy">
      <div class="brandbar"><img src="data:image/png;base64,${iconB64}"/><b>SpotRecall</b></div>
      <h1>${scene.h}</h1><p>${scene.p}</p>
    </div>
    <div class="stage">${scene.body}</div>
  </body></html>`;
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  // Match the bright brand look (and what most users see).
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  for (const scene of scenes) {
    await page.setContent(pageHtml(scene), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
    await new Promise((r) => setTimeout(r, 250));
    const big = join(OUT, `${scene.name}.png`);
    await page.screenshot({ path: big });
    // Downscale 2560x1600 -> 1280x800 for crisp store size.
    await pexec('sips', ['-z', '800', '1280', big, '--out', big]);
    console.log(`✓ ${scene.name}.png`);
  }
} finally {
  await browser.close();
}
console.log('Done. Screenshots in release-screenshots/ (1280x800).');
