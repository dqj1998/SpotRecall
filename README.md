# SpotRecall

A minimal, local-first context & entry-recall engine for Chrome (MV3). It quietly
indexes the pages you visit and lets you get back to "that page I saw" from a fast
command palette — by keyword and by meaning. **Your data stays 100% on-device;
zero network at runtime.**

Design & architecture: [SpotRecall-dev-plan.md](SpotRecall-dev-plan.md) ·
Privacy: [PRIVACY.md](PRIVACY.md)

## Quick start

```bash
npm install
npm run build            # -> dist/ (~22MB: code + ORT WASM, model NOT bundled)
npm test                 # pure-logic contract tests (39)
```

In Chrome open `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder.

- **Popup (dropdown palette):** click the toolbar icon or press
  `Cmd/Ctrl + Shift + K` → a search panel anchored under the icon. Click a result
  to open it in a new tab.
- **Panel (new tab):** the "Open panel" button in the popup → full panel (semantic
  model download, dashboard, blocklist, backup, privacy).
- **Recent pages / searches:** with an empty query the popup shows recent searches
  (deletable) and recently-visited pages grouped by time; typing switches to
  relevance ranking.
- **Cross-lingual search:** find a page even when your query is in a different
  language — the query is translated on-device before searching (Chrome 138+;
  silently degrades when unavailable).
- **i18n:** English / 日本語 / 简体中文, auto-detected with a manual switcher in the
  popup and panel.
- **Keyword (BM25) search works offline from install.** Semantic search downloads
  a multilingual model (~135MB) once to a local cache; once it finishes, semantic
  search is active and works fully offline afterwards.

### Optional: air-gapped / offline build

To ship the model inside the package so the extension never needs the network:

```bash
npm run download-model   # bake the model into public/models (one-time, online)
npm run build            # -> dist/ with the model (~155MB)
```

The same code supports both local-bundled and runtime-download paths — whether you
run `download-model` decides which is used.

## Architecture

| Context | Responsibility |
|---|---|
| Content `capture` | Capture metadata/text of the top page (and readable same-origin sub-frames); watch interactions & SPA navigations; privacy filtering. Top frame only — ad/captcha iframes are excluded. |
| Popup (palette page) | The action-popup search UI (Preact): keyword + semantic results, recent searches/pages, i18n. |
| Panel (options page) | Dashboard, one-time model download with progress, blocklist, ZIP backup/restore, privacy controls. |
| Service Worker | Message routing + `documentId` staleness guard + capture lifecycle state machine + page-instance table + **sole IndexedDB writer** + GC + telemetry + offscreen management. |
| Offscreen document | Persistent model inference (`multilingual-e5-small`, int8; WebGPU→WASM), in-memory int8 vector store + brute-force search, on-device query translation, tasks replayed from IndexedDB. |

Search: BM25 (MiniSearch, CJK-aware via `Intl.Segmenter`) instant, plus on-device
vector search (async), cross-lingual query translation, weighted RRF fusion, and
relevance-first ordering (time buckets only in the empty-query browse mode).

## Verified in this repo (executable)

- `npm test` — URL normalization/dedup, weighted RRF + multi-list fusion, int8
  quantization scoring (Recall@10 within 2% of the float32 baseline, MRR drop
  < 0.02), timeline bucketing, CJK BM25 tokenization, the page-instance state
  machine (refCount GC / `documentId` staleness / SPA / reload re-commit), DAO
  lifecycle + atomic transactions + LRU retention, and **idempotent backup
  re-import**.
- `npm run build` — clean typecheck, packaged extension, ORT WASM served from the
  extension origin (offline).

## Needs verification in a real Chrome (can't run here)

The code is wired; confirm these locally (see the dev plan §11):

1. **Zero-network / privacy:** BM25 works offline from install; when semantic
   search downloads, use DevTools Network to confirm requests hit only the model
   host and carry no user data; semantic search still works offline once cached;
   WebGPU and WASM fallback both work.
2. **Main flow & SPA:** browse → capture → recall → open; navigating between
   GitHub issues yields a distinct record per URL.
3. **Lifecycle races:** the same URL in two tabs; closing one must not delete the
   shared record; no stale-message overwrites under fast open/close & redirects.
4. **Privacy:** incognito records nothing; blocklisted domains record nothing;
   password/credit-card fields never enter the captured text.
5. **Cross-lingual:** an English query finds a Japanese page (and vice versa)
   after the language pack is available.
6. **Performance benchmark:** on a fixed machine/version, produce P50/P95 for BM25
   / query embedding / dot-product / end-to-end.
7. **Recall quality:** produce Recall@K / MRR / first-hit on a fixed labeled set
   (`npm run eval:recall`, `npm run eval:bench` — see [eval/](eval/)).

## Privacy

Page text is stored in **plaintext** in local IndexedDB — the same exposure as
browser history (other local processes, backup files, DevTools can read it). Not
adding static encryption is a deliberate, threat-model-based decision. Incognito
windows and blocklisted sites are never recorded; form values / passwords /
credit-card fields never enter the captured text. The panel offers global pause,
a per-site blocklist, one-click wipe, and backup export/import.

Full privacy policy (en/zh/ja): [PRIVACY.md](PRIVACY.md).

## Store assets

Submission kit (Chrome Web Store + Microsoft Edge Add-ons): see
[STORE_LISTING.md](STORE_LISTING.md). Screenshots and promo tiles are in
[release-screenshots/](release-screenshots/) and reproducible with
`npm run make-screenshots`.

### Chrome Web Store release workflow

Use this sequence for each Chrome Web Store release.

1. Update the version in `package.json` and `package-lock.json`; update the
  release copy in [STORE_LISTING.md](STORE_LISTING.md) and the localized files
  in [store-listings/](store-listings/README.md).
2. Validate the package before uploading:
  ```bash
  npm run typecheck
  npm test
  npm run build
  npm run make-screenshots
  (cd dist && zip -rq ../spotrecall-store-<version>.zip . -x '*.DS_Store')
  ```
3. Upload the ZIP to the existing Chrome Web Store draft. Confirm its displayed
  version before changing listing metadata.
4. For every Store locale, paste the matching localized name, summary, What's
  New, and detailed description from `store-listings/`.
5. Upload localized screenshots from
  `release-screenshots/localized/<locale>/screenshot-1.png`. These are separate
  from the screenshots for all languages. Each locale must contain **exactly one**
  localized first screenshot; check its thumbnail and delete control after a
  reload. Do not overwrite the all-languages screenshots.
6. Complete **Privacy practices**. Keep each permission explanation aligned with
  the implementation and save the draft. For `bookmarks`, explain that it is
  read only to identify bookmarked HTTP(S) pages and prioritize them in results;
  the extension never adds, changes, or deletes bookmarks.
7. Reload the affected dashboard pages and verify saved values, the package
  version, all 21 localized listings, and localized screenshot counts. Only then
  have the release owner use the Store's review/submit action.

#### Current dashboard references

- Publisher dashboard ID: `8f5c0ca0-da64-4de9-857f-0545491d98cf`
- Extension ID: `lfdjmifmmmimonedmclkpckjebmcabcg`
- Listing editor:
  `https://chrome.google.com/webstore/devconsole/8f5c0ca0-da64-4de9-857f-0545491d98cf/lfdjmifmmmimonedmclkpckjebmcabcg/edit/listing`

