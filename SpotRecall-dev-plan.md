# SpotRecall Development Plan (ready-to-build)
> **Chrome Extension (Manifest V3)** · Local-First Context & Entry Recall
> Target: Chrome / Chromium-based browsers (Edge, Brave, …). **Firefox is not
> supported** (no equivalent offscreen API; MV3 differs substantially).
>
> Core principle: **all risks and key contracts are resolved up front at the
> planning stage (see the §9 risk register + §13 contract/test matrix), then
> delivered in one complete pass.** Every contract that could cause a
> deterministic data/result error (primary key & GC, stale-message rejection,
> backup idempotency, vector similarity) is pinned down here with mandatory
> tests, so no phased convergence is needed.

---

## 0. Implementation status (deltas from the original design below — authoritative)

The sections below preserve the original design and its rationale. The shipped
implementation includes these verified adjustments (code and tests are the source
of truth):

1. **Palette form factor:** the original design was an in-page injected Closed
   Shadow DOM overlay. Shipped instead as a **toolbar action popup (anchored
   dropdown)**, plus a **new-tab "panel"** (settings / dashboard / model
   download). No page injection — it opens reliably on any page (incl.
   `chrome://`, the web store, PDFs); the `scripting` permission was removed. The
   `_execute_action` command opens the popup.
2. **Keyboard navigation:** up/down/Enter/Esc removed (too easy to mis-trigger);
   mouse click only.
3. **Result ordering:** the original design used time bucketing. Shipped as
   **relevance-first flat ordering** (time bucketing would push a highly-relevant
   older result below less-relevant recent ones); each row shows a relative time.
   With an **empty query** it enters a "recent browse" mode that groups recent
   pages by time.
4. **Model delivery:** **not bundled by default — the e5-small model
   auto-downloads once at runtime to a local cache, then runs offline** (package
   ~22MB: code + ORT WASM; the ~135MB model is fetched at runtime). Optional
   air-gapped bundling (`download-model`). ORT wasm/jsep is served from the
   extension's own origin (works under the extension CSP; see R-03/R-15b).
5. **Cross-lingual search:** added an **on-device query-translation layer**
   (Chrome `Translator`/`LanguageDetector`, Chrome 138+): the query is translated
   into the UI languages and BM25 + vector run over each variant, then fused.
   Measured, "small + translation" clearly beats a larger model
   (Recall@10 0.71→1.00, MRR 0.40→0.87), so e5-small is kept. Silently degrades
   when unavailable.
6. **BM25 tokenization:** uses `Intl.Segmenter` for CJK segmentation (the default
   tokenizer does not split Chinese/Japanese); `combineWith` = OR; fuzzy removed.
   The "sub-millisecond BM25" target in §5 does not hold on a pathological corpus
   of 50k docs with prefix expansion (measured P95 ~tens of ms); it's much faster
   on real corpora.
7. **i18n:** UI supports en/ja/zh, auto-detected with a manual switcher.
8. **Text & embeddings:** capture prefers `main/article`, strips more boilerplate
   and de-dups repeated nav lines; the embedding covers **title + description +
   body** (not body only).
9. **Persistence:** because `unlimitedStorage` is declared, data is not evicted
   under quota pressure; the `persist()` result is informational only, not an
   alert.
10. **Privacy policy:** see [PRIVACY.md](PRIVACY.md).

---

## 1. Positioning & core value

* **Name:** SpotRecall
* **Positioning:** a minimal, local-first context & entry-recall engine.
* **Differentiation:**
  * **Not a bloated AI knowledge base:** no full-DOM storage, no generative
    summaries (avoids compression loss & hallucination), no browser takeover.
  * **High-precision entry index:** helps users get back to "the place I saw /
    acted on before" (a GitHub issue, an error-fix page, a government form, a
    config console, …).
  * **Local-first, private, light:** no cloud sync, no login, **zero network at
    runtime (model bundled/cached)**, data 100% on-device.
* **Delivery:** a Chrome Extension, Manifest V3, pure client, no backend.
* **License:** AGPLv3

### Three positioning constraints (pinned)
1. **Privacy = zero user-data egress:** browsing/page-text data stays 100% on the
   device; nothing leaves by any path. Non-negotiable.
