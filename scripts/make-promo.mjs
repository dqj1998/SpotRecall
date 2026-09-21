#!/usr/bin/env node
// Generate Chrome Web Store promo tiles (landscape) from the brand gradient +
// icon + tagline. Outputs PNGs into release-screenshots/.
//   npm run make-promo

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release-screenshots');

const iconB64 = (await readFile(join(ROOT, 'src/ui/assets/icon128.png'))).toString('base64');
const iconHref = `data:image/png;base64,${iconB64}`;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

function svg({ w, h, icon, name, tag, tagLines, tagLH }) {
  const lines = tagLines
    .map((l, i) => `<tspan x="${tag.x}" dy="${i === 0 ? 0 : tagLH}">${esc(l)}</tspan>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2f80ff"/>
      <stop offset="0.5" stop-color="#12b6d8"/>
      <stop offset="1" stop-color="#2fd07a"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="${w}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#03102b" stop-opacity="0.28"/>
      <stop offset="0.72" stop-color="#03102b" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#scrim)"/>
  <image href="${iconHref}" x="${icon.x}" y="${icon.y}" width="${icon.s}" height="${icon.s}"/>
  <text x="${name.x}" y="${name.y}" font-family="${FONT}" font-size="${name.size}" font-weight="700" fill="#ffffff" letter-spacing="-0.5">${esc(name.text)}</text>
  <text x="${tag.x}" y="${tag.y}" font-family="${FONT}" font-size="${tag.size}" font-weight="400" fill="#ffffff" fill-opacity="0.92">${lines}</text>
</svg>`;
}

async function render(name, spec) {
  const s = svg(spec);
  const png = new Resvg(s, {
    fitTo: { mode: 'width', value: spec.w },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();
  const out = join(OUT, name);
  await writeFile(out, png);
  console.log(`✓ ${name} (${spec.w}x${spec.h})`);
}

// Marquee 1400x560 — icon left, text right.
await render('promo-marquee-1400x560.png', {
  w: 1400,
  h: 560,
  icon: { x: 150, y: 155, s: 250 },
  name: { text: 'SpotRecall', x: 470, y: 275, size: 116 },
  tag: {
    x: 472,
    y: 350,
    size: 42,
    lines: 2,
  },
  tagLines: ["Find any page you've visited —", 'private, on-device recall.'],
  tagLH: 54,
});

// Small tile 440x280 — icon top-left, name beside, tagline below.
await render('promo-small-440x280.png', {
  w: 440,
  h: 280,
  icon: { x: 40, y: 44, s: 104 },
  name: { text: 'SpotRecall', x: 164, y: 106, size: 44 },
  tag: { x: 44, y: 210, size: 26, lines: 2 },
  tagLines: ['Local-first page recall —', 'private, by keyword & meaning.'],
  tagLH: 34,
});

console.log('Done. Promo tiles are in release-screenshots/.');
