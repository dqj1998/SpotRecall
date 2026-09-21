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

// Shared: the palette card + brand bits, reused by screenshots and promos.
const BASE = `
  *{box-sizing:border-box;}
  html,body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB',Roboto,Arial,sans-serif;}
  .card{width:400px;height:544px;background:var(--sr-bg-solid);color:var(--sr-fg);border-radius:20px;overflow:hidden;
        box-shadow:0 40px 90px -30px rgba(20,44,90,.5),0 10px 30px -12px rgba(20,44,90,.35);}
  .favicon{display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;}
  .hist-del{opacity:1 !important;}
  .hist-scroll{max-height:128px;}
  .badge-local{position:absolute;bottom:64px;right:20px;display:inline-flex;align-items:center;gap:7px;
    background:rgba(255,255,255,.92);color:#127a3e;font-size:13px;font-weight:650;padding:7px 13px;border-radius:999px;
    box-shadow:0 6px 18px -6px rgba(20,44,90,.4);}
  .brandbar{display:inline-flex;align-items:center;gap:12px;}
  .brandbar img{width:40px;height:40px;border-radius:10px;}
`;

// Screenshot page (1280x800): light bg, copy on the left, upright card on the right.
const SHOT_CSS = `
  html,body{width:1280px;height:800px;}
  body{display:flex;align-items:center;gap:36px;padding:0 72px;
    background:radial-gradient(1200px 700px at 110% -10%, rgba(52,208,122,.22), transparent),
               radial-gradient(1100px 700px at -10% 110%, rgba(47,128,255,.20), transparent),#eef4fb;}
  .copy{width:520px;flex:0 0 auto;}
  .copy .brandbar{margin-bottom:26px;}
  .copy .brandbar b{font-size:22px;background:var(--sr-header-grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:750;}
  .copy h1{font-size:52px;line-height:1.12;margin:0 0 20px;color:#0f1b2d;font-weight:750;letter-spacing:-1px;}
  .copy p{font-size:23px;line-height:1.5;margin:0;color:#42566f;}
  .stage{flex:1;display:flex;justify-content:center;}
  .device{transform:scale(1.34);transform-origin:center;}
`;

// Marquee promo (1400x560): bold brand gradient, white copy, real UI card tilted at the right.
const MARQUEE_CSS = `
  html,body{width:1400px;height:560px;}
  body{position:relative;overflow:hidden;color:#fff;display:flex;align-items:center;padding:0 0 0 96px;background:var(--sr-header-grad);}
  body::after{content:'';position:absolute;inset:0;background:radial-gradient(900px 520px at 100% 130%, rgba(255,255,255,.16), transparent);}
  .copy{width:640px;flex:0 0 auto;z-index:2;}
  .copy .brandbar{margin-bottom:22px;}
  .copy .brandbar img{width:44px;height:44px;}
  .copy .brandbar b{font-size:26px;color:#fff;font-weight:750;}
  .copy h1{font-size:62px;line-height:1.08;margin:0 0 18px;color:#fff;font-weight:780;letter-spacing:-1.5px;}
  .copy p{font-size:27px;line-height:1.45;margin:0;color:rgba(255,255,255,.94);}
  .stage{position:absolute;right:0;top:0;bottom:0;width:520px;}
  .device{position:absolute;right:26px;top:50%;transform:translateY(-50%) rotate(-3deg);transform-origin:center;}
  .card{box-shadow:0 50px 120px -28px rgba(3,16,43,.6),0 14px 44px -12px rgba(3,16,43,.42);}
`;