2. **Model = one-time runtime download + local cache (default), zero network at
   runtime:** the multilingual model is ~135MB; bundling would make the package
   ~155MB. Decision: **not bundled by default** — BM25 keyword search works
   offline from install; the semantic model downloads once (a public asset, no
   user data) and is cached, then fully offline. The same code also supports an
   **offline/air-gapped build** (run `download-model` before the build to bake
   the model into `dist/models` for local loading) for enterprise use. Acceptance:
   BM25 offline from install; once semantic is enabled, network requests hit only
   the model host and never carry user data; offline after caching; WebGPU/WASM
   both paths (§11).
3. **The semantic model must be multilingual:** an English-only model (e.g.
   `all-MiniLM-L6-v2`) is nearly useless for CJK vector search — a correctness
   issue — so a multilingual model is chosen (§5).

---

## 2. System topology & execution contexts

The MV3 background service worker is **ephemeral** (terminated after ~30s idle, no
DOM, limited WebGPU) and **cannot host inference, nor be the single source of
truth for any state**. An **Offscreen Document** is introduced as the persistent
inference host. The four roles are fixed:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Content Script ──INIT/COMMIT (with doc identity)──▶ Service Worker    │
│  (per page / per SPA nav)                     (scheduling hub)          │
│  Palette UI ──SEARCH(queryId)──▶              · message routing & guard │
│             ◀─RESULTS (2 stages, resultVersion) · IndexedDB writer (SoT)│
│                                               · lifecycle SM & instances│
│  Offscreen ◀─EMBED / VECTOR_SEARCH────────────· webNavigation / tabs    │
│   · Transformers.js model resident             · offscreen lifecycle    │
│   · vector store (in-memory Int8 buffer) + brute-force search           │
│   · all inference tasks replayed from the IndexedDB queue (not memory)  │
└──────────────────────────────────────────────────────────────────────┘
   IndexedDB (source of truth): records / vectors / pendingEmbed / instances* / events / meta
   The MiniSearch snapshot is a rebuildable cache only — never the source of truth
```

### Responsibility boundaries (hard constraints)
| Context | Only does | Never does |
|---|---|---|
| **Content Script** | capture metadata/text, watch interactions & SPA routing, send messages | no search, no IndexedDB, no final blocklist ruling |
| **Service Worker** | message routing & **staleness guard**, write IndexedDB, lifecycle state machine & instance table, GC, telemetry, offscreen management | no inference, never treat in-memory state as source of truth |
| **Offscreen Document** | model loading, batch/query embedding, resident vector store + brute-force search, replay tasks from the durable queue | never directly page-accessible, never dequeue-then-drop |
| **Palette UI** | render, keyboard/mouse interaction, send SEARCH (with queryId), render two result stages | no re-ranking logic |

### Message protocol (carries document identity to reject stale messages — see P0-2)
All page→SW messages have their authoritative identity read by the SW from
`chrome.runtime.MessageSender`; **content self-reports are not trusted**:
- `senderIdentity = { tabId, frameId, documentId, incognito }` (`documentId` is
  provided on `MessageSender` since Chrome 106, unique per document load).
- The SW keeps `instances` (in-memory Map keyed `${tabId}:${frameId}`, holding the
  **current** `documentId`). On `COMMIT`/`INIT`, if `sender.documentId` ≠ the
  frame's recorded current `documentId`, it's a **stale message from a superseded
  document and is dropped**.
- All state writes are **conditional upserts** (compare documentId / status);
  never an unconditional overwrite.
- Explicitly handled: redirects, load failures, `tabs.onReplaced`,
  `tabs.onRemoved`, content-script restarts (a restart yields a new documentId,
  auto-invalidating the old instance).

### Reentrant offscreen lifecycle state machine (see P1-5)
States: `NONE → CREATING → LOADING_MODEL → RESTORING_VECTORS → READY`, with
`ERROR/DEGRADED` on failure.
- **Concurrency merge:** a single `ensureOffscreen()` promise all callers await;
  probe existence via `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})`
  to avoid double creation.
- **Crash/disconnect recovery:** on port disconnect or inference failure, reset to
  `NONE` and rebuild on next request; **the keepalive port is not treated as an
  always-alive guarantee** (R-01 residual risk acknowledged).
- **Task replay:** each embedding task is taken from `pendingEmbed` but **not
  dequeued immediately**; on completion, "write vectors + dequeue + update
  record.embedModelId" commit atomically in one IndexedDB transaction. Crash
  mid-task → the task stays queued and is replayed. The in-memory vector buffer
  can always be rebuilt from the `vectors` store.
- **Readiness gate:** only `READY` accepts `VECTOR_SEARCH`; otherwise search
  degrades to BM25-only (UI shows "semantic index loading").

### Version baselines (declared per API)
- `chrome.offscreen`: stable in Chrome 109.
- `MessageSender.documentId` / `webNavigation` documentId: Chrome 106.
- WebGPU: Chrome 113 (falls back to WASM if unavailable).
- **Combined minimum baseline Chrome 116+** (upper bound of the dependencies'
  stable versions, with margin); `manifest.minimum_chrome_version = "116"`.

---

## 3. Capture & lifecycle state machine (SPA, page instances, race-safe)

**Key distinction (see P0-1):**
- **Content record:** a persistent record deduplicated by `id = hash(normalizedUrl)`,
  shared across visits/tabs.
- **Page instance:** one concrete document load, keyed `${tabId}:${frameId}:${documentId}`.
  GC and commit target the instance; **never delete the shared record by URL key
  directly**.

```
[navigation done / SPA route change (webNavigation.onHistoryStateUpdated | onCommitted)]
   → SW updates instances[tab:frame].documentId = new (old instance invalidated)
   → tell content: reset commit state and re-send INIT
        │
        ▼