#### Local browser connection

1. Log in to the Chrome Web Store dashboard manually in a dedicated Chrome
   profile.
2. Start a separate Chrome instance for local dashboard automation:
   ```bash
   open -na "Google Chrome" --args \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.spotrecall-cdp"
   ```
3. Connect local Playwright tooling to `http://127.0.0.1:9222`.
4. Do not call `browser.close()` or `browser.disconnect()` on a CDP connection;
   that can disrupt the interactive Store session.

This documentation intentionally excludes credentials, cookies, API keys, and
browser session data.

#### Store dashboard lessons

- The Store distinguishes manifest locales, localized listing text, localized
  assets, and all-languages assets. Updating one does not update the others.
- Treat each localized screenshot upload as a replace operation: remove stale or
  duplicate images, upload the locale-matched image, save the draft, then reload
  to confirm exactly one image persists.
- The dashboard's language picker is a custom control. Always confirm the
  selected locale label before uploading or editing; a positional file-input
  selector can target the wrong asset area.
- Deleting a screenshot opens a confirmation dialog. Confirm each deletion before
  uploading the replacement, then save the draft.
- Dashboard controls can re-render during uploads. If a save control disappears,
  reload the relevant locale, check whether the asset persisted, and retry only
  that locale instead of continuing a batch blindly.
- Do not automate the final review submission. A human release owner should make
  the final Store submission after inspecting the completed draft.

## License

AGPL-3.0-only
