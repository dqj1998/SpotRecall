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
const optionsCss = await readFile(join(ROOT, 'src/ui/options.css'), 'utf8');

// The options page and the palette both define .card, so the shipped
// options.css is re-scoped under .opt before it joins the same document. The
// file is flat (no nested at-rules), so a selector-prefix pass is enough.
const OPTIONS_CSS =
  optionsCss
    .replace(/screenshot-import[^;]+;/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\})\s*([^{}]+)\{/g, (_m, close, sel) =>
      close +
      sel
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean)
        .map((one) => (one === 'body' || one === 'html' ? '.opt' : '.opt ' + one))
        .join(',') +
      '{',
    ) +
  `
  /* Present the settings card as a floating product shot, not a full page. */
  .opt{width:470px;min-height:0;padding:24px;border-radius:20px;overflow:hidden;
       box-shadow:0 40px 90px -30px rgba(20,44,90,.5),0 10px 30px -12px rgba(20,44,90,.35);}
  .opt .card{width:auto;height:auto;margin:0;}
  .opt .ac-log{max-height:none;}
  /* The real settings page is 732px wide, so its controls never shrink. At this
     crop width the flex row would squash the toggle into an oval. */
  .opt .switch,.opt .row > input{flex:0 0 auto;}
  /* Unlike the palette card, this card's content is real localized UI copy, so
     it must mirror with the page. Left LTR, Arabic sentence-final punctuation
     wraps to the start of the next line. */
  body.rtl .device.wide{direction:rtl;}
  /* .card > .desc has no rule of its own in options.css, so it falls back to the
     page default and reads as an oversized lead when cropped this close. */
  .opt .card > .desc{font-size:12px;color:var(--sr-fg-dim);line-height:1.55;margin:0 0 6px;}
  .opt .ac-log-fav{font-size:8px;}
  /* The settings card is wider than the palette card, so it scales down less. */
  .device.wide{transform:scale(1.12);}
`;


