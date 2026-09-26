# SpotRecall — Store Submission Kit (Chrome Web Store + Microsoft Edge Add-ons)

Everything needed to fill both stores' forms. The **same package** works for both.

## Package
- Upload file: `spotrecall-store-1.1.0.zip` (built from `dist/`; `manifest.json` at
  the zip root). Regenerate with:
  ```bash
  npm run build && (cd dist && zip -rq ../spotrecall-store-1.1.0.zip . -x '*.DS_Store')
  ```
- Version: `1.1.0` · Package size: ~5.2 MB (the semantic model is **not** bundled;
  it downloads once at runtime and is cached locally).
- Manifest V3 · minimum Chrome/Chromium 116.

## Assets (in this repo)
- Store icon 128×128: packaged (`src/ui/assets/icon128.png`).
- Screenshots: `release-screenshots/screenshot-1..5.png` — all **1280×800**, real
  UI rendered with mock data (reproducible: `npm run make-screenshots`). Valid for
  both stores (Chrome up to 5, Edge up to 10).
- Chrome promo tiles: `release-screenshots/promo-marquee-1400x560.png` and
  `promo-small-440x280.png` (reproducible: `npm run make-promo`). Optional.
- Edge store logo 300×300: `release-screenshots/edge-logo-300.png`.

---

## Listing copy

### Localized Chrome Web Store listings
Full name, short description, What's New, and detailed-description copy for each
release locale lives in [`store-listings/`](store-listings/README.md). Paste the
matching file into the corresponding Chrome Web Store dashboard localization.

### Name
`SpotRecall — AI Search for Your Browsing History`

### Summary / short description (≤132 chars)
`Search your browsing history by meaning or keyword. The AI runs on your device — your pages and queries never leave it.`

### What's new in 1.1.0
```
Keep your tabs tidy without losing what matters. SpotRecall can now automatically
close inactive tabs after you opt in, while keeping indexed pages searchable.
It never closes active, pinned, grouped, audible, or form-filled tabs, and it
never empties a window. Set the number of tabs to keep and reopen a recently
closed tab from the 48-hour activity log.

Also improved: bookmark and page metadata improve ranking, duplicate results are
collapsed, and semantic-model downloads are validated and retried more reliably.
```