// Small promo tile (440x280): brand gradient, icon + name + tagline + a search-pill hint.
const SMALL_CSS = `
  html,body{width:440px;height:280px;}
  body{background:var(--sr-header-grad);color:#fff;padding:28px 30px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;}
  .s-brand{display:flex;align-items:center;gap:13px;margin-bottom:15px;}
  .s-brand img{width:54px;height:54px;border-radius:14px;box-shadow:0 8px 20px -6px rgba(3,16,43,.5);}
  .s-brand b{font-size:31px;font-weight:780;}
  .s-tag{font-size:19px;line-height:1.3;margin:0 0 16px;font-weight:550;color:rgba(255,255,255,.95);}
  .pill{display:flex;align-items:center;gap:9px;background:#fff;border-radius:13px;padding:12px 15px;box-shadow:0 10px 26px -8px rgba(3,16,43,.5);}
  .pill svg{width:17px;height:17px;color:#8a99ad;stroke:#8a99ad;}
  .pill span{color:#8a99ad;font-size:15px;}
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

// English-market content (most screens). Japanese appears only in the
// cross-lingual screenshot, to demonstrate "English query → Japanese page".
const VERGE = { l: 'V', c: '#e2136e', title: 'Sony WH-1000XM5 Review: the new king of noise cancelling — The Verge', snippet: 'Class-leading ANC, refined design and 30-hour battery. Here is how it stacks up against the XM4 and the competition.', time: '6 min ago' };
const WIRE = { l: 'W', c: '#111827', title: 'The Best Noise-Cancelling Headphones for 2026 — Wirecutter', snippet: 'After 60+ hours of testing we picked the best for commuting, flights and the open office. Top pick, upgrade pick and budget pick.', time: '22 min ago' };
const AMZN = { l: 'a', c: '#ff9900', title: 'Amazon.com: Bose QuietComfort Ultra Headphones', snippet: 'Wireless noise cancelling headphones with spatial audio, immersive sound and up to 24 hours of battery life.', time: 'yesterday' };
const CART = { l: 'a', c: '#ff9900', title: 'Amazon.com Shopping Cart', snippet: 'Subtotal (1 item) · Proceed to checkout · Saved for later', time: '2 min ago' };
const ENG_ROWS = [VERGE, WIRE, AMZN];

// Japanese pages — used only in the cross-lingual scene.
const AC1 = { l: 'a', c: '#ff9900', title: "Amazon | 【標準取付工事費込み】COMFEE' エアコン 6畳 2.2kw", snippet: '大風量快適 冷暖房 静音 除湿 内部清浄 ルームエアコン 上下ルーバー 一人暮らし 保証1年', time: '7 min ago' };
const AC2 = { l: 'a', c: '#ff9900', title: "Amazon.co.jp: [2026年モデル] COMFEE' エアコン 10畳", snippet: 'オンライン通販のAmazon公式サイトなら COMFEE インバーター冷暖房 省エネ 6畳〜10畳', time: '8 min ago' };
const KAK = { l: '価', c: '#2f80ff', title: '価格.com - エアコン 人気売れ筋ランキング', snippet: '自分にピッタリのエアコンを選べる 比較・検討 メーカー・畳数・価格で絞り込み', time: 'yesterday' };

const scenes = [
  {
    name: 'screenshot-1',
    h: 'Recall any page,<br/>instantly',
    p: "Blazing-fast keyword search across everything you've visited — error codes, versions, exact titles.",
    body: palette({ value: 'noise cancelling headphones', mode: 'Keyword', sections: [{ rows: ENG_ROWS }] }),
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
      hist: [
        'noise cancelling headphones',
        'flexbox center a div',
        'chrome web store review time',
        'typescript satisfies operator',
        'best ramen near me',
      ],
      sections: [],
    }),
  },
  {
    name: 'screenshot-4',
    h: 'Your recent pages,<br/>grouped by time',
    p: 'Reopen anything from today, yesterday, or earlier — with a content preview, not a cryptic URL.',
    body: palette({
      sections: [
        { label: 'Today', rows: [CART, VERGE] },
        { label: 'Yesterday', rows: [WIRE] },
      ],
    }),
  },
  {
    name: 'screenshot-5',
    h: 'Private by design.<br/>Nothing leaves<br/>your device.',
    p: 'No cloud, no account, no tracking. Fully offline after a one-time setup. Open source.',
    body: palette({ value: 'noise cancelling headphones', mode: 'Keyword', badge: '100% on-device', sections: [{ rows: ENG_ROWS }] }),
  },
];

const iconB64 = (await readFile(join(ROOT, 'src/ui/assets/icon128.png'))).toString('base64');
const ICON = `data:image/png;base64,${iconB64}`;

function doc(css, bodyInner) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${layout}\n${BASE}\n${css}</style></head><body>${bodyInner}</body></html>`;
}

// Store screenshots (1280x800).
const outputs = scenes.map((scene) => ({
  name: scene.name,
  w: 1280,
  h: 800,
  html: doc(
    SHOT_CSS,
    `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${scene.h}</h1><p>${scene.p}</p></div><div class="stage">${scene.body}</div>`,
  ),
}));

// Marquee promo (1400x560) — real UI card, tilted.
outputs.push({
  name: 'promo-marquee-1400x560',
  w: 1400,
  h: 560,
  html: doc(
    MARQUEE_CSS,
    `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div>
     <h1>Find any page<br/>you've visited</h1>
     <p>Private, on-device recall —<br/>by keyword & meaning.</p></div>
     <div class="stage">${palette({ value: 'noise cancelling headphones', mode: 'Keyword', sections: [{ rows: ENG_ROWS }] })}</div>`,
  ),
});

// Small promo tile (440x280) — icon + name + tagline + search-pill hint.
outputs.push({
  name: 'promo-small-440x280',
  w: 440,
  h: 280,
  html: doc(
    SMALL_CSS,
    `<div class="s-brand"><img src="${ICON}"/><b>SpotRecall</b></div>
     <p class="s-tag">Find any page you've visited —<br/>private, on-device recall.</p>
     <div class="pill">${SEARCH_SVG}<span>Search where you've been…</span></div>`,
  ),
});

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  for (const o of outputs) {
    await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
    await page.setContent(o.html, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
    await new Promise((r) => setTimeout(r, 250));
    const out = join(OUT, `${o.name}.png`);
    await page.screenshot({ path: out });
    await pexec('sips', ['-z', String(o.h), String(o.w), out, '--out', out]); // 2x -> exact size
    console.log(`✓ ${o.name}.png (${o.w}x${o.h})`);
  }
} finally {
  await browser.close();
}
console.log('Done. Images in release-screenshots/.');