// The brand gradient runs blue -> green left-to-right, so the copy always sits
// on the blue end. RTL layouts mirror the copy, so mirror the angle with them.
const HEADER_GRAD = /--sr-header-grad:\s*([^;]+);/.exec(tokens)[1].trim();
const HEADER_GRAD_RTL = HEADER_GRAD.replace(/([\d.]+)deg/, (_, deg) => `${(360 - Number(deg)) % 360}deg`);

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
  /* Each source line is its own nowrap block so autofit can measure it. */
  .ln{display:block;white-space:nowrap;}
  /* The product card always renders LTR: its mock rows are Latin content. */
  .device{direction:ltr;}
  body.rtl{direction:rtl;}
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
  /* direction:rtl already reverses the flex row, putting the card on the left;
     only the background's directional tints need mirroring to follow it. */
  body.rtl{background:radial-gradient(1200px 700px at -10% -10%, rgba(52,208,122,.22), transparent),
                      radial-gradient(1100px 700px at 110% 110%, rgba(47,128,255,.20), transparent),#eef4fb;}
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
  body.rtl{padding:0 0 0 0;padding-right:96px;background-image:${HEADER_GRAD_RTL};}
  body.rtl::after{background:radial-gradient(900px 520px at 0% 130%, rgba(255,255,255,.16), transparent);}
  body.rtl .stage{left:0;right:auto;}
  body.rtl .device{left:26px;right:auto;transform:translateY(-50%) rotate(3deg);}
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
  .pill span{color:#8a99ad;font-size:15px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;}
  body.rtl{background-image:${HEADER_GRAD_RTL};}
`;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Locales whose listing copy reads right-to-left. Only the surrounding
// marketing layout mirrors; the product card stays LTR (its rows are Latin).
const RTL = new Set(['ar']);

// Copy authored with explicit <br/> breaks becomes one nowrap block per line so
// autofit() can measure and shrink it. Copy without breaks keeps normal wrapping.
function lines(str) {
  const parts = String(str).split(/<br\s*\/?>/);
  if (parts.length === 1) return esc(str);
  return parts.map((t) => `<span class="ln">${esc(t.trim())}</span>`).join('');
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

function palette({ value, mode, semantic, hist, sections, badge, openPanel = 'Open panel', indexed = 'All indexed' }) {
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
      <button class="panel-btn">${esc(openPanel)}</button></div></div>
    <div class="searchbar">${SEARCH_SVG}${inputHtml}${chip}</div>
    <div class="list">${histHtml}${listHtml}</div>
    <div class="footer"><span>${esc(indexed)} · 342</span></div>
  </div></div>`;
  void semantic;
}

// English-market content (most screens). Japanese appears only in the
// cross-lingual screenshot, to demonstrate "English query → Japanese page".
const VERGE = { l: 'V', c: '#e2136e', title: 'Sony WH-1000XM5 Review: the new king of noise cancelling — The Verge', snippet: 'Class-leading ANC, refined design and 30-hour battery. Here is how it stacks up against the XM4 and the competition.', time: '6 min ago' };
const WIRE = { l: 'W', c: '#111827', title: 'The Best Noise-Cancelling Headphones for 2026 — Wirecutter', snippet: 'After 60+ hours of testing we picked the best for commuting, flights and the open office. Top pick, upgrade pick and budget pick.', time: '22 min ago' };
const AMZN = { l: 'a', c: '#ff9900', title: 'Amazon.com: Bose QuietComfort Ultra Headphones', snippet: 'Wireless noise cancelling headphones with spatial audio, immersive sound and up to 24 hours of battery life.', time: 'yesterday' };
const ENG_ROWS = [VERGE, WIRE, AMZN];

const SCREENSHOT_1_LOCALES = {
  en: {
    h: 'Recall any page,<br/>instantly',
    p: "Blazing-fast keyword search across everything you've visited — error codes, versions, exact titles.",
    query: 'noise cancelling headphones', mode: 'Keyword', openPanel: 'Open panel', indexed: 'All indexed',
  },
  ar: {
    h: 'استعد أي صفحة<br/>فورا',
    p: 'بحث سريع بالكلمات المفتاحية في كل ما زرته، بما في ذلك رموز الأخطاء والإصدارات والعناوين الدقيقة.',
    query: 'سماعات عازلة للضوضاء', mode: 'كلمة مفتاحية', openPanel: 'فتح اللوحة', indexed: 'تمت الفهرسة',
  },
  de: {
    h: 'Jede Seite sofort<br/>wiederfinden',
    p: 'Rasante Stichwortsuche in allem, was du besucht hast: Fehlercodes, Versionen und exakte Titel.',
    query: 'Kopfhörer mit Geräuschunterdrückung', mode: 'Stichwort', openPanel: 'Panel öffnen', indexed: 'Alles indexiert',
  },
  es: {
    h: 'Recupera cualquier<br/>página al instante',
    p: 'Búsqueda rápida por palabras clave en todo lo que visitaste: códigos de error, versiones y títulos exactos.',
    query: 'auriculares con cancelación de ruido', mode: 'Palabra clave', openPanel: 'Abrir panel', indexed: 'Todo indexado',
  },
  fr: {
    h: 'Retrouvez n’importe<br/>quelle page, instantanément',
    p: 'Recherche rapide par mots-clés dans tout ce que vous avez visité : codes d’erreur, versions et titres exacts.',
    query: 'casque à réduction de bruit', mode: 'Mot-clé', openPanel: 'Ouvrir le panneau', indexed: 'Tout indexé',
  },
  hi: {
    h: 'कोई भी पेज<br/>तुरंत फिर पाएँ',
    p: 'आपने जो कुछ देखा है उसमें तेज़ कीवर्ड खोज: त्रुटि कोड, संस्करण और सटीक शीर्षक।',
    query: 'नॉइज़ कैंसलिंग हेडफ़ोन', mode: 'कीवर्ड', openPanel: 'पैनल खोलें', indexed: 'सब इंडेक्स किया गया',
  },
  id: {
    h: 'Temukan kembali<br/>halaman apa pun',
    p: 'Pencarian kata kunci cepat di semua halaman yang pernah Anda kunjungi: kode error, versi, dan judul tepat.',
    query: 'headphone peredam bising', mode: 'Kata kunci', openPanel: 'Buka panel', indexed: 'Semua terindeks',
  },
  it: {
    h: 'Ritrova qualsiasi<br/>pagina all’istante',
    p: 'Ricerca veloce per parole chiave in tutto ciò che hai visitato: codici errore, versioni e titoli esatti.',
    query: 'cuffie con cancellazione del rumore', mode: 'Parola chiave', openPanel: 'Apri pannello', indexed: 'Tutto indicizzato',
  },
  ja: {
    h: '見たページを<br/>すぐに呼び出す',
    p: 'エラーコード、バージョン、正確なタイトルまで、訪問したすべてのページをキーワードで高速検索。',
    query: 'ノイズキャンセリング ヘッドホン', mode: 'キーワード', openPanel: 'パネルを開く', indexed: 'すべてインデックス済み',
  },
  ko: {
    h: '봤던 모든 페이지를<br/>즉시 다시 찾기',
    p: '오류 코드, 버전, 정확한 제목까지 방문한 모든 페이지를 빠른 키워드 검색으로 찾아보세요.',
    query: '노이즈 캔슬링 헤드폰', mode: '키워드', openPanel: '패널 열기', indexed: '모두 색인됨',
  },
  nl: {
    h: 'Vind elke pagina<br/>direct terug',
    p: 'Razendsnel zoeken op trefwoord in alles wat je bezocht: foutcodes, versies en exacte titels.',
    query: 'koptelefoon met ruisonderdrukking', mode: 'Trefwoord', openPanel: 'Paneel openen', indexed: 'Alles geïndexeerd',
  },
  pl: {
    h: 'Odnajdź każdą stronę<br/>od razu',
    p: 'Błyskawiczne wyszukiwanie słów kluczowych we wszystkich odwiedzonych stronach: kodach błędów, wersjach i tytułach.',
    query: 'słuchawki z redukcją hałasu', mode: 'Słowo kluczowe', openPanel: 'Otwórz panel', indexed: 'Wszystko zindeksowane',
  },
  pt_BR: {
    h: 'Encontre qualquer página<br/>na hora',
    p: 'Busca rápida por palavras-chave em tudo o que você visitou: códigos de erro, versões e títulos exatos.',
    query: 'fones com cancelamento de ruído', mode: 'Palavra-chave', openPanel: 'Abrir painel', indexed: 'Tudo indexado',
  },
  pt_PT: {
    h: 'Encontre qualquer página<br/>de imediato',
    p: 'Pesquisa rápida por palavras-chave em tudo o que visitou: códigos de erro, versões e títulos exatos.',
    query: 'auscultadores com cancelamento de ruído', mode: 'Palavra-chave', openPanel: 'Abrir painel', indexed: 'Tudo indexado',
  },
  ru: {
    h: 'Находите любую страницу<br/>мгновенно',
    p: 'Быстрый поиск по ключевым словам во всем, что вы посещали: кодах ошибок, версиях и точных заголовках.',
    query: 'наушники с шумоподавлением', mode: 'Ключевое слово', openPanel: 'Открыть панель', indexed: 'Все проиндексировано',
  },
  th: {
    h: 'ค้นหาทุกหน้าเว็บ<br/>ได้ทันที',
    p: 'ค้นหาด้วยคีย์เวิร์ดอย่างรวดเร็วในทุกหน้าที่เคยเข้าชม ทั้งรหัสข้อผิดพลาด เวอร์ชัน และชื่อเรื่องแบบตรงตัว',
    query: 'หูฟังตัดเสียงรบกวน', mode: 'คีย์เวิร์ด', openPanel: 'เปิดแผง', indexed: 'จัดทำดัชนีแล้วทั้งหมด',
  },
  tr: {
    h: 'Herhangi bir sayfayı<br/>anında bulun',
    p: 'Hata kodları, sürümler ve tam başlıklar dahil ziyaret ettiğiniz her şeyde hızlı anahtar kelime araması.',
    query: 'gürültü engelleyici kulaklık', mode: 'Anahtar kelime', openPanel: 'Paneli aç', indexed: 'Tümü dizine eklendi',
  },
  uk: {
    h: 'Знаходьте будь-яку сторінку<br/>миттєво',
    p: 'Швидкий пошук за ключовими словами в усьому, що ви відвідували: кодах помилок, версіях і точних заголовках.',
    query: 'навушники з шумозаглушенням', mode: 'Ключове слово', openPanel: 'Відкрити панель', indexed: 'Усе проіндексовано',
  },
  vi: {
    h: 'Tìm lại mọi trang<br/>ngay lập tức',
    p: 'Tìm kiếm từ khóa siêu nhanh trong mọi trang bạn đã truy cập: mã lỗi, phiên bản và tiêu đề chính xác.',
    query: 'tai nghe chống ồn', mode: 'Từ khóa', openPanel: 'Mở bảng', indexed: 'Đã lập chỉ mục tất cả',
  },
  zh_CN: {
    h: '所有看过的网页<br/>瞬间找回',
    p: '快速关键词搜索所有访问过的页面，包括错误代码、版本号和准确标题。',
    query: '降噪耳机', mode: '关键词', openPanel: '打开面板', indexed: '全部已收录',
  },
  zh_TW: {
    h: '所有看過的網頁<br/>瞬間找回',
    p: '快速以關鍵字搜尋所有造訪過的頁面，包括錯誤代碼、版本與精確標題。',
    query: '降噪耳機', mode: '關鍵字', openPanel: '開啟面板', indexed: '全部已收錄',
  },
};

// Promo-tile copy per Store locale. `mh`/`mp` drive the 1400x560 marquee,
// `stag`/`pill` the 440x280 small tile. Search-card content is reused from
// SCREENSHOT_1_LOCALES so both promos and the first screenshot say the same thing.
const PROMO_LOCALES = {
  en: {
    mh: 'Close tabs freely.<br/>Find any page again.',
    mp: 'Auto-closes idle tabs —<br/>AI recall, on your device.',
    stag: 'Auto-close idle tabs —<br/>find any page again with AI.',
    pill: "Search where you've been…",
  },
  ar: {
    mh: 'أغلق علامات التبويب بحرية.<br/>واعثر على أي صفحة مجددًا.',
    mp: 'إغلاق تلقائي لعلامات التبويب الخاملة —<br/>واسترجاع بالذكاء الاصطناعي على جهازك.',
    stag: 'أغلق علامات التبويب الخاملة تلقائيًا —<br/>واعثر على أي صفحة مجددًا بالذكاء الاصطناعي.',
    pill: 'ابحث في ما زرته…',
  },
  de: {
    mh: 'Tabs einfach schließen.<br/>Jede Seite wiederfinden.',
    mp: 'Schließt ungenutzte Tabs automatisch —<br/>KI-Suche direkt auf deinem Gerät.',
    stag: 'Ungenutzte Tabs automatisch schließen —<br/>jede Seite per KI wiederfinden.',
    pill: 'Durchsuche, wo du warst…',
  },
  es: {
    mh: 'Cierra pestañas sin miedo.<br/>Encuentra cualquier página.',
    mp: 'Cierra automáticamente las pestañas inactivas —<br/>búsqueda con IA, en tu dispositivo.',
    stag: 'Cierre automático de pestañas inactivas —<br/>encuentra cualquier página con IA.',
    pill: 'Busca dónde has estado…',
  },
  fr: {
    mh: 'Fermez sans crainte.<br/>Retrouvez chaque page.',
    mp: 'Ferme automatiquement les onglets inactifs —<br/>recherche IA, sur votre appareil.',
    stag: 'Fermeture auto des onglets inactifs —<br/>retrouvez chaque page grâce à l’IA.',
    pill: 'Cherchez où vous êtes allé…',
  },
  hi: {
    mh: 'टैब बेझिझक बंद करें।<br/>कोई भी पेज फिर पाएँ।',
    mp: 'निष्क्रिय टैब अपने-आप बंद —<br/>AI रिकॉल, आपके डिवाइस पर।',
    stag: 'निष्क्रिय टैब अपने-आप बंद करें —<br/>AI से कोई भी पेज फिर पाएँ।',
    pill: 'जहाँ गए थे, वहाँ खोजें…',
  },
  id: {
    mh: 'Tutup tab sesuka hati.<br/>Temukan lagi halaman apa pun.',
    mp: 'Tab menganggur ditutup otomatis —<br/>temukan lagi dengan AI di perangkat.',
    stag: 'Tutup otomatis tab menganggur —<br/>temukan lagi halaman apa pun dengan AI.',
    pill: 'Cari halaman yang pernah dibuka…',
  },
  it: {
    mh: 'Chiudi le schede senza pensieri.<br/>Ritrova ogni pagina.',
    mp: 'Chiude da sola le schede inattive —<br/>ricerca IA sul tuo dispositivo.',
    stag: 'Chiusura automatica delle schede inattive —<br/>ritrova ogni pagina con l’IA.',
    pill: 'Cerca dove sei stato…',
  },
  ja: {
    mh: 'タブは気軽に閉じて、<br/>いつでも見つける',
    mp: '使っていないタブを自動クローズ —<br/>端末内AIで呼び戻す。',
    stag: 'タブを自動で整理 —<br/>閉じたページもAIで検索。',
    pill: '訪れたページを検索…',
  },
  ko: {
    mh: '탭은 마음껏 닫고,<br/>어떤 페이지든 다시 찾기',
    mp: '사용하지 않는 탭은 자동으로 닫고 —<br/>기기 안의 AI로 다시 찾기.',
    stag: '사용하지 않는 탭 자동 닫기 —<br/>AI로 어떤 페이지든 다시 찾기.',
    pill: '다녀온 페이지 검색…',
  },
  nl: {
    mh: 'Sluit tabbladen zorgeloos.<br/>Vind elke pagina terug.',
    mp: 'Sluit inactieve tabbladen automatisch —<br/>AI-zoeken op je eigen apparaat.',
    stag: 'Sluit inactieve tabbladen automatisch —<br/>vind elke pagina terug met AI.',
    pill: 'Zoek waar je geweest bent…',
  },
  pl: {
    mh: 'Zamykaj karty śmiało.<br/>Odnajdź każdą stronę.',
    mp: 'Automatycznie zamyka nieużywane karty —<br/>odnajdywanie z AI na urządzeniu.',
    stag: 'Automatycznie zamykaj nieużywane karty —<br/>odnajdź każdą stronę dzięki AI.',
    pill: 'Szukaj tam, gdzie byłeś…',
  },
  pt_BR: {
    mh: 'Feche abas sem medo.<br/>Reencontre qualquer página.',
    mp: 'Fecha abas ociosas sozinho —<br/>recuperação por IA no seu dispositivo.',
    stag: 'Feche abas ociosas automaticamente —<br/>reencontre qualquer página com IA.',
    pill: 'Busque por onde você passou…',
  },
  pt_PT: {
    mh: 'Feche separadores à vontade.<br/>Reencontre qualquer página.',
    mp: 'Fecha separadores inativos sozinho —<br/>recuperação por IA no dispositivo.',
    stag: 'Feche separadores inativos automaticamente —<br/>reencontre qualquer página com IA.',
    pill: 'Pesquise por onde passou…',
  },
  ru: {
    mh: 'Закрывайте вкладки смело.<br/>Находите любую страницу.',
    mp: 'Автозакрытие неактивных вкладок —<br/>ИИ-поиск прямо на устройстве.',
    stag: 'Автозакрытие неактивных вкладок —<br/>находите любую страницу с ИИ.',
    pill: 'Ищите там, где вы были…',
  },
  th: {
    mh: 'ปิดแท็บได้ไม่ต้องกังวล<br/>หาหน้าไหนก็เจออีกครั้ง',
    mp: 'ปิดแท็บที่ไม่ได้ใช้อัตโนมัติ —<br/>ค้นคืนด้วย AI บนเครื่องคุณ',
    stag: 'ปิดแท็บที่ไม่ได้ใช้อัตโนมัติ —<br/>หาหน้าไหนก็เจออีกครั้งด้วย AI',
    pill: 'ค้นหาหน้าที่คุณเคยเปิด…',
  },
  tr: {
    mh: 'Sekmeleri rahatça kapat.<br/>Her sayfayı yeniden bul.',
    mp: 'Boştaki sekmeleri otomatik kapatır —<br/>yapay zekayla geri bulma, cihazında.',
    stag: 'Boştaki sekmeleri otomatik kapat —<br/>her sayfayı yapay zekayla yeniden bul.',
    pill: 'Gezdiğin sayfalarda ara…',
  },
  uk: {
    mh: 'Закривайте вкладки сміливо.<br/>Знаходьте будь-яку сторінку.',
    mp: 'Автозакриття неактивних вкладок —<br/>ШІ-пошук просто на пристрої.',
    stag: 'Автозакриття неактивних вкладок —<br/>знаходьте будь-яку сторінку з ШІ.',
    pill: 'Шукайте там, де ви були…',
  },
  vi: {
    mh: 'Thoải mái đóng thẻ.<br/>Tìm lại mọi trang.',
    mp: 'Tự động đóng thẻ không dùng —<br/>tìm lại bằng AI ngay trên máy.',
    stag: 'Tự động đóng thẻ không dùng —<br/>tìm lại mọi trang bằng AI.',
    pill: 'Tìm trang bạn từng ghé…',
  },
  zh_CN: {
    mh: '标签页放心关，<br/>任何网页都找得回',
    mp: '自动关闭闲置标签页 —<br/>AI 在本机帮你找回。',
    stag: '自动关闭闲置标签页 —<br/>用 AI 找回任何网页。',
    pill: '搜索你去过的网页…',
  },
  zh_TW: {
    mh: '分頁放心關，<br/>任何網頁都找得回',
    mp: '自動關閉閒置分頁 —<br/>AI 在裝置上幫你找回。',
    stag: '自動關閉閒置分頁 —<br/>用 AI 找回任何網頁。',
    pill: '搜尋你造訪過的網頁…',
  },
};

// Per-locale copy for screenshots 2–5.
// screenshot-2: semantic / cross-lingual search demo.
const SCREENSHOT_2_LOCALES = {
  en: {
    h: 'Search by meaning —<br/>across languages',
    p: 'Type in English, find that Japanese page. An on-device model understands intent and bridges languages.',
    query: 'air conditioner installation', mode: 'Semantic',
  },
  ar: {
    h: 'ابحث بالمعنى —<br/>عبر اللغات',
    p: 'اكتب بالعربية وابحث في الصفحات اليابانية. نموذج على جهازك يفهم القصد ويعبر الحواجز اللغوية.',
    query: 'تركيب مكيف هواء', mode: 'دلالي',
  },
  de: {
    h: 'Suche nach Bedeutung —<br/>sprachübergreifend',
    p: 'Auf Deutsch suchen, japanische Seite finden. Ein lokales Modell versteht die Absicht und überbrückt Sprachen.',
    query: 'Klimaanlage Installation', mode: 'Semantisch',
  },
  es: {
    h: 'Busca por significado —<br/>entre idiomas',
    p: 'Escribe en español, encuentra esa página en japonés. Un modelo en tu dispositivo entiende la intención y cruza idiomas.',
    query: 'instalación de aire acondicionado', mode: 'Semántico',
  },
  fr: {
    h: 'Cherchez par sens —<br/>entre les langues',
    p: 'Tapez en français, retrouvez cette page japonaise. Un modèle sur votre appareil comprend l’intention et franchit les barrières linguistiques.',
    query: 'installation de climatiseur', mode: 'Sémantique',
  },
  hi: {
    h: 'अर्थ से खोजें —<br/>सभी भाषाओं में',
    p: 'हिंदी में टाइप करें, जापानी पेज खोजें। डिवाइस पर एक मॉडल इरादा समझता है और भाषाओं के बीच सेतु बनाता है।',
    query: 'एयर कंडीशनर इंस्टॉलेशन', mode: 'सिमेंटिक',
  },
  id: {
    h: 'Cari berdasarkan makna —<br/>lintas bahasa',
    p: 'Ketik dalam Bahasa Indonesia, temukan halaman Jepang itu. Model di perangkat memahami maksud dan menjembatani bahasa.',
    query: 'instalasi AC', mode: 'Semantik',
  },
  it: {
    h: 'Cerca per significato —<br/>tra le lingue',
    p: 'Scrivi in italiano, trova quella pagina giapponese. Un modello sul tuo dispositivo capisce l’intento e supera le barriere linguistiche.',
    query: 'installazione condizionatore d’aria', mode: 'Semantico',
  },
  ja: {
    h: '意味で検索 —<br/>言語をまたいで',
    p: '英語で入力して、あの日本語ページを見つける。端末内モデルが意図を理解し、言語の壁を越えます。',
    query: 'air conditioner installation', mode: 'セマンティック',
  },
  ko: {
    h: '의미로 검색 —<br/>언어를 넘어',
    p: '한국어로 입력하고 일본어 페이지를 찾으세요. 기기 내 모델이 의도를 이해하고 언어 장벽을 넘습니다.',
    query: '에어컨 설치', mode: '시맨틱',
  },
  nl: {
    h: 'Zoek op betekenis —<br/>over talen heen',
    p: 'Typ in het Nederlands, vind die Japanse pagina. Een lokaal model begrijpt de intentie en overbrugt talen.',
    query: 'airconditioning installatie', mode: 'Semantisch',
  },
  pl: {
    h: 'Szukaj po znaczeniu —<br/>przez języki',
    p: 'Wpisz po polsku, znajdź tę japońską stronę. Model na urządzeniu rozumie intencję i łączy języki.',
    query: 'instalacja klimatyzacji', mode: 'Semantyczny',
  },
  pt_BR: {
    h: 'Pesquise por significado —<br/>entre idiomas',
    p: 'Digite em português, encontre aquela página em japonês. Um modelo no dispositivo entende a intenção e cruza idiomas.',
    query: 'instalação de ar-condicionado', mode: 'Semântico',
  },
  pt_PT: {
    h: 'Pesquise por significado —<br/>entre línguas',
    p: 'Escreva em português, encontre essa página em japonês. Um modelo no dispositivo compreende a intenção e cruza idiomas.',
    query: 'instalação de ar condicionado', mode: 'Semântico',
  },
  ru: {
    h: 'Ищите по смыслу —<br/>между языками',
    p: 'Введите на русском, найдите ту японскую страницу. Локальная модель понимает намерение и преодолевает языковые барьеры.',
    query: 'установка кондиционера', mode: 'Семантический',
  },
  th: {
    h: 'ค้นหาตามความหมาย —<br/>ข้ามภาษา',
    p: 'พิมพ์เป็นภาษาไทย ค้นพบหน้าญี่ปุ่นนั้น โมเดลบนเครื่องเข้าใจเจตนาและเชื่อมต่อข้ามภาษา',
    query: 'ติดตั้งเครื่องปรับอากาศ', mode: 'ความหมาย',
  },
  tr: {
    h: 'Anlama göre ara —<br/>diller arasında',
    p: 'Türkçe yaz, o Japonca sayfayı bul. Cihazındaki model niyeti anlayıp diller arasında köprü kurar.',
    query: 'klima kurulumu', mode: 'Anlamsal',
  },
  uk: {
    h: 'Шукайте за змістом —<br/>між мовами',
    p: 'Введіть українською, знайдіть ту японську сторінку. Локальна модель розуміє намір і долає мовні бар’єри.',
    query: 'встановлення кондиціонера', mode: 'Семантичний',
  },
  vi: {
    h: 'Tìm theo nghĩa —<br/>vượt rào ngôn ngữ',
    p: 'Nhập tiếng Việt, tìm ra trang tiếng Nhật đó. Mô hình ngay trên máy hiểu ý định và vượt rào ngôn ngữ.',
    query: 'lắp đặt điều hòa không khí', mode: 'Ngữ nghĩa',
  },
  zh_CN: {
    h: '语义搜索 —<br/>跨越语言障碍',
    p: '用中文输入，找到那个日文页面。设备上的模型理解意图，跨越语言边界。',
    query: '空调安装', mode: '语义',
  },
  zh_TW: {
    h: '語義搜尋 —<br/>跨越語言障礙',
    p: '用中文輸入，找到那個日文頁面。裝置上的模型理解意圖，跨越語言界限。',
    query: '冷氣安裝', mode: '語義',
  },
};

// screenshot-3: recent searches / history.
const SCREENSHOT_3_LOCALES = {
  en: {
    h: 'Pick up where<br/>you left off',
    p: 'Recent searches are one click away — run again, or remove any with a tap.',
  },
  ar: {
    h: 'استأنف من حيث<br/>توقفت',
    p: 'عمليات البحث الأخيرة على بُعد نقرة واحدة — أعد تشغيلها أو احذف أيًا منها بنقرة.',
  },
  de: {
    h: 'Dort weitermachen,<br/>wo du aufgehört hast',
    p: 'Letzte Suchanfragen sind einen Klick entfernt — erneut ausführen oder jede per Tipp entfernen.',
  },
  es: {
    h: 'Continúa donde<br/>lo dejaste',
    p: 'Las búsquedas recientes están a un clic: repítelas o elimina cualquiera con un toque.',
  },
  fr: {
    h: 'Reprenez là<br/>où vous en étiez',
    p: 'Les recherches récentes sont à un clic — relancez-les ou supprimez-en une d’un tap.',
  },
  hi: {
    h: 'वहीं से शुरू करें<br/>जहाँ छोड़ा था',
    p: 'हालिया खोजें एक क्लिक दूर हैं — फिर से चलाएँ, या किसी को भी एक टैप में हटाएँ।',
  },
  id: {
    h: 'Lanjutkan dari<br/>tempat Anda berhenti',
    p: 'Pencarian terbaru hanya satu klik — jalankan lagi, atau hapus salah satunya dengan sentuhan.',
  },
  it: {
    h: 'Riprendi da dove<br/>avevi lasciato',
    p: 'Le ricerche recenti sono a un clic — ripetile o eliminane una con un tocco.',
  },
  ja: {
    h: '続きから<br/>再開する',
    p: '最近の検索履歴はワンクリックで — もう一度実行するか、タップで削除できます。',
  },
  ko: {
    h: '멈췄던 곳에서<br/>다시 시작하기',
    p: '최근 검색은 한 번의 클릭으로 — 다시 실행하거나 탭 하나로 삭제하세요.',
  },
  nl: {
    h: 'Ga verder waar<br/>je gebleven was',
    p: 'Recente zoekopdrachten zijn één klik weg — voer ze opnieuw uit of verwijder ze met een tik.',
  },
  pl: {
    h: 'Wróć tam,<br/>gdzie skończyłeś',
    p: 'Ostatnie wyszukiwania są o jedno kliknięcie — uruchom ponownie lub usuń dowolne jednym stuknięciem.',
  },
  pt_BR: {
    h: 'Continue de onde<br/>você parou',
    p: 'Pesquisas recentes estão a um clique — execute novamente ou remova qualquer uma com um toque.',
  },
  pt_PT: {
    h: 'Continue a partir<br/>de onde ficou',
    p: 'As pesquisas recentes estão a um clique — execute novamente ou remova qualquer uma com um toque.',
  },
  ru: {
    h: 'Продолжите там,<br/>где остановились',
    p: 'Последние запросы в одном клике — повторите поиск или удалите любой одним нажатием.',
  },
  th: {
    h: 'ต่อจากที่<br/>คุณค้างไว้',
    p: 'การค้นหาล่าสุดอยู่แค่คลิกเดียว — ค้นหาอีกครั้งหรือลบออกได้ด้วยการแตะ',
  },
  tr: {
    h: 'Kaldığın yerden<br/>devam et',
    p: 'Son aramalar tek tıkla — yeniden çalıştır veya herhangi birini bir dokunuşla kaldır.',
  },
  uk: {
    h: 'Продовжте з того<br/>місця, де зупинились',
    p: 'Останні запити за один клік — повторіть пошук або видаліть будь-який одним дотиком.',
  },
  vi: {
    h: 'Tiếp tục từ nơi<br/>bạn đã dừng',
    p: 'Tìm kiếm gần đây chỉ một cú nhấp — chạy lại hoặc xóa bất kỳ tìm kiếm nào bằng một chạm.',
  },
  zh_CN: {
    h: '从上次离开<br/>的地方继续',
    p: '最近搜索一键即达 — 重新运行，或轻触删除任意一条。',
  },
  zh_TW: {
    h: '從上次離開<br/>的地方繼續',
    p: '最近搜尋一鍵即達 — 重新執行，或輕觸刪除任意一條。',
  },
};

// screenshot-4: the real Options -> "Auto-close tabs" card. `loc` is the BCP-47
// tag used for the relative-time labels in the closed-tab log, so the mock
// timestamps read exactly the way relTime() formats them in the shipped UI.
const SCREENSHOT_4_LOCALES = {
  en: {
    loc: 'en',
    h: 'Close tabs freely.<br/>Find them anytime.',
    p: 'Idle tabs close on their own once you pass your limit. Every closed page stays in the 48-hour list and searchable in SpotRecall.',
    title: 'Auto-close tabs',
    desc: 'Quietly closes inactive tabs when you have too many open. Closed pages stay searchable in SpotRecall (except empty ones). Pinned, grouped, audible, and active tabs are never touched.',
    label: 'Enable auto-close',
    note: 'Turn it off anytime. A window is never emptied, and recently-restored tabs get a grace period.',
    keepLabel: 'Tabs to keep open',
    keepDesc: 'Target number of regular tabs to keep open across all windows (default 12). Pinned and grouped tabs are not counted.',
    logTitle: 'Closed in the last 48h (4)',
    tag: 'title only',
  },
  ar: {
    loc: 'ar',
    h: 'أغلق علامات التبويب بحرية.<br/>واعثر عليها متى شئت.',
    p: 'تُغلق علامات التبويب الخاملة تلقائيًا بمجرد تجاوز الحد الذي حددته. تبقى كل صفحة مغلقة في قائمة آخر 48 ساعة وقابلة للبحث في SpotRecall.',
    title: 'إغلاق علامات التبويب تلقائيًا',
    desc: 'يغلق بهدوء علامات التبويب غير النشطة عندما يكون لديك عدد كبير منها مفتوحًا. تبقى الصفحات المغلقة قابلة للبحث في SpotRecall (عدا الفارغة). لا تُمَس أبدًا علامات التبويب المثبّتة والمجمّعة والتي تصدر صوتًا والنشطة.',
    label: 'تفعيل الإغلاق التلقائي',
    note: 'يمكنك إيقافه في أي وقت. لا تُفرَّغ أي نافذة أبدًا، وتحصل علامات التبويب المستعادة حديثًا على مهلة.',
    keepLabel: 'علامات التبويب المفتوحة للاحتفاظ بها',
    keepDesc: 'العدد المستهدف لعلامات التبويب العادية التي تبقى مفتوحة في كل النوافذ (افتراضيًا 12). لا تُحتسب المثبّتة والمجمّعة.',
    logTitle: 'أُغلقت خلال آخر 48 ساعة (4)',
    tag: 'العنوان فقط',
  },
  de: {
    loc: 'de',
    h: 'Tabs einfach schließen.<br/>Jederzeit wiederfinden.',
    p: 'Ungenutzte Tabs schließen sich von selbst, sobald du dein Limit überschreitest. Jede geschlossene Seite bleibt in der 48-Stunden-Liste und in SpotRecall durchsuchbar.',
    title: 'Tabs automatisch schließen',
    desc: 'Schließt unauffällig inaktive Tabs, wenn du zu viele offen hast. Geschlossene Seiten bleiben in SpotRecall durchsuchbar (außer leeren). Angeheftete, gruppierte, tönende und aktive Tabs werden nie angetastet.',
    label: 'Automatisches Schließen aktivieren',
    note: 'Jederzeit abschaltbar. Ein Fenster wird nie geleert, und gerade wiederhergestellte Tabs bekommen eine Schonfrist.',
    keepLabel: 'Geöffnete Tabs behalten',
    keepDesc: 'Zielanzahl normaler Tabs, die über alle Fenster hinweg offen bleiben (Standard 12). Angeheftete und gruppierte Tabs zählen nicht mit.',
    logTitle: 'In den letzten 48 h geschlossen (4)',
    tag: 'nur Titel',
  },
  es: {
    loc: 'es',
    h: 'Cierra pestañas sin miedo.<br/>Encuéntralas cuando quieras.',
    p: 'Las pestañas inactivas se cierran solas cuando superas tu límite. Cada página cerrada queda en la lista de 48 horas y se puede buscar en SpotRecall.',
    title: 'Cierre automático de pestañas',
    desc: 'Cierra discretamente las pestañas inactivas cuando tienes demasiadas abiertas. Las páginas cerradas siguen siendo buscables en SpotRecall (salvo las vacías). Las pestañas fijadas, agrupadas, con sonido y activas nunca se tocan.',
    label: 'Activar el cierre automático',
    note: 'Desactívalo cuando quieras. Nunca se vacía una ventana, y las pestañas restauradas hace poco tienen un periodo de gracia.',
    keepLabel: 'Pestañas abiertas a conservar',
    keepDesc: 'Número objetivo de pestañas normales que permanecen abiertas en todas las ventanas (12 por defecto). Las fijadas y agrupadas no se cuentan.',
    logTitle: 'Cerradas en las últimas 48 h (4)',
    tag: 'solo título',
  },
  fr: {
    loc: 'fr',
    h: 'Fermez sans crainte.<br/>Retrouvez-les à tout moment.',
    p: 'Les onglets inactifs se ferment d’eux-mêmes dès que vous dépassez votre limite. Chaque page fermée reste dans la liste des 48 heures et consultable dans SpotRecall.',
    title: 'Fermeture automatique des onglets',
    desc: 'Ferme discrètement les onglets inactifs quand vous en avez trop d’ouverts. Les pages fermées restent consultables dans SpotRecall (sauf les pages vides). Les onglets épinglés, groupés, sonores et actifs ne sont jamais touchés.',
    label: 'Activer la fermeture automatique',
    note: 'Désactivable à tout moment. Une fenêtre n’est jamais vidée, et les onglets récemment restaurés bénéficient d’un délai de grâce.',
    keepLabel: 'Onglets à garder ouverts',
    keepDesc: 'Nombre cible d’onglets ordinaires à garder ouverts dans toutes les fenêtres (12 par défaut). Les onglets épinglés et groupés ne sont pas comptés.',
    logTitle: 'Fermés ces dernières 48 h (4)',
    tag: 'titre seul',
  },
  hi: {
    loc: 'hi',
    h: 'टैब बेझिझक बंद करें।<br/>जब चाहें फिर पाएँ।',
    p: 'आपकी सीमा पार होते ही निष्क्रिय टैब अपने-आप बंद हो जाते हैं। हर बंद पेज 48 घंटे की सूची में रहता है और SpotRecall में खोजा जा सकता है।',
    title: 'टैब अपने आप बंद करें',
    desc: 'जब बहुत सारे टैब खुले हों तो निष्क्रिय टैब चुपचाप बंद कर देता है। बंद किए गए पेज SpotRecall में खोजे जा सकते हैं (खाली पेजों को छोड़कर)। पिन किए, समूहित, आवाज़ वाले और सक्रिय टैब कभी नहीं छुए जाते।',
    label: 'ऑटो-क्लोज़ चालू करें',
    note: 'इसे कभी भी बंद करें। कोई विंडो कभी खाली नहीं की जाती, और हाल ही में बहाल किए गए टैब को छूट अवधि मिलती है।',
    keepLabel: 'खुले रखे जाने वाले टैब',
    keepDesc: 'सभी विंडो में खुले रखने के लिए सामान्य टैब की लक्षित संख्या (डिफ़ॉल्ट 12)। पिन किए और समूहित टैब नहीं गिने जाते।',
    logTitle: 'पिछले 48 घंटे में बंद (4)',
    tag: 'सिर्फ़ शीर्षक',
  },
  id: {
    loc: 'id',
    h: 'Tutup tab sesuka hati.<br/>Temukan kapan saja.',
    p: 'Tab yang menganggur tertutup sendiri begitu Anda melewati batas. Setiap halaman yang ditutup tetap ada di daftar 48 jam dan dapat dicari di SpotRecall.',
    title: 'Tutup tab otomatis',
    desc: 'Menutup tab tak aktif secara diam-diam saat terlalu banyak tab terbuka. Halaman yang ditutup tetap dapat dicari di SpotRecall (kecuali yang kosong). Tab yang disematkan, dikelompokkan, bersuara, dan aktif tidak pernah disentuh.',
    label: 'Aktifkan penutupan otomatis',
    note: 'Matikan kapan saja. Jendela tidak pernah dikosongkan, dan tab yang baru dipulihkan mendapat masa tenggang.',
    keepLabel: 'Tab yang tetap terbuka',
    keepDesc: 'Jumlah target tab biasa yang tetap terbuka di semua jendela (bawaan 12). Tab yang disematkan dan dikelompokkan tidak dihitung.',
    logTitle: 'Ditutup dalam 48 jam terakhir (4)',
    tag: 'hanya judul',
  },
  it: {
    loc: 'it',
    h: 'Chiudi le schede senza pensieri.<br/>Ritrovale quando vuoi.',
    p: 'Le schede inattive si chiudono da sole quando superi il tuo limite. Ogni pagina chiusa resta nell’elenco delle 48 ore e ricercabile in SpotRecall.',
    title: 'Chiusura automatica delle schede',
    desc: 'Chiude discretamente le schede inattive quando ne hai troppe aperte. Le pagine chiuse restano ricercabili in SpotRecall (tranne quelle vuote). Le schede fissate, raggruppate, con audio e attive non vengono mai toccate.',
    label: 'Attiva la chiusura automatica',
    note: 'Puoi disattivarla in qualsiasi momento. Una finestra non viene mai svuotata e le schede ripristinate di recente hanno un periodo di grazia.',
    keepLabel: 'Schede da tenere aperte',
    keepDesc: 'Numero obiettivo di schede normali da tenere aperte in tutte le finestre (predefinito 12). Le schede fissate e raggruppate non vengono conteggiate.',
    logTitle: 'Chiuse nelle ultime 48 h (4)',
    tag: 'solo titolo',
  },
  ja: {
    loc: 'ja',
    h: 'タブは気軽に閉じて、<br/>いつでも見つける',
    p: '上限を超えると、使っていないタブを自動で閉じます。閉じたページは48時間の一覧に残り、SpotRecall で検索できます。',
    title: 'タブ自動クローズ',
    desc: '開きすぎた非アクティブなタブを静かに閉じます。閉じたページは SpotRecall で検索可能なまま（中身が空のものを除く）。固定・グループ・音声再生中・アクティブなタブは対象外です。',
    label: '自動クローズを有効化',
    note: 'いつでもオフにできます。ウィンドウ最後の1枚は閉じず、復元直後のタブには猶予期間があります。',
    keepLabel: '開いたままにするタブ数',
    keepDesc: '全ウィンドウで開いておく通常タブの目標数（既定 12）。固定・グループタブはカウントされません。',
    logTitle: '直近48時間で閉じたタブ（4）',
    tag: 'タイトルのみ',
  },
  ko: {
    loc: 'ko',
    h: '탭은 마음껏 닫고,<br/>언제든 다시 찾기',
    p: '한도를 넘으면 사용하지 않는 탭이 자동으로 닫힙니다. 닫힌 페이지는 모두 48시간 목록에 남고 SpotRecall에서 검색할 수 있습니다.',
    title: '탭 자동 닫기',
    desc: '탭을 너무 많이 열어 두면 사용하지 않는 탭을 조용히 닫습니다. 닫힌 페이지는 SpotRecall에서 계속 검색할 수 있습니다(내용이 빈 페이지 제외). 고정·그룹·소리 재생 중·현재 탭은 절대 건드리지 않습니다.',
    label: '자동 닫기 사용',
    note: '언제든 끌 수 있습니다. 창이 비워지는 일은 없으며, 방금 복원한 탭에는 유예 시간이 주어집니다.',
    keepLabel: '열어 둘 탭 수',
    keepDesc: '모든 창에서 열어 둘 일반 탭의 목표 개수(기본값 12). 고정 탭과 그룹 탭은 포함되지 않습니다.',
    logTitle: '최근 48시간 동안 닫은 탭 (4)',
    tag: '제목만',
  },
  nl: {
    loc: 'nl',
    h: 'Sluit tabbladen zorgeloos.<br/>Vind ze altijd terug.',
    p: 'Inactieve tabbladen sluiten vanzelf zodra je je limiet passeert. Elke gesloten pagina blijft in de 48-uurslijst staan en doorzoekbaar in SpotRecall.',
    title: 'Tabbladen automatisch sluiten',
    desc: 'Sluit ongemerkt inactieve tabbladen wanneer je er te veel open hebt. Gesloten pagina’s blijven doorzoekbaar in SpotRecall (behalve lege). Vastgezette, gegroepeerde, geluid makende en actieve tabbladen worden nooit aangeraakt.',
    label: 'Automatisch sluiten inschakelen',
    note: 'Op elk moment uit te zetten. Een venster wordt nooit leeggemaakt, en net herstelde tabbladen krijgen een respijtperiode.',
    keepLabel: 'Tabbladen open houden',
    keepDesc: 'Streefaantal gewone tabbladen dat over alle vensters open blijft (standaard 12). Vastgezette en gegroepeerde tabbladen tellen niet mee.',
    logTitle: 'Gesloten in de laatste 48 uur (4)',
    tag: 'alleen titel',
  },
  pl: {
    loc: 'pl',
    h: 'Zamykaj karty śmiało.<br/>Odnajdziesz je zawsze.',
    p: 'Nieużywane karty zamykają się same po przekroczeniu limitu. Każda zamknięta strona trafia na listę z ostatnich 48 godzin i można ją wyszukać w SpotRecall.',
    title: 'Automatyczne zamykanie kart',
    desc: 'Po cichu zamyka nieaktywne karty, gdy masz ich otwartych zbyt wiele. Zamknięte strony pozostają wyszukiwalne w SpotRecall (poza pustymi). Karty przypięte, zgrupowane, odtwarzające dźwięk i aktywne nigdy nie są ruszane.',
    label: 'Włącz automatyczne zamykanie',
    note: 'Możesz to wyłączyć w każdej chwili. Okno nigdy nie zostaje opróżnione, a niedawno przywrócone karty mają okres karencji.',
    keepLabel: 'Karty do zachowania otwartych',
    keepDesc: 'Docelowa liczba zwykłych kart pozostających otwartymi we wszystkich oknach (domyślnie 12). Karty przypięte i zgrupowane nie są liczone.',
    logTitle: 'Zamknięte w ciągu ostatnich 48 godz. (4)',
    tag: 'tylko tytuł',
  },
  pt_BR: {
    loc: 'pt-BR',
    h: 'Feche abas sem medo.<br/>Encontre-as quando quiser.',
    p: 'Abas ociosas se fecham sozinhas quando você passa do seu limite. Toda página fechada fica na lista das últimas 48 horas e pesquisável no SpotRecall.',
    title: 'Fechar abas automaticamente',
    desc: 'Fecha discretamente as abas inativas quando você tem abas demais abertas. As páginas fechadas continuam pesquisáveis no SpotRecall (exceto as vazias). Abas fixadas, agrupadas, com áudio e ativas nunca são tocadas.',
    label: 'Ativar fechamento automático',
    note: 'Desative quando quiser. Uma janela nunca fica vazia, e abas restauradas há pouco têm um período de carência.',
    keepLabel: 'Abas a manter abertas',
    keepDesc: 'Número alvo de abas comuns a manter abertas em todas as janelas (padrão 12). Abas fixadas e agrupadas não são contadas.',
    logTitle: 'Fechadas nas últimas 48 h (4)',
    tag: 'só o título',
  },
  pt_PT: {
    loc: 'pt-PT',
    h: 'Feche separadores à vontade.<br/>Encontre-os quando quiser.',
    p: 'Os separadores inativos fecham-se sozinhos quando ultrapassa o seu limite. Cada página fechada fica na lista das últimas 48 horas e pesquisável no SpotRecall.',
    title: 'Fechar separadores automaticamente',
    desc: 'Fecha discretamente os separadores inativos quando tem demasiados abertos. As páginas fechadas continuam pesquisáveis no SpotRecall (exceto as vazias). Separadores afixados, agrupados, com som e ativos nunca são tocados.',
    label: 'Ativar o fecho automático',
    note: 'Desative quando quiser. Uma janela nunca é esvaziada e os separadores restaurados há pouco têm um período de tolerância.',
    keepLabel: 'Separadores a manter abertos',
    keepDesc: 'Número-alvo de separadores normais a manter abertos em todas as janelas (predefinição 12). Separadores afixados e agrupados não são contados.',
    logTitle: 'Fechados nas últimas 48 h (4)',
    tag: 'só o título',
  },
  ru: {
    loc: 'ru',
    h: 'Закрывайте вкладки смело.<br/>Находите их в любой момент.',
    p: 'Неактивные вкладки закрываются сами, когда вы превышаете лимит. Каждая закрытая страница остаётся в списке за 48 часов и доступна для поиска в SpotRecall.',
    title: 'Автозакрытие вкладок',
    desc: 'Незаметно закрывает неактивные вкладки, когда их открыто слишком много. Закрытые страницы остаются доступными для поиска в SpotRecall (кроме пустых). Закреплённые, сгруппированные, звучащие и активные вкладки никогда не трогаются.',
    label: 'Включить автозакрытие',
    note: 'Отключить можно в любой момент. Окно никогда не опустошается, а недавно восстановленные вкладки получают отсрочку.',
    keepLabel: 'Открытых вкладок для хранения',
    keepDesc: 'Целевое число обычных вкладок, остающихся открытыми во всех окнах (по умолчанию 12). Закреплённые и сгруппированные не учитываются.',
    logTitle: 'Закрыто за последние 48 ч (4)',
    tag: 'только заголовок',
  },
  th: {
    loc: 'th',
    h: 'ปิดแท็บได้ไม่ต้องกังวล<br/>หาเจอได้ทุกเมื่อ',
    p: 'เมื่อเกินขีดจำกัด แท็บที่ไม่ได้ใช้จะปิดเอง ทุกหน้าที่ปิดยังอยู่ในรายการ 48 ชั่วโมง และค้นหาได้ใน SpotRecall',
    title: 'ปิดแท็บอัตโนมัติ',
    desc: 'ปิดแท็บที่ไม่ได้ใช้อย่างเงียบ ๆ เมื่อคุณเปิดแท็บมากเกินไป หน้าที่ปิดไปยังค้นหาได้ใน SpotRecall (ยกเว้นหน้าว่าง) แท็บที่ปักหมุด จัดกลุ่ม มีเสียง และแท็บที่ใช้งานอยู่จะไม่ถูกแตะต้อง',
    label: 'เปิดใช้การปิดอัตโนมัติ',
    note: 'ปิดใช้งานได้ทุกเมื่อ หน้าต่างจะไม่ถูกทำให้ว่าง และแท็บที่เพิ่งกู้คืนจะมีช่วงผ่อนผัน',
    keepLabel: 'แท็บที่เปิดค้างไว้',
    keepDesc: 'จำนวนเป้าหมายของแท็บปกติที่เปิดค้างไว้ในทุกหน้าต่าง (ค่าเริ่มต้น 12) ไม่นับแท็บที่ปักหมุดและจัดกลุ่ม',
    logTitle: 'ปิดไปใน 48 ชม. ที่ผ่านมา (4)',
    tag: 'เฉพาะชื่อ',
  },
  tr: {
    loc: 'tr',
    h: 'Sekmeleri rahatça kapat.<br/>İstediğin an bul.',
    p: 'Sınırını aştığında boştaki sekmeler kendiliğinden kapanır. Kapatılan her sayfa 48 saatlik listede kalır ve SpotRecall’da aranabilir.',
    title: 'Sekmeleri otomatik kapat',
    desc: 'Çok fazla sekme açıkken etkin olmayanları sessizce kapatır. Kapatılan sayfalar SpotRecall’da aranabilir kalır (boş olanlar hariç). Sabitlenmiş, gruplanmış, ses çıkaran ve etkin sekmelere asla dokunulmaz.',
    label: 'Otomatik kapatmayı etkinleştir',
    note: 'İstediğin zaman kapatabilirsin. Bir pencere asla boşaltılmaz ve yeni geri yüklenen sekmelere ek süre tanınır.',
    keepLabel: 'Açık tutulacak sekmeler',
    keepDesc: 'Tüm pencerelerde açık tutulacak normal sekme hedefi (varsayılan 12). Sabitlenmiş ve gruplanmış sekmeler sayılmaz.',
    logTitle: 'Son 48 saatte kapatılanlar (4)',
    tag: 'yalnızca başlık',
  },
  uk: {
    loc: 'uk',
    h: 'Закривайте вкладки сміливо.<br/>Знаходьте їх будь-коли.',
    p: 'Неактивні вкладки закриваються самі, щойно ви перевищуєте ліміт. Кожна закрита сторінка лишається у списку за 48 годин і доступна для пошуку в SpotRecall.',
    title: 'Автозакриття вкладок',
    desc: 'Непомітно закриває неактивні вкладки, коли їх відкрито забагато. Закриті сторінки залишаються доступними для пошуку в SpotRecall (окрім порожніх). Закріплені, згруповані, озвучені та активні вкладки ніколи не чіпаються.',
    label: 'Увімкнути автозакриття',
    note: 'Вимкнути можна будь-коли. Вікно ніколи не спорожняється, а щойно відновлені вкладки отримують відтермінування.',
    keepLabel: 'Відкритих вкладок для збереження',
    keepDesc: 'Цільова кількість звичайних вкладок, що лишаються відкритими в усіх вікнах (типово 12). Закріплені та згруповані не враховуються.',
    logTitle: 'Закрито за останні 48 год (4)',
    tag: 'лише заголовок',
  },
  vi: {
    loc: 'vi',
    h: 'Thoải mái đóng thẻ.<br/>Tìm lại bất cứ lúc nào.',
    p: 'Thẻ không dùng sẽ tự đóng khi bạn vượt giới hạn. Mọi trang đã đóng vẫn nằm trong danh sách 48 giờ và tìm được trong SpotRecall.',
    title: 'Tự động đóng thẻ',
    desc: 'Lặng lẽ đóng các thẻ không hoạt động khi bạn mở quá nhiều. Những trang đã đóng vẫn tìm được trong SpotRecall (trừ trang rỗng). Thẻ đã ghim, đã nhóm, đang phát âm thanh và thẻ hiện hành không bao giờ bị động đến.',
    label: 'Bật tự động đóng',
    note: 'Tắt bất cứ lúc nào. Một cửa sổ không bao giờ bị dọn sạch, và các thẻ vừa khôi phục được một khoảng thời gian ân hạn.',
    keepLabel: 'Thẻ mở cần giữ',
    keepDesc: 'Số thẻ thường mục tiêu cần giữ mở trên mọi cửa sổ (mặc định 12). Thẻ đã ghim và đã nhóm không được tính.',
    logTitle: 'Đã đóng trong 48 giờ qua (4)',
    tag: 'chỉ tiêu đề',
  },
  zh_CN: {
    loc: 'zh-CN',
    h: '标签页放心关，<br/>随时找得回',
    p: '超过上限后，闲置标签页会自动关闭。每个关闭的页面都保留在 48 小时列表中，并可在 SpotRecall 中搜到。',
    title: '自动关闭标签页',
    desc: '当打开的标签页过多时，静默关闭不活跃的标签页。被关闭的页面仍可在 SpotRecall 中搜到（内容为空的除外）。固定、分组、正在播放音频、当前活动的标签页永不处理。',
    label: '启用自动关闭',
    note: '可随时关闭此功能。绝不会清空窗口；刚恢复的标签页有宽限期。',
    keepLabel: '保持打开的标签页数',
    keepDesc: '所有窗口中普通标签页的保留目标数（默认 12）。固定和分组标签页不计入此数。',
    logTitle: '最近 48 小时关闭的标签页（4）',
    tag: '仅标题',
  },
  zh_TW: {
    loc: 'zh-TW',
    h: '分頁放心關，<br/>隨時找得回',
    p: '超過上限後，閒置分頁會自動關閉。每個關閉的頁面都會保留在 48 小時清單中，並可在 SpotRecall 中搜尋。',
    title: '自動關閉分頁',
    desc: '當開啟的分頁過多時，靜默關閉不活躍的分頁。被關閉的頁面仍可在 SpotRecall 中搜到（內容為空的除外）。釘選、分組、正在播放音訊、目前使用中的分頁永不處理。',
    label: '啟用自動關閉',
    note: '可隨時關閉此功能。絕不會清空視窗；剛還原的分頁有寬限期。',
    keepLabel: '保持開啟的分頁數',
    keepDesc: '所有視窗中一般分頁的保留目標數（預設 12）。釘選和分組分頁不計入此數。',
    logTitle: '最近 48 小時關閉的分頁（4）',
    tag: '僅標題',
  },
};

// Mock rows for the closed-tab log. `mins` is minutes ago; the label is produced
// with the same Intl.RelativeTimeFormat thresholds relTime() uses in the UI.
const AC_LOG = [
  { l: 'V', c: '#e2136e', title: 'Sony WH-1000XM5 Review: the new king of noise cancelling', domain: 'theverge.com', mins: 12 },
  { l: 'W', c: '#111827', title: 'The Best Noise-Cancelling Headphones for 2026', domain: 'nytimes.com', mins: 47 },
  { l: 'a', c: '#ff9900', title: 'Amazon.com: Bose QuietComfort Ultra Headphones', domain: 'amazon.com', mins: 180 },
  { l: 'G', c: '#4285f4', title: 'Sign in – Google Accounts', domain: 'google.com', mins: 1200, notIndexed: true },
];

// Mirrors relTime() in src/ui/options.tsx: minutes under an hour, hours above.
function rel(loc, mins) {
  const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
  return mins < 60 ? rtf.format(-mins, 'minute') : rtf.format(-Math.round(mins / 60), 'hour');
}

// The real Options -> "Auto-close tabs" card, rendered with the shipped
// options.css (scoped under .opt) so the art cannot drift from the settings page.
function autoCloseCard(copy) {
  const rows = AC_LOG.map(
    (r) => `<div class="ac-log-row"><div class="ac-log-fav favicon" style="background:${r.c}">${esc(r.l)}</div>
      <div class="ac-log-main"><div class="ac-log-title">${esc(r.title)}</div>
      <div class="ac-log-sub">${esc(r.domain)}${r.notIndexed ? `<span class="ac-log-tag">${esc(copy.tag)}</span>` : ''}</div></div>
      <div class="ac-log-time">${esc(rel(copy.loc, r.mins))}</div></div>`,
  ).join('');
  return `<div class="device wide"><div class="opt"><div class="card">
    <h2>${esc(copy.title)}</h2>
    <p class="desc">${esc(copy.desc)}</p>
    <div class="row"><div><div class="label">${esc(copy.label)}</div><div class="desc">${esc(copy.note)}</div></div>
      <label class="switch"><input type="checkbox" checked/><span class="slider"></span></label></div>
    <div class="row"><div><div class="label">${esc(copy.keepLabel)}</div><div class="desc">${esc(copy.keepDesc)}</div></div>
      <input type="number" style="width:80px" value="12" readonly/></div>
    <div class="row" style="display:block"><div class="label" style="margin-bottom:8px">${esc(copy.logTitle)}</div>
      <div class="ac-log">${rows}</div></div>
  </div></div></div>`;
}

// screenshot-5: privacy / on-device.
const SCREENSHOT_5_LOCALES = {
  en:    { h: 'Private by design.<br/>Nothing leaves<br/>your device.',          p: 'No cloud, no account, no tracking. Fully offline after a one-time setup. Open source.',                                              badge: '100% on-device' },
  ar:    { h: 'خصوصية بالتصميم.<br/>لا شيء يغادر<br/>جهازك.',                   p: 'لا سحابة، لا حساب، لا تتبع. يعمل بالكامل دون اتصال بعد إعداد لمرة واحدة. مفتوح المصدر.',                                         badge: '100% على الجهاز' },
  de:    { h: 'Privat by Design.<br/>Nichts verlässt<br/>dein Gerät.',           p: 'Keine Cloud, kein Konto, kein Tracking. Vollständig offline nach einmaliger Einrichtung. Open Source.',                              badge: '100% auf dem Gerät' },
  es:    { h: 'Privado por diseño.<br/>Nada sale<br/>de tu dispositivo.',        p: 'Sin nube, sin cuenta, sin rastreo. Totalmente sin conexión tras una configuración inicial. Código abierto.',                         badge: '100% en el dispositivo' },
  fr:    { h: 'Privé par conception.<br/>Rien ne quitte<br/>votre appareil.',   p: 'Pas de cloud, pas de compte, pas de suivi. Entièrement hors ligne après une configuration unique. Open source.',                    badge: '100 % sur l’appareil' },
  hi:    { h: 'डिज़ाइन से निजी।<br/>कुछ भी आपका<br/>डिवाइस नहीं छोड़ता।',      p: 'न क्लाउड, न अकाउंट, न ट्रैकिंग। एक बार सेटअप के बाद पूरी तरह ऑफ़लाइन। ओपन सोर्स।',                                          badge: '100% डिवाइस पर' },
  id:    { h: 'Privat berdasarkan desain.<br/>Tidak ada yang<br/>meninggalkan perangkat.', p: 'Tanpa cloud, tanpa akun, tanpa pelacakan. Sepenuhnya offline setelah pengaturan satu kali. Open source.',                  badge: '100% di perangkat' },
  it:    { h: 'Privato per design.<br/>Nulla lascia<br/>il tuo dispositivo.',   p: 'Nessun cloud, nessun account, nessun tracciamento. Completamente offline dopo una configurazione una tantum. Open source.',           badge: '100% sul dispositivo' },
  ja:    { h: '設計からプライベート。<br/>何もあなたの<br/>デバイスを離れない。', p: 'クラウドなし、アカウントなし、追跡なし。一度の設定後は完全オフライン。オープンソース。',                                           badge: '100% オンデバイス' },
  ko:    { h: '설계부터 비공개.<br/>아무것도 기기를<br/>떠나지 않습니다.',       p: '클라우드 없음, 계정 없음, 추적 없음. 한 번 설정 후 완전 오프라인. 오픈 소스.',                                                   badge: '100% 기기 내' },
  nl:    { h: 'Privé by design.<br/>Niets verlaat<br/>je apparaat.',            p: 'Geen cloud, geen account, geen tracking. Volledig offline na eenmalige instelling. Open source.',                                      badge: '100% op het apparaat' },
  pl:    { h: 'Prywatny z założenia.<br/>Nic nie opuszcza<br/>Twojego urządzenia.', p: 'Bez chmury, bez konta, bez śledzenia. W pełni offline po jednorazowej konfiguracji. Open source.',                              badge: '100% na urządzeniu' },
  pt_BR: { h: 'Privado por design.<br/>Nada sai<br/>do seu dispositivo.',       p: 'Sem nuvem, sem conta, sem rastreamento. Totalmente offline após uma configuração única. Código aberto.',                              badge: '100% no dispositivo' },
  pt_PT: { h: 'Privado por design.<br/>Nada sai<br/>do seu dispositivo.',       p: 'Sem cloud, sem conta, sem rastreamento. Totalmente offline após uma configuração única. Open source.',                                 badge: '100% no dispositivo' },
  ru:    { h: 'Приватный по замыслу.<br/>Ничто не покидает<br/>ваше устройство.', p: 'Без облака, без аккаунта, без слежки. Полностью офлайн после единоразовой настройки. Открытый исходный код.',                    badge: '100% на устройстве' },
  th:    { h: 'ออกแบบมาเพื่อความเป็นส่วนตัว<br/>ไม่มีข้อมูลใด<br/>ออกจากเครื่องคุณ', p: 'ไม่มีคลาวด์ ไม่มีบัญชี ไม่มีการติดตาม ออฟไลน์สมบูรณ์หลังตั้งค่าครั้งเดียว โอเพ่นซอร์ส',                            badge: '100% บนเครื่อง' },
  tr:    { h: 'Tasarımdan gelen gizlilik.<br/>Hiçbir şey<br/>cihazını terk etmez.', p: 'Bulut yok, hesap yok, takip yok. Tek seferlik kurulumdan sonra tamamen çevrimdışı. Açık kaynak.',                              badge: '100% cihazda' },
  uk:    { h: 'Приватний за задумом.<br/>Ніщо не покидає<br/>ваш пристрій.',    p: 'Без хмари, без облікового запису, без стеження. Повністю офлайн після одноразового налаштування. Відкритий код.',                   badge: '100% на пристрої' },
  vi:    { h: 'Riêng tư theo thiết kế.<br/>Không có gì rời<br/>khỏi thiết bị của bạn.', p: 'Không cloud, không tài khoản, không theo dõi. Hoàn toàn ngoại tuyến sau một lần thiết lập. Mã nguồn mở.',               badge: '100% trên thiết bị' },
  zh_CN: { h: '隐私优先设计。<br/>任何数据都不<br/>离开你的设备。',               p: '无云端，无账号，无追踪。一次设置后完全离线运行。开放源代码。',                                                                     badge: '100% 本地运行' },
  zh_TW: { h: '隱私優先設計。<br/>任何資料都不<br/>離開你的裝置。',               p: '無雲端，無帳號，無追蹤。一次設定後完全離線執行。開放原始碼。',                                                                      badge: '100% 本機運行' },
};

// Japanese pages — used only in the cross-lingual scene.
const AC1 = { l: 'a', c: '#ff9900', title: "Amazon | 【標準取付工事費込み】COMFEE' エアコン 6畳 2.2kw", snippet: '大風量快適 冷暖房 静音 除湿 内部清浄 ルームエアコン 上下ルーバー 一人暮らし 保証1年', time: '7 min ago' };
const AC2 = { l: 'a', c: '#ff9900', title: "Amazon.co.jp: [2026年モデル] COMFEE' エアコン 10畳", snippet: 'オンライン通販のAmazon公式サイトなら COMFEE インバーター冷暖房 省エネ 6畳〜10畳', time: '8 min ago' };
const KAK = { l: '価', c: '#2f80ff', title: '価格.com - エアコン 人気売れ筋ランキング', snippet: '自分にピッタリのエアコンを選べる 比較・検討 メーカー・畳数・価格で絞り込み', time: 'yesterday' };

// Store order (1.5.0): auto-close leads, then keyword, semantic, history,
// privacy. The SCREENSHOT_<n>_LOCALES tables keep their original scene numbers;
// the output names here and in the localized loops below set the store order.
const scenes = [
  {
    name: 'screenshot-1',
    h: SCREENSHOT_4_LOCALES.en.h,
    p: SCREENSHOT_4_LOCALES.en.p,
    body: autoCloseCard(SCREENSHOT_4_LOCALES.en),
  },
  {
    name: 'screenshot-2',
    h: 'Recall any page,<br/>instantly',
    p: "Blazing-fast keyword search across everything you've visited — error codes, versions, exact titles.",
    body: palette({ value: 'noise cancelling headphones', mode: 'Keyword', sections: [{ rows: ENG_ROWS }] }),
  },
  {
    name: 'screenshot-3',
    h: 'Search by meaning —<br/>across languages',
    p: 'Type in English, find that Japanese page. An on-device model understands intent and bridges languages.',
    body: palette({ value: 'air conditioner installation', mode: 'Semantic', sections: [{ rows: [AC1, AC2, KAK] }] }),
  },
  {
    name: 'screenshot-4',
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
    name: 'screenshot-5',
    h: 'Private by design.<br/>Nothing leaves<br/>your device.',
    p: 'No cloud, no account, no tracking. Fully offline after a one-time setup. Open source.',
    body: palette({ value: 'noise cancelling headphones', mode: 'Keyword', badge: '100% on-device', sections: [{ rows: ENG_ROWS }] }),
  },
];

const iconB64 = (await readFile(join(ROOT, 'src/ui/assets/icon128.png'))).toString('base64');
const ICON = `data:image/png;base64,${iconB64}`;

function doc(css, bodyInner, rtl = false) {
  const dir = rtl ? 'rtl' : 'ltr';
  return `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><style>${tokens}\n${layout}\n${BASE}\n${OPTIONS_CSS}\n${css}</style></head><body dir="${dir}" class="${rtl ? 'rtl' : ''}">${bodyInner}</body></html>`;
}

// Store screenshots (1280x800).
const outputs = scenes.map((scene) => ({
  name: scene.name,
  w: 1280,
  h: 800,
  html: doc(
    SHOT_CSS,
    `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${lines(scene.h)}</h1><p>${lines(scene.p)}</p></div><div class="stage">${scene.body}</div>`,
  ),
}));

// Language-matched keyword-search screenshot per Store listing locale (store
// slot 2). These are uploaded as each locale's localized assets; the five
// primary screenshots stay English in the default listing.
for (const [locale, copy] of Object.entries(SCREENSHOT_1_LOCALES)) {
  outputs.push({
    name: `localized/${locale}/screenshot-2`,
    w: 1280,
    h: 800,
    html: doc(
      SHOT_CSS,
      `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${lines(copy.h)}</h1><p>${lines(copy.p)}</p></div><div class="stage">${palette({
        value: copy.query,
        mode: copy.mode,
        openPanel: copy.openPanel,
        indexed: copy.indexed,
        sections: [{ rows: ENG_ROWS }],
      })}</div>`,
      RTL.has(locale),
    ),
  });
}

// The remaining language-matched screenshots per locale (store slots 3, 4, 1, 5).
for (const [locale, copy] of Object.entries(SCREENSHOT_2_LOCALES)) {
  const s1 = SCREENSHOT_1_LOCALES[locale];
  outputs.push({
    name: `localized/${locale}/screenshot-3`,
    w: 1280,
    h: 800,
    html: doc(
      SHOT_CSS,
      `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${lines(copy.h)}</h1><p>${lines(copy.p)}</p></div><div class="stage">${palette({
        value: copy.query,
        mode: copy.mode,
        openPanel: s1.openPanel,
        indexed: s1.indexed,
        sections: [{ rows: [AC1, AC2, KAK] }],
      })}</div>`,
      RTL.has(locale),
    ),
  });
}

for (const [locale, copy] of Object.entries(SCREENSHOT_3_LOCALES)) {
  const s1 = SCREENSHOT_1_LOCALES[locale];
  outputs.push({
    name: `localized/${locale}/screenshot-4`,
    w: 1280,
    h: 800,
    html: doc(
      SHOT_CSS,
      `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${lines(copy.h)}</h1><p>${lines(copy.p)}</p></div><div class="stage">${palette({
        openPanel: s1.openPanel,
        indexed: s1.indexed,
        hist: [
          'noise cancelling headphones',
          'flexbox center a div',
          'chrome web store review time',
          'typescript satisfies operator',
          'best ramen near me',
        ],
        sections: [],
      })}</div>`,
      RTL.has(locale),
    ),
  });
}

for (const [locale, copy] of Object.entries(SCREENSHOT_4_LOCALES)) {
  outputs.push({
    name: `localized/${locale}/screenshot-1`,
    w: 1280,
    h: 800,
    html: doc(
      SHOT_CSS,
      `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${lines(copy.h)}</h1><p>${lines(copy.p)}</p></div><div class="stage">${autoCloseCard(copy)}</div>`,
      RTL.has(locale),
    ),
  });
}

for (const [locale, copy] of Object.entries(SCREENSHOT_5_LOCALES)) {
  const s1 = SCREENSHOT_1_LOCALES[locale];
  outputs.push({
    name: `localized/${locale}/screenshot-5`,
    w: 1280,
    h: 800,
    html: doc(
      SHOT_CSS,
      `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div><h1>${lines(copy.h)}</h1><p>${lines(copy.p)}</p></div><div class="stage">${palette({
        value: s1.query,
        mode: s1.mode,
        openPanel: s1.openPanel,
        indexed: s1.indexed,
        badge: copy.badge,
        sections: [{ rows: ENG_ROWS }],
      })}</div>`,
      RTL.has(locale),
    ),
  });
}

// Marquee promo (1400x560) — real UI card, tilted.
function marquee(promo, card, rtl) {
  return doc(
    MARQUEE_CSS,
    `<div class="copy"><div class="brandbar"><img src="${ICON}"/><b>SpotRecall</b></div>
     <h1>${lines(promo.mh)}</h1>
     <p>${lines(promo.mp)}</p></div>
     <div class="stage">${palette(card)}</div>`,
    rtl,
  );
}

// Small promo tile (440x280) — icon + name + tagline + search-pill hint.
function smallTile(promo, rtl) {
  return doc(
    SMALL_CSS,
    `<div class="s-brand"><img src="${ICON}"/><b>SpotRecall</b></div>
     <p class="s-tag">${lines(promo.stag)}</p>
     <div class="pill">${SEARCH_SVG}<span>${esc(promo.pill)}</span></div>`,
    rtl,
  );
}

const EN_CARD = { value: 'noise cancelling headphones', mode: 'Keyword', sections: [{ rows: ENG_ROWS }] };

outputs.push({ name: 'promo-marquee-1400x560', w: 1400, h: 560, html: marquee(PROMO_LOCALES.en, EN_CARD, false) });
outputs.push({ name: 'promo-small-440x280', w: 440, h: 280, html: smallTile(PROMO_LOCALES.en, false) });

// One language-matched promo pair per Store locale, uploaded as that locale's
// localized graphic assets. The all-languages promos above stay English.
for (const [locale, promo] of Object.entries(PROMO_LOCALES)) {
  const shot = SCREENSHOT_1_LOCALES[locale];
  if (!shot) throw new Error(`PROMO_LOCALES has ${locale} but SCREENSHOT_1_LOCALES does not`);
  const rtl = RTL.has(locale);
  const card = {
    value: shot.query,
    mode: shot.mode,
    openPanel: shot.openPanel,
    indexed: shot.indexed,
    sections: [{ rows: ENG_ROWS }],
  };
  outputs.push({ name: `localized/${locale}/promo-marquee-1400x560`, w: 1400, h: 560, html: marquee(promo, card, rtl) });
  outputs.push({ name: `localized/${locale}/promo-small-440x280`, w: 440, h: 280, html: smallTile(promo, rtl) });
}

for (const locale of Object.keys(SCREENSHOT_1_LOCALES)) {
  if (!PROMO_LOCALES[locale]) throw new Error(`SCREENSHOT_1_LOCALES has ${locale} but PROMO_LOCALES does not`);
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  for (const o of outputs) {
    await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
    await page.setContent(o.html, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
    // Shrink authored copy until every line fits its box. Translations run much
    // longer than the English original, so fixed sizes would clip or re-wrap.
    await page.evaluate(() => {
      const fit = (selector, min) => {
        for (const el of document.querySelectorAll(selector)) {
          const spans = [...el.querySelectorAll('.ln')];
          const probes = spans.length ? spans : [el];
          const overflows = () => probes.some((n) => n.scrollWidth > el.clientWidth + 0.5);
          let size = parseFloat(getComputedStyle(el).fontSize);
          while (size > min && overflows()) {
            size -= 0.5;
            el.style.fontSize = `${size}px`;
          }
        }
      };
      fit('.copy h1', 30);
      fit('.copy p', 16);
      fit('.s-tag', 12);
      fit('.pill span', 10);
    });
    await new Promise((r) => setTimeout(r, 250));
    const out = join(OUT, `${o.name}.png`);
    await mkdir(dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    await pexec('sips', ['-z', String(o.h), String(o.w), out, '--out', out]); // 2x -> exact size
    console.log(`✓ ${o.name}.png (${o.w}x${o.h})`);
  }
} finally {
  await browser.close();
}
console.log('Done. Images in release-screenshots/.');