### Detailed description
```
SpotRecall helps you get back to that page you know you saw — a GitHub issue, an
error fix, a government form, a product you compared — without digging through
browser history.

It quietly indexes the pages you visit and lets you recall them from a fast
command palette (Cmd/Ctrl+Shift+K, or click the icon):

• Keyword + meaning. BM25 keyword search finds exact terms (error codes, versions,
  URLs); an on-device AI model adds semantic search so you can describe what you
  remember in your own words.
• Works across languages. Query in English, Japanese, or Chinese and still find a
    page written in another language where Chrome's on-device Translation API is
    available (Chrome 138+). Otherwise, SpotRecall searches in the same language.
  • KEEP TABS TIDY. Optionally close inactive tabs when you have more than your
    chosen limit open. Indexed pages stay searchable. Active, pinned, grouped,
    audible, and form-filled tabs are never closed; neither is the last tab in a
    window. Review and reopen tabs closed in the previous 48 hours.
  • Private & local-first. Page text, titles, URLs, and timestamps are stored in a
    local database on your computer. Your pages and queries are never uploaded.
    There is no account, cloud sync, analytics, or tracking.
  • You stay in control. Pause capture, block sites, export a ZIP backup, or wipe
    everything with one click.
• Recent pages & searches at your fingertips, grouped by time.

  WHEN YOU INSTALL

  SpotRecall immediately indexes the titles and URLs of your bookmarks and open
  tabs. It does not import past browser history. Full-text indexing starts with
  pages you visit and engage with after installation.

  Semantic search downloads a multilingual model of about 135 MB once from a
  public model host and caches it locally. Only the public model is fetched; none
  of your browsing data is sent. After caching, semantic search works offline.

  PRIVACY DETAILS

  SpotRecall records one top-level page at a time. Readable same-origin embedded
  content may be included in that page record; cross-origin frames are not read.
  Incognito windows, blocklisted sites, and password or credit-card form fields
  are never captured.

  SpotRecall is open source (AGPL-3.0).
  Privacy policy: https://github.com/dqj1998/SpotRecall/blob/main/PRIVACY.md
  Source code: https://github.com/dqj1998/SpotRecall
  Questions or problems: https://github.com/dqj1998/SpotRecall/issues
```

  ## Japanese listing (Chrome Web Store dashboard)

  ### Name
  `SpotRecall — 閲覧履歴をAIで検索`

  ### Summary / short description
  `閲覧履歴を意味やキーワードで検索。AIは端末内で動作し、ページ内容や検索語を外部に送信しません。`

  ### What's new in 1.1.0
  ```
  タブをすっきり保てる「タブ自動クローズ」を追加しました。オンにすると、設定した保持数を超えた非アクティブなタブを自動で閉じます。インデックス済みのページは SpotRecall で引き続き検索可能です。

  アクティブ、固定、グループ、音声再生中、入力途中のフォームがあるタブは閉じません。ウィンドウ最後の1枚も残し、直近48時間に閉じたタブは確認・再表示できます。検索順位、重複結果の整理、モデルのダウンロード復旧も改善しました。
  ```

  ### Detailed description
  ```
  「さっき見たページ」を、覚えている言葉や意味から探せるローカル優先の検索です。Cmd/Ctrl+Shift+K で開けます。

  ・キーワードと意味で検索。エラーコード、URL、バージョン番号はキーワード検索で正確に見つけ、多言語AIモデルが意味による検索も補います。
  ・言語をまたいで検索。Chrome の端末内 Translation API が利用できる環境（Chrome 138以降）では、英語・日本語・中国語の検索語から別言語のページを探せます。利用できない場合は同一言語で検索します。
  ・タブ自動クローズ。オンにした場合のみ、保持数を超えた非アクティブなタブを閉じます。インデックス済みのページは検索可能なままです。アクティブ、固定、グループ、音声再生中、入力途中のフォームがあるタブ、各ウィンドウの最後の1枚は対象外です。直近48時間に閉じたタブは確認して再度開けます。
  ・データは端末内に保存。ページ本文、タイトル、URL、時刻はブラウザ内のローカルデータベースに保存され、ページ内容や検索語が送信されることはありません。アカウント、クラウド同期、分析、追跡はありません。

  インストール直後は、ブックマークと開いているタブのタイトル・URLを検索できます。過去の履歴は取り込みません。本文のインデックスは、インストール後に実際に閲覧したページから始まります。

  意味検索では、公開モデルホストから約135 MBの多言語モデルを一度だけダウンロードしてローカルにキャッシュします。取得するのは公開モデルのみで、閲覧データは送信されません。キャッシュ後はオフラインで使えます。

  SpotRecall は AGPL-3.0 のオープンソースです。
  プライバシーポリシー: https://github.com/dqj1998/SpotRecall/blob/main/PRIVACY.md
  ```

  ## Simplified Chinese listing (Chrome Web Store dashboard)

  ### Name
  `SpotRecall — AI 搜索你的浏览历史`

  ### Summary / short description
  `按意思或关键词搜索浏览历史。AI 在本机运行，页面内容与搜索词都不离开你的电脑。`

  ### What's new in 1.1.0
  ```
  新增“自动关闭标签页”：开启后，当标签页超过你设定的保留数量，SpotRecall 会自动关闭不活跃标签页；已收录的页面依然可以搜索。

  当前标签、固定标签、分组标签、正在播放音频的标签、含未提交表单输入的标签均不会被关闭，也绝不会关闭窗口最后一个标签。可查看并重新打开最近48小时自动关闭的标签页。本版还优化了书签和页面元数据排序、重复结果合并，以及模型下载的校验与重试。
  ```

  ### Detailed description
  ```
  SpotRecall 帮你找回“明明见过”的网页。按关键词、按意思搜索，用 Cmd/Ctrl+Shift+K 随时打开。

  ・关键词加语义搜索。关键词搜索擅长错误码、版本号和 URL；本机运行的多语言 AI 模型可按你记得的意思搜索。
  ・跨语言搜索。在 Chrome 138+ 且浏览器提供端侧 Translation API 时，可用中英日任一语言搜索另一种语言的页面；不可用时自动回退为同语言搜索。
  ・自动关闭标签页。仅在你开启后，当打开标签超过保留数量时静默关闭不活跃标签。已收录页面仍可搜索。当前、固定、分组、播放音频、含未提交表单输入的标签页不会被关闭；每个窗口至少保留一个标签。最近48小时关闭的标签可查看并重新打开。
  ・数据留在本机。页面正文、标题、URL 和时间戳只存于浏览器本地数据库；页面内容和搜索词不会上传。没有账号、云同步、分析或追踪。

  安装后会立即索引书签和当前打开标签的标题及 URL。SpotRecall 不导入过去的浏览历史；全文索引从安装后实际浏览并产生交互的页面开始。

  启用语义搜索时，会从公开模型主机一次性下载约135 MB的多语言模型并缓存在本地。下载的仅是公开模型文件，不会发送任何浏览数据；缓存后语义搜索可离线使用。

  SpotRecall 采用 AGPL-3.0 开源。
  隐私政策: https://github.com/dqj1998/SpotRecall/blob/main/PRIVACY.md
  ```