[Stage 1 Provisional] (SW side):
   · upsert content record: if new -> committedVisits=0, status='provisional'; update lastVisited
   · register the instance, refCount[id]++
   · immediately enters BM25
        │
        ├── 2A active interaction (click/keydown/scroll>half-viewport) ──┐
        └── 2B cumulative foreground dwell reaches 15s ─────────────────┘
        ▼
[Stage 3 Committed] (only if the documentId conditional check passes):
   · status='committed'; committedVisits++ on this instance's first commit
   · extract cleaned text (first 2000 chars, filtered per §12.1); compute contentHash
   · only if contentHash changed: update BM25 + enqueue pendingEmbed (low priority)
        │
        ▼ (instance ends: navigate away / tabs.onRemoved / content restart)
[Stage 4 GC] refCount[id]--; only if refCount==0 AND committedVisits==0 AND status=='provisional'
           → delete record + vector + pendingEmbed entry in one transaction
   (records ever committed by any instance are kept forever; shared multi-tab records are never mis-deleted)
```

**Scroll threshold unit (see P1-8):** the scroll commit threshold is **half a
viewport height**, i.e. `scrollY > innerHeight * 0.5` (prose and code unified; no
more ambiguous `0.5vh`). Boundary values (exactly 0.5; very short unscrollable
pages) are tested.

**Stage 2B timing:** must be a **cumulative foreground timer**
(`visibilitychange` + `document.hasFocus()` driving an accumulator), not a
"15s wall clock after injection". With multiple windows a tab can be visible but
unfocused, which a wall clock would misjudge; background tabs don't count.

---

## 4. Data model (pinned)

### 4.1 Primary key & URL normalization
- `id = sha256(normalizedUrl)` first 16 bytes hex.
- `normalizedUrl`: lowercase host, drop fragment, strip tracking params (`utm_*`,
  `fbclid`, `gclid`, `ref`, `spm`, …), keep semantically meaningful queries.
- **Re-visiting the same URL = upsert the same content record** (update
  `lastVisited`; `committedVisits++` on commit), not a new row. Timeline is
  bucketed by `lastVisited`.
- `contentHash = sha256(cleanText)`; skip re-embedding if unchanged.

### 4.2 IndexedDB stores & transaction boundaries (see P2-16)
| store | keyPath | indexes | notes |
|---|---|---|---|
| `records` | `id` | `lastVisited,domain,status,contentHash` | **source of truth** |
| `vectors` | `id` | — | int8 quantized vectors, 1:1 with records |
| `pendingEmbed` | `id` | `enqueuedAt` | embedding queue |
| `events` | auto | `ts,type` | telemetry |
| `meta` | `key` | — | `schemaVersion,modelId,modelDim,sourceDeviceId,persistGranted` |

- `instances` is an **in-memory SW table** (non-persistent), rebuilt on SW restart
  from `chrome.tabs.query` + `webNavigation`; persisted-record correctness does
  not depend on it.
- **Transaction boundaries:** related cross-store writes (write record + enqueue /
  write vector + dequeue + update record / GC deletes three stores / LRU deletes
  record+vector) must complete in **one IndexedDB `readwrite` transaction**, so no
  "record without vector" / "queue without record" intermediate state occurs.
- `records` fields: `id,url,normalizedUrl,title,domain,description,favicon,cleanText,contentHash,status,firstSeen,lastVisited,committedVisits,embedModelId`.
- **The MiniSearch snapshot is a cache only:** it can be fully rebuilt from
  `records`; if corrupt/stale just rebuild; never the source of truth.
- **Schema migration:** `meta.schemaVersion` monotonically increases; migrate in
  version order in `onupgradeneeded`; on failure keep the old DB and prompt export.

### 4.3 Vector storage & similarity contract (see P0-4, formula pinned)
- **L2-normalize before quantizing:** `u = v / ||v||` (doc and query alike).
- **Symmetric int8 quantization:** `scale = max(|u_i|)/127`; `q_i = round(u_i/scale)`;
  **`zero_point ≡ 0`**. Each stored as `Int8Array(dim) + f32 scale` (384-dim ≈
  388B; 50k ≈ 19MB, resident in the Offscreen document).
- **Query is not quantized** (accuracy): the query is normalized to float32 `uq`.
- **Score (cosine approximation):** `score(doc) = Σ_i (q_i · scale_doc) · uq_i`.
  Since both sides are unit-length this equals a quantized approximation of cosine
  similarity. Take top-K.
- **Search strategy:** a contiguous `Int8Array` buffer + parallel `id`/`scale`
  arrays in the Offscreen document, scanned **brute-force** (50k < 10ms under WASM
  SIMD). Brute force is enough with zero index maintenance up to ≤50k (R3); >80k
  triggers a fallback (R-08).
- **Correctness threshold (mandatory test, §11):** against the float32,
  un-quantized baseline, int8 search has **Recall@10 drop < 2% and MRR drop
  < 0.02**. The test metric is **ranking quality**; isolated cosine error is
  auxiliary only.
- `embedModelId` is stored per record; a model upgrade enqueues everything into
  `pendingEmbed` for re-embedding.

---

## 5. Search architecture (pinned)

### 5.1 Model
- **`multilingual-e5-small`** (384-dim; int8-quantized ≈ 60–70MB, bundled with the
  extension).
- **e5 prefix contract (easy to miss, mandatory):** documents use `passage: <text>`,
  queries use `query: <text>`. Missing prefixes hurt recall noticeably.
- Backend prefers WebGPU, falls back to WASM (SIMD + threads);
  `env.allowRemoteModels=false`, `env.localModelPath` points at the bundled dir.
  **Both paths must pass the offline acceptance** (P1-6).

### 5.2 Two-stage response (per-keystroke instant + async vector)
1. **BM25 instant layer:** MiniSearch returns per keystroke, UI renders immediately
   (`resultVersion=1`).
2. **Vector layer (debounce ~200ms):** embed the query + brute-force search, then
   re-rank with weighted RRF against BM25 and refresh the UI (`resultVersion=2`,
   with a subtle transition). The two stages are correlated by the same `queryId`
   (§8), so a stale query's second stage can't overwrite a newer one.

### 5.3 Weighted RRF
Defaults `bm25Weight=1.2, vectorWeight=1.0, k=60` (BM25 weighted higher for error
codes / versions / exact URLs, matching the "high-precision entry" positioning).
After fusion, bucket by `lastVisited` into the timeline.

```javascript
// hybrid_search.js
export function reciprocalRankFusion(bm25, vec, { k = 60, bm25Weight = 1.2, vectorWeight = 1.0 } = {}) {
  const m = new Map();
  const fuse = (list, w) => list.forEach((item, i) => {
    const cur = m.get(item.id) || { doc: item, score: 0 };
    cur.score += w * (1 / (k + i + 1));
    m.set(item.id, cur);
  });
  fuse(bm25, bm25Weight);
  fuse(vec, vectorWeight);
  return [...m.values()].sort((a, b) => b.score - a.score).map(e => e.doc);
}
```

---

## 6. Background pipeline, performance & persistence

### 6.1 Compute governance
- Serial small batches (batch=4) in the Offscreen document, yielding between
  batches (`await idle` via `requestIdleCallback`/`setTimeout(0)`).
- `pendingEmbed` backpressure: above a threshold, stop accepting re-embeds and keep
  only the latest.
- Power-aware: down-batch when on battery / low power (`navigator.getBattery()`).
- Palette status: `All indexed` / `Indexing N…` (read from the queue count).

### 6.2 Persistence & quota (see P1-13)
- Call `navigator.storage.persist()` at first start and store the **real
  `persisted()` result** in `meta.persistGranted`. **`false` is not a failure** —
  instead: show the eviction risk in settings, guide periodic backups, and use a
  more conservative LRU cap.
- **Retention cap + LRU:** when `records` exceeds the cap (default 100k,
  configurable), evict the oldest by `lastVisited`, deleting `vectors` in the same
  transaction.
- MiniSearch maintained incrementally; serialize a snapshot every N changes or when
  idle; on start rebuild from the snapshot, or fully rebuild from `records` if the
  snapshot is missing/corrupt.

---

## 7. Privacy, security & backup / differential import (pinned)

### 7.1 Threat model & static-encryption decision (see the reserved opinion)
**Attacker model (explicit):**
- Covered: accidental UI exposure (palette contents); brief borrowing of the
  device by others (mitigated by incognito/blocklist/password-field filtering).
- **Not covered:** other user processes on the same machine, physical disk access,
  leaked backup files, DevTools reading IndexedDB directly. These exposures are
  **the same as or higher than browser history**, and users must be aware.
- **No static encryption (a threat-model conclusion, not "encryption is useless"):**
  a local key cannot defend the "not covered" items, and weak encryption creates a
  false sense of safety. **State clearly in settings & README: page text is stored
  in plaintext in local IndexedDB; protecting backup files is the user's
  responsibility; provide one-click wipe and per-site delete.**

### 7.2 Privacy filtering (capability boundary clarified, see P1-7)
- **Scope is DOM-node removal + not collecting form values.** Remove
  `script/style/nav/footer/svg/noscript`, `input/textarea/select` (with their
  values), `[type=password]`, `[autocomplete^=cc-]` (all `cc-number/cc-csc/…`
  variants), `[autocomplete=one-time-code]`. Keep only visible text nodes.
- **No claim of full PII protection** for account/ID info already rendered as body
  text — documented as a known limitation.
- **Blocklist-before-capture ordering:** the SW is the **sole arbiter**. After
  content sends `INIT_PROVISIONAL`, the SW rules using `sender.tab.incognito` and
  the domain blocklist; on a hit it **does not write and replies `STOP_CAPTURE`**,
  and content tears down its commit listeners and stops extracting. Incognito
  windows are never written.
- Non-injectable pages (`chrome://`, `file://`, PDFs, the store, cross-origin
  iframes) are listed as known blind spots.
