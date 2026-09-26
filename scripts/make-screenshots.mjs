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
const CART = { l: 'a', c: '#ff9900', title: 'Amazon.com Shopping Cart', snippet: 'Subtotal (1 item) · Proceed to checkout · Saved for later', time: '2 min ago' };
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
    mh: "Find any page<br/>you've visited",
    mp: 'Private, on-device recall —<br/>by keyword & meaning.',
    stag: "Find any page you've visited —<br/>private, on-device recall.",
    pill: "Search where you've been…",
  },
  ar: {
    mh: 'اعثر على أي صفحة<br/>زرتها',
    mp: 'استرجاع خاص على جهازك —<br/>بالكلمات المفتاحية وبالمعنى.',
    stag: 'اعثر على أي صفحة زرتها —<br/>استرجاع خاص على جهازك.',
    pill: 'ابحث في ما زرته…',
  },
  de: {
    mh: 'Finde jede Seite,<br/>die du besucht hast',
    mp: 'Privates Wiederfinden auf dem Gerät —<br/>per Stichwort & Bedeutung.',
    stag: 'Jede besuchte Seite wiederfinden —<br/>privat, direkt auf dem Gerät.',
    pill: 'Durchsuche, wo du warst…',
  },
  es: {
    mh: 'Encuentra cualquier<br/>página que visitaste',
    mp: 'Recuperación privada en tu dispositivo —<br/>por palabra clave y por significado.',
    stag: 'Encuentra cualquier página visitada —<br/>privado, en tu propio dispositivo.',
    pill: 'Busca dónde has estado…',
  },
  fr: {
    mh: 'Retrouvez chaque page<br/>que vous avez visitée',
    mp: 'Recherche privée sur votre appareil —<br/>par mot-clé et par sens.',
    stag: 'Retrouvez chaque page visitée —<br/>en privé, sur votre appareil.',
    pill: 'Cherchez où vous êtes allé…',
  },
  hi: {
    mh: 'देखा हुआ हर पेज<br/>फिर से पाएँ',
    mp: 'निजी, डिवाइस पर ही खोज —<br/>कीवर्ड से और अर्थ से।',
    stag: 'देखा हुआ हर पेज फिर पाएँ —<br/>निजी, डिवाइस पर ही।',
    pill: 'जहाँ गए थे, वहाँ खोजें…',
  },
  id: {
    mh: 'Temukan setiap halaman<br/>yang pernah Anda buka',
    mp: 'Pencarian privat di perangkat —<br/>lewat kata kunci & makna.',
    stag: 'Temukan halaman yang pernah dibuka —<br/>privat, langsung di perangkat.',
    pill: 'Cari halaman yang pernah dibuka…',
  },
  it: {
    mh: 'Ritrova ogni pagina<br/>che hai visitato',
    mp: 'Ricerca privata sul dispositivo —<br/>per parola chiave e significato.',
    stag: 'Ritrova ogni pagina visitata —<br/>in privato, sul tuo dispositivo.',
    pill: 'Cerca dove sei stato…',
  },
  ja: {
    mh: '見たページを<br/>すべて見つける',
    mp: '端末内で完結するプライベート検索 —<br/>キーワードでも、意味でも。',
    stag: '見たページをすべて見つける —<br/>端末内で完結、プライベート。',
    pill: '訪れたページを検索…',
  },
  ko: {
    mh: '방문한 모든 페이지<br/>다시 찾기',
    mp: '기기 안에서 끝나는 비공개 검색 —<br/>키워드로도, 의미로도.',
    stag: '방문한 모든 페이지를 다시 찾기 —<br/>기기 안에서, 비공개로.',
    pill: '다녀온 페이지 검색…',
  },
  nl: {
    mh: 'Vind elke pagina<br/>die je bezocht',
    mp: 'Privé zoeken op je eigen apparaat —<br/>op trefwoord & betekenis.',
    stag: 'Vind elke bezochte pagina —<br/>privé, op je eigen apparaat.',
    pill: 'Zoek waar je geweest bent…',
  },
  pl: {
    mh: 'Znajdź każdą stronę,<br/>którą odwiedziłeś',
    mp: 'Prywatne wyszukiwanie na urządzeniu —<br/>po słowach kluczowych i znaczeniu.',
    stag: 'Znajdź każdą odwiedzoną stronę —<br/>prywatnie, na swoim urządzeniu.',
    pill: 'Szukaj tam, gdzie byłeś…',
  },
  pt_BR: {
    mh: 'Encontre qualquer página<br/>que você visitou',
    mp: 'Busca privada no seu dispositivo —<br/>por palavra-chave e significado.',
    stag: 'Encontre qualquer página visitada —<br/>privado, no seu próprio dispositivo.',
    pill: 'Busque por onde você passou…',
  },
  pt_PT: {
    mh: 'Encontre qualquer página<br/>que visitou',
    mp: 'Pesquisa privada no seu dispositivo —<br/>por palavra-chave e significado.',
    stag: 'Encontre qualquer página visitada —<br/>privado, no seu próprio dispositivo.',
    pill: 'Pesquise por onde passou…',
  },
  ru: {
    mh: 'Находите любую<br/>посещённую страницу',
    mp: 'Приватный поиск на устройстве —<br/>по ключевым словам и смыслу.',
    stag: 'Находите любую посещённую страницу —<br/>приватно, прямо на устройстве.',
    pill: 'Ищите там, где вы были…',
  },
  th: {
    mh: 'ค้นเจอทุกหน้าเว็บ<br/>ที่คุณเคยเปิด',
    mp: 'ค้นหาแบบส่วนตัวบนเครื่องคุณ —<br/>ด้วยคีเวิร์ดและความหมาย',
    stag: 'ค้นเจอทุกหน้าที่คุณเคยเปิด —<br/>เป็นส่วนตัว บนเครื่องคุณเอง',
    pill: 'ค้นหาหน้าที่คุณเคยเปิด…',
  },
  tr: {
    mh: 'Ziyaret ettiğin her<br/>sayfayı yeniden bul',
    mp: 'Cihazından çıkmayan özel arama —<br/>anahtar kelimeyle ve anlamla.',
    stag: 'Ziyaret ettiğin her sayfayı bul —<br/>özel, tamamen cihazında.',
    pill: 'Gezdiğin sayfalarda ara…',
  },
  uk: {
    mh: 'Знаходьте будь-яку<br/>відвідану сторінку',
    mp: 'Приватний пошук на пристрої —<br/>за ключовими словами та змістом.',
    stag: 'Знаходьте будь-яку відвідану сторінку —<br/>приватно, просто на пристрої.',
    pill: 'Шукайте там, де ви були…',
  },
  vi: {
    mh: 'Tìm lại mọi trang<br/>bạn từng xem',
    mp: 'Tìm kiếm riêng tư ngay trên máy —<br/>theo từ khóa và theo ý nghĩa.',
    stag: 'Tìm lại mọi trang bạn từng xem —<br/>riêng tư, ngay trên máy bạn.',
    pill: 'Tìm trang bạn từng ghé…',
  },
  zh_CN: {
    mh: '找回你看过的<br/>任何网页',
    mp: '本机私密回溯 —<br/>按关键词，也按意思。',
    stag: '找回你看过的任何网页 —<br/>本机私密，数据不外传。',
    pill: '搜索你去过的网页…',
  },
  zh_TW: {
    mh: '找回你看過的<br/>任何網頁',
    mp: '本機私密回溯 —<br/>依關鍵字，也依語意。',
    stag: '找回你看過的任何網頁 —<br/>本機私密，資料不外傳。',
    pill: '搜尋你造訪過的網頁…',
  },
};

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

function doc(css, bodyInner, rtl = false) {
  const dir = rtl ? 'rtl' : 'ltr';
  return `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><style>${tokens}\n${layout}\n${BASE}\n${css}</style></head><body dir="${dir}" class="${rtl ? 'rtl' : ''}">${bodyInner}</body></html>`;
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

// One language-matched first screenshot per Store listing locale. These are
// uploaded as each locale's localized asset; the five primary screenshots stay
// English in the default listing.
for (const [locale, copy] of Object.entries(SCREENSHOT_1_LOCALES)) {
  outputs.push({
    name: `localized/${locale}/screenshot-1`,
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