### Category
Chrome: **Productivity** · Edge: **Productivity**

### Language
Primary: English. Also localized in-product: 日本語, 简体中文.

---

## Privacy & permissions (Chrome requires justifications)

**Single purpose:** Help users find and reopen web pages they previously visited,
via a local, private search index of their browsing.

**Remote code:** No. All executable code is bundled. Only a public machine-learning
model file (data, not code) is downloaded once and cached locally.

**Permission justifications:**
| Permission | Justification |
|---|---|
| `tabs` | Open a selected result in a new tab and detect when it finished loading; remove records when their tab closes. |
| `webNavigation` | Detect page loads and in-page (SPA) navigations so pages are indexed as you browse. |
| `storage`, `unlimitedStorage` | Store the local search index on the device without eviction. |
| `offscreen` | Run the on-device embedding model in a persistent local document. |
| `alarms` | Low-priority background indexing. |
| `favicon` | Show site icons from the browser's local favicon cache (no third-party requests). |
| `host_permissions: <all_urls>` | Read the text of pages you visit so they can be indexed for later recall. All processing is local; page content never leaves the device. |

**Data usage disclosures (Chrome "Privacy practices"):**
- Collected & stored **locally only**: website content (page text excerpt) and web
  history (URLs, titles, timestamps). Nothing is transmitted to any server.
- Same-origin embedded content may be included with its top-level page; cross-origin
  frames are not read.
- Not sold. Not transferred to third parties. Not used for creditworthiness/lending.
  Not used for any purpose unrelated to the single purpose above.
- Check the required certifications accordingly (all "we do not…").

**Privacy policy URL:** host [PRIVACY.md](PRIVACY.md). Simplest options:
- GitHub file (renders nicely): `https://github.com/dqj1998/SpotRecall/blob/main/PRIVACY.md`
- or enable GitHub Pages and link the rendered page.

---

## Screenshot captions (screenshot-1..5.png, in order)
1. Recall any page instantly — fast keyword search across your history.
2. Search by meaning, across languages — an English query finds a Japanese page.
3. Start with bookmarks and open tabs — full-text indexing begins as you browse.
4. Recent pages grouped by time, with a content preview instead of a URL.
5. Keep tabs tidy — automatically close inactive tabs without losing searchable pages.

---

## Edge Add-ons notes
- Upload the **same** `spotrecall-store-1.1.0.zip`.
- Store logo: **300×300** (`release-screenshots/edge-logo-300.png`).
- Screenshots: 1280×800 (same files).
- Provide the same description, category (Productivity), and privacy policy URL.
- Edge also asks for supported languages and an author/publisher display name.
- **Promo tiles are per-language on Edge**, unlike the Chrome Web Store. Microsoft
  documents the small tile (440×280) and the large tile (1400×560) as "one per
  language", both optional. Upload the matching pair from
  `release-screenshots/localized/<locale>/promo-{small-440x280,marquee-1400x560}.png`
  for each language instead of reusing the English tiles.
- Partner Center derives the store-listing languages from the `_locales` folder in
  the uploaded package. `public/_locales/` carries the same 21 locales that
  `release-screenshots/localized/` does, so every language gets a matching pair.
- Partner Center offers a **Duplicate** control that copies an asset from one
  language to all others. Do not use it for the tiles — it would overwrite the
  localized ones. It is the right control only for the 300×300 logo.
- Edge allows up to 6 screenshots per language (Chrome allows 5).
- **Search terms** (≤7 terms, ≤30 chars each, ≤21 words total → this set is 18 words):
  1. `history search`
  2. `semantic search`
  3. `find page I visited`
  4. `on-device AI`
  5. `offline search`
  6. `command palette`
  7. `bookmark search`

---

## Pre-submission checklist
- [ ] Host PRIVACY.md at a public URL; paste it into both stores.
- [ ] Confirm all screenshots are 1280×800 (they are).
- [ ] Edge store logo 300×300 generated from the square art.
- [ ] Verify the extension loads from `dist/` unpacked and works offline after the
      one-time model download (real-browser check — see README).
- [ ] Chrome: complete "Privacy practices" (permission justifications + data use).
- [ ] Bump `version` in package.json for each subsequent submission.
```