- End-to-end tests: incognito / blocklisted domain / password field / credit-card
  field / dynamically-inserted sensitive field.

### 7.3 Backup / differential import (idempotency pinned, see P0-3, P2-14)
- **Data semantics = cumulative snapshot (not an event log).** So **merge by
  field rules, never sum**:
  - `lastVisited = max`, `firstSeen = min`, `committedVisits = max` (**not
    summed**), all visit-count-like fields = max;
  - body from the side with the larger `lastVisited`; if `contentHash` differs and
    is newer → enqueue `pendingEmbed`.
  - This is **inherently idempotent**: re-importing the same snapshot leaves
    max/min unchanged.
- **Container = a single ZIP:** `meta.json` (`schemaVersion,modelId,modelDim,exportId,sourceDeviceId,exportedAt`)
  + `records.ndjson` + `vectors.ndjson` (optional; excluded by default; if absent,
  re-embed after import).
- **Atomic import:** unzip & validate `schemaVersion`/size cap → write to a
  **temp store** → after full validation, swap/merge in one transaction → on
  failure/abort discard the temp area, original DB unchanged.
- **Cross-device / cross-model:** `meta.modelId ≠ local` → ignore imported vectors,
  enqueue everything for re-embedding (dimension mismatch is a hard constraint).
- **Idempotency acceptance (mandatory test):** importing the same ZIP twice leaves
  `records`, `committedVisits`, and body text field-for-field unchanged.

