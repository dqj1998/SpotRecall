# SpotRecall — Store Submission Kit (Chrome Web Store + Microsoft Edge Add-ons)

Everything needed to fill both stores' forms. The **same package** works for both.

## Package
- Upload file: `spotrecall-store-1.0.0.zip` (built from `dist/`; `manifest.json` at
  the zip root). Regenerate with:
  ```bash
  npm run build && (cd dist && zip -rq ../spotrecall-store-1.0.0.zip . -x '*.DS_Store')
  ```
- Version: `1.0.0` · Package size: ~5.2 MB (the semantic model is **not** bundled;
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

### Name
`SpotRecall — Local-First Page Recall`

### Summary / short description (≤132 chars)
`Instantly find pages you've visited — private, on-device search over your history by keyword and meaning. No cloud, no tracking.`

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
  page written in another language — the query is translated on-device.
• Truly private & local-first. Your browsing data never leaves your device. No
  account, no cloud sync, no analytics, no tracking. After a one-time model
  download it runs fully offline.
• Light and unobtrusive. It captures only meaningful top-level pages (ads,
  captchas, and tracker frames are ignored), and lets you pause capture, block
  sites, and wipe everything with one click.
• Recent pages & searches at your fingertips, grouped by time.

SpotRecall is open source (AGPL-3.0). Your data stays yours.
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
3. Your recent searches, one click to re-run — remove any with a tap.
4. Recent pages grouped by time, with a content preview instead of a URL.
5. Private by design — 100% on-device. No cloud, no account, no tracking.

---

## Edge Add-ons notes
- Upload the **same** `spotrecall-store-1.0.0.zip`.
- Store logo: **300×300** (`release-screenshots/edge-logo-300.png`).
- Screenshots: 1280×800 (same files).
- Provide the same description, category (Productivity), and privacy policy URL.
- Edge also asks for supported languages and an author/publisher display name.
- **Search terms** (≤7 terms, ≤30 chars each, ≤21 words total → this set is 18 words):
  1. `history search`
  2. `semantic search`
  3. `browsing history recall`
  4. `find visited pages`
  5. `private on-device search`
  6. `AI page finder`
  7. `command palette`

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