---

## 8. Verification metrics & telemetry (correlatable, attributable, see P1-12)

### 8.1 Event schema (`events` store)
`{ ts, type, sessionId, queryId, payload }`, `type ∈ {palette_open, query_input,
results_shown, result_click, open_attempt, open_success, palette_close}`.
- `queryId`: unique per query; the two stages (BM25/vector) share one `queryId`,
  distinguished by `results_shown.payload.resultVersion ∈ {1,2}`, **so one query's
  two stages are not counted as two impressions**.
- `result_click.payload = { queryId, resultVersion, rank, id }`.
- `open_attempt` → `open_success` (only recorded when the new tab's
  `tabs.onUpdated` confirms `complete`), separating "clicked" from "actually
  opened".

### 8.2 Metrics (layered, not conflated)
- **Effective recall click-through** = queries that produced a click / **queries
  that ran an effective search (had input and `results_shown>0`)** (deduped by
  `queryId`; opening without input doesn't count).
- **Open success rate** = `open_success` / `open_attempt` (a separate metric, not
  folded into recall).
- **Offline ranking baseline:** Recall@K / MRR / first-hit from a fixed labeled
  set (§11); **online clicks do not substitute for offline ranking quality**
  (clicks carry selection bias).
- **Latency:** BM25 / query embedding / dot-product / message round-trip /
  end-to-end, measured separately.
- Rendered in a local dashboard, with one-click clear.

---

## 9. Risk register (up-front deep assessment)

> Mitigations are **all delivered in one pass**; "probability/impact" are assessed
> before mitigation; "residual" is what remains after.

| # | Risk | Prob | Impact | Mitigation (delivered) | Residual |
|---|---|---|---|---|---|
| R-01 | SW ephemeral, offscreen not always-alive | High | Fatal | reentrant creation SM + task replay from durable queue + atomic dequeue; keepalive best-effort | Low |
| R-02 | English-only model fails on CJK | High | Fatal | `multilingual-e5-small` + e5 prefix contract | Low |
| R-03 | "zero network" unproven build/runtime | High | High | default runtime download+cache (public asset, no user data) + BM25 offline from install + offline after cache + WebGPU/WASM acceptance; optional air-gapped bundle | Low |
| R-04 | SPA not re-captured | High | High | `webNavigation` + patched pushState reset commit | Low |
| R-05 | primary key vs GC deletes shared record | High | Fatal | content record vs page instance split + refCount + GC by instance only | None |
| R-06 | stale document message overwrites new record | High | Fatal | messages carry authoritative `documentId` + SW staleness guard + conditional upsert | Low |
| R-07 | backup summation breaks idempotency | High | High | cumulative snapshot + field-wise max/min merge (no sum) + idempotency test | None |
| R-08 | int8 similarity undefined → ranking regresses | High | High | normalize→symmetric quant (zp=0)→float query→fixed score formula + Recall/MRR threshold test | Low |
| R-09 | sensitive body stored plaintext | Med | High | threat-model statement + incognito/blocklist/form-value filtering + one-click wipe | Med (known) |
| R-10 | per-keystroke embedding jank | High | Med | BM25 instant + vector debounce 2nd stage + queryId correlation | Low |
| R-11 | vector store >80k brute-force slows | Low | Med | ≤50k brute force; above threshold, fall back to reranking BM25 top-N | Low |
| R-12 | IndexedDB eviction | Med | High | `persist()` + handle real result + prompt/backup when not granted | Low |
| R-13 | large-page innerText reflow jank | Med | Med | commit when idle + clone pruning + 2000-char cap + background defer | Low |
| R-14 | `document.body` null / injection timing | Med | Med | `document_idle` injection + null guard | None |
| R-15 | model upgrade invalidates stored vectors | Low | Med | `embedModelId` per record + background re-embed on change | Low |
| R-15b | bundled-model package too large (~155MB) | Med | Med | not bundled by default, runtime download+cache (package ~22MB: code+ORT WASM; ~135MB model at runtime); optional air-gapped build (~155MB) | Low |
| R-16 | backup format not implementable | Med | Med | single ZIP + schema/size validation + temp-area atomic commit + abort recovery | Low |
| R-17 | store review (`<all_urls>` + capture + model) | Med-High | High | minimal-manifest review experiment + global pause / per-site exclude / one-click wipe + privacy policy | Med |
| R-18 | shortcut vs manifest not closed-loop | Med | Low | `commands` declaration + platform keys + conflict hint + toolbar action fallback | Low |
| R-19 | cross-store non-transactional intermediate state | Med | High | related writes in one IDB transaction + snapshot as cache only + rebuild queue after crash | Low |
| R-20 | performance/recall acceptance not reproducible | Med | Med | fixed device/version/dataset + benchmark scripts + cold/warm split | Low |

---

## 10. Engineering baseline & user controls

- **Platform:** MV3, `minimum_chrome_version="116"`.
- **Language/build:** TypeScript + Vite + `@crxjs/vite-plugin`.
- **Palette UI:** Preact + Closed Shadow DOM. Up/down select, `Enter` opens in a
  new tab, `Esc` closes, mouse compatible. *(Shipped: action popup, no keyboard
  nav — see §0.)*
- **Shortcut (see P2-15):** manifest `commands` declares `toggle-palette`, default
  `Ctrl+Shift+K` (Win/Linux) / `Command+Shift+K` (Mac); Chrome caps at 4 commands;
  users rebind via `chrome://extensions/shortcuts`; conflict hint; **the toolbar
  action click is the fallback entry.** *(Shipped: `_execute_action` opens the
  popup.)*
- **Permissions (see P1-9 / R-17):** `scripting,tabs,storage,unlimitedStorage,webNavigation,offscreen`,
  `host_permissions:["<all_urls>"]`. Run a **minimal-manifest install/review
  experiment** first to check whether `<all_urls>` is truly irreplaceable
  (evaluate `activeTab` + dynamic injection). *(Shipped: `scripting` removed;
  `favicon`, `alarms` added.)*
- **User controls (in acceptance):** global pause, per-site exclude toggle,
  one-click wipe, backup export, per-record delete, privacy policy page.
- **Modules:** `content/` (capture + SPA + filtering), `background/` (routing +
  guard + SM + instance table + writes + GC + telemetry + offscreen management),
  `offscreen/` (model + vector store + replay), `search/` (MiniSearch + RRF),
  `storage/` (DAO + migration + backup import/export), `ui/` (palette + dashboard
  + settings), `shared/` (types + URL normalization + hash + message protocol +
  queryId).

---

## 11. Executable acceptance & measurement protocol (R5)

### 11.1 Measurement protocol (fixed, reproducible, see P1-10)
- **Reference machine:** a specified model + fixed Chrome version; record cold
  (SW/offscreen down, model unloaded) and warm data separately.
- **Data scale:** measure at 10k and 50k `records`.
- **Segmented:** BM25, query embedding, dot-product, message round-trip,
  end-to-end, each P50/P95 (≥200 samples).
- Produce a **reproducible benchmark script + raw results**, committed with the
  repo. *(Shipped: `npm run eval:bench`.)*

### 11.2 Recall labeled set (fixed ground truth, see P1-11)
- Provide a **fixed anonymized dataset** (≥1000), **≥30 queries**, each query's
  relevant URLs and relevance grade, a "hit" definition, and an eval script.
- Metrics: Recall@10, MRR, first-hit; online clicks **do not** replace this offline
  baseline. *(Shipped: `npm run eval:recall`, see [eval/](eval/).)*

### 11.3 Functional & correctness acceptance (all by execution)
1. **Main flow:** browse → capture → commit → recall → click-open, end-to-end.
2. **Lifecycle races:** same URL in two tabs, consecutive SPA nav, redirects, fast
   close — no mis-deletion of shared records, no stale overwrite (repro script).
3. **SPA:** front-end nav between GitHub issues, each URL independently searchable.
4. **Vector correctness:** int8 vs float32 baseline, Recall@10 drop <2%, MRR drop
   <0.02.
5. **Zero-network / privacy:** BM25 offline from install; when semantic is enabled,
   confirm via DevTools Network that requests hit only the model host and carry no
   user data; offline after cache; both WebGPU and WASM pass; clear error/recovery
   on interrupted download / corrupt resource. Optional air-gapped build loads
   locally, fully offline.
6. **Latency:** meets §11.1 (targets fixed once the reference machine is set, no
   longer derived from architecture).
7. **Persistence:** read real `persisted()`; prompt/backup guidance/LRU on false.
8. **Privacy:** incognito leaves no trace; blocklisted domains record nothing;
   password/credit-card/form values never enter body; `STOP_CAPTURE` ordering
   works.
9. **Backup:** export → wipe → import restores identically; **importing the same
   ZIP twice is field-for-field idempotent**; cross-model import triggers
   re-embed; interrupted import leaves the original DB unchanged.
10. **Permissions/review:** minimal-manifest review experiment recorded; global
    pause / per-site exclude / one-click wipe work.

### 11.4 Unit/integration test contracts (R6)
URL normalization & dedup; weighted RRF (single/both sides/weights); lifecycle
state machine (illegal transitions, documentId mismatch drop, refCount GC);
differential merge idempotency (max/min, cross-model re-embed); int8
quant/dequant + score formula; cross-store transaction atomicity (simulate
mid-way failure, no intermediate state); telemetry `queryId` two-stage
correlation.

---

## 12. Core code reference (corrected)

### 12.1 Content Script (SPA re-capture + cumulative foreground timer + null guard + SW-arbitrated filtering)

```javascript
// content_script.js  (injected at document_idle)
(() => {
  let isCommitted = false, stopped = false;
  let fgAccumMs = 0, fgSince = null, tickTimer = null;

  function extractClean() {
    if (!document.body) return '';
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(
      'script,style,nav,footer,svg,noscript,input,textarea,select,' +
      '[type=password],[autocomplete^="cc-"],[autocomplete="one-time-code"]'
    ).forEach(el => el.remove());
    return (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }

  function commitPage() {
    if (isCommitted || stopped) return;
    isCommitted = true; teardown();
    // identity is read by the SW from the sender; content does not self-report tabId/documentId
    chrome.runtime.sendMessage({ type: 'COMMIT_PAGE_RECORD',
      data: { url: location.href, content: extractClean() } });
  }

  const onInteract = () => commitPage();
  const onScroll = () => { if (scrollY > innerHeight * 0.5) commitPage(); }; // half viewport

  function tickForeground() {
    const active = document.visibilityState === 'visible' && document.hasFocus();
    if (active && fgSince === null) fgSince = Date.now();
    if (!active && fgSince !== null) { fgAccumMs += Date.now() - fgSince; fgSince = null; }
    if (fgAccumMs + (fgSince ? Date.now() - fgSince : 0) >= 15000) commitPage();
  }

  function initProvisional() {
    isCommitted = false; stopped = false; fgAccumMs = 0; fgSince = null;
    chrome.runtime.sendMessage({ type: 'INIT_PROVISIONAL_RECORD', data: {
      url: location.href, title: document.title,
      description: document.querySelector('meta[name=description]')?.content || '',
      domain: location.hostname
    }});
    addEventListener('click', onInteract, { capture: true, once: true });
    addEventListener('keydown', onInteract, { capture: true, once: true });
    addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', tickForeground);
    tickTimer = setInterval(tickForeground, 1000);
  }
  function teardown() {
    removeEventListener('click', onInteract, true);
    removeEventListener('keydown', onInteract, true);
    removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', tickForeground);
    clearInterval(tickTimer);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SPA_NAVIGATED') { teardown(); initProvisional(); }
    if (msg.type === 'STOP_CAPTURE') { stopped = true; teardown(); } // SW ruled blocklist/incognito
  });

  initProvisional();
})();
```

### 12.2 Weighted RRF: see §5.3. Similarity scoring: see §4.3.

---

## 13. Contract/test matrix (turning "kickoff-gate experiments" into pinned contracts + mandatory tests)

| Contract | Pinned in | Mandatory test | Acceptance # |
|---|---|---|---|
| page instance vs content record, GC by instance | §3, §4 | lifecycle SM, refCount GC | 11.3-2 |
| documentId stale-message guard, conditional upsert | §2, §3 | documentId mismatch drop | 11.3-2 |
| backup cumulative snapshot + max/min merge idempotency | §7.3 | differential merge idempotency, re-import | 11.3-9 |
| int8 normalize + quantize + score formula | §4.3 | int8 vs float32 Recall/MRR | 11.3-4 |
| zero-network (build + runtime) | §1, §5.1 | offline first-start + request intercept + both paths | 11.3-5 |
| cross-store transaction atomicity | §4.2, §6.2 | no intermediate state on mid-way failure | 11.4 |
| telemetry queryId two-stage correlation | §8 | queryId correlation | 11.4 |

*Note: this plan resolves every contract that could cause a deterministic
data/result error on paper (§9, §13), with mandatory tests and a fixed
measurement protocol, then delivers in one pass per §10–§11, converging by
execution.*
