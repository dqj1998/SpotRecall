# SpotRecall Privacy Policy

_Last updated: 2026-09-21_

SpotRecall is a **local-first** Chrome extension. Your browsing data never leaves
your device. There is no account, no cloud sync, no analytics, and no tracking.

## What is stored
For pages you visit, SpotRecall stores **locally** (in your browser's IndexedDB):
- URL, title, meta description, favicon, visit timestamps;
- a cleaned excerpt of the page's visible text (up to ~2000 characters);
- your local search/usage events (used only for the on-device dashboard).

All of this stays **100% on your device**. It is never sent to any server.

## Network use (the only two, and neither sends your data)
1. **One-time model download.** The semantic search model is downloaded once from
   a public model host (Hugging Face) and cached locally; afterwards it runs fully
   offline. Only the public model is fetched — **none of your browsing data is
   sent**. (You may instead build an air-gapped package that bundles the model.)
2. **On-device translation (optional).** For cross-language search, the extension
   uses Chrome's built-in Translation API, which runs **on your device**. Chrome
   may download language packs; your queries are translated locally and are **not
   sent to any server**.

Nothing else contacts the network at runtime.

## What is never captured
- Incognito windows;
- Sites on your blocklist;
- Password and credit-card form fields (excluded from captured text).

## Storage & exposure
Captured text is stored in **plaintext** in local IndexedDB — the same exposure as
your browser history (other local processes, backup files, and DevTools can read
it). SpotRecall deliberately does not add static encryption (a local key cannot
protect against local access and would give false assurance). Backup files you
export are your responsibility to protect.

## Permissions
- `tabs`, `webNavigation` — detect when pages load / navigate (incl. SPA routes).
- `storage`, `unlimitedStorage` — store the local index without eviction.
- `offscreen` — run the embedding model in a persistent local context.
- `alarms` — low-priority background indexing.
- `favicon` — show site icons from Chrome's local cache (no third-party requests).
- `host_permissions: <all_urls>` — read the content of pages you visit so they can
  be indexed for recall. Content is processed locally only.

## Your controls
- Pause capture at any time;
- Per-site blocklist;
- One-click "clear all data";
- Export / import a local backup.

## Changes
Material changes to this policy will be noted here with an updated date.

---

# 隐私政策（简体中文）

SpotRecall 是**本地优先**的 Chrome 扩展。你的浏览数据**始终不出本机**。无账号、无云端同步、无统计分析、无追踪。

**本地存储的内容**（存于浏览器 IndexedDB）：所访问页面的 URL、标题、meta 描述、favicon、访问时间戳，以及清洗后的可见正文摘要（约 2000 字以内）、本地检索/使用事件（仅用于端侧仪表板）。这些**100% 留在本机**,绝不上传。

**仅有的两处联网,且都不发送你的数据**：
1. **一次性模型下载**——语义模型首次从公开模型主机（Hugging Face）下载并缓存,之后完全离线;只拉取公开模型,**不发送任何浏览数据**。（也可打包内网离线版。）
2. **端侧翻译（可选）**——跨语言搜索使用 Chrome 内置翻译 API,在**本机**运行;Chrome 可能下载语言包,查询在本地翻译,**不发送到任何服务器**。

**永不记录**：无痕窗口、黑名单站点、密码/信用卡表单字段。

**存储与暴露**：正文以**明文**存于本地 IndexedDB,安全边界等同浏览器历史(同机进程、备份文件、DevTools 均可读)。刻意不做静态加密(本地密钥防不住本地访问,只会给虚假安全感)。你导出的备份文件请自行妥善保管。

**权限**：`tabs`/`webNavigation`(感知页面加载与 SPA 导航)、`storage`/`unlimitedStorage`(本地索引不被驱逐)、`offscreen`(常驻本地跑模型)、`alarms`(低优后台索引)、`favicon`(Chrome 本地缓存的站点图标,无第三方请求)、`host_permissions: <all_urls>`(读取你访问页面的内容用于索引,仅本地处理)。

**你的控制**：随时暂停捕获、站点黑名单、一键清空全部数据、导出/导入备份。

---

# プライバシーポリシー（日本語）

SpotRecall は**ローカルファースト**の Chrome 拡張です。閲覧データが端末外に出ることはありません。アカウント・クラウド同期・分析・トラッキングはありません。

**ローカル保存の内容**（ブラウザの IndexedDB）：訪問ページの URL・タイトル・meta 説明・favicon・訪問時刻、クリーニング済み本文の抜粋（約2000文字以内）、ローカルの検索/利用イベント（端末内ダッシュボード用のみ）。すべて**端末内に留まり**、送信されません。

**ネットワーク利用は次の2つのみ（いずれも閲覧データを送りません）**：
1. **モデルの一度きりのダウンロード**——セマンティック検索モデルを公開ホスト（Hugging Face）から一度取得しローカルにキャッシュ、以降は完全オフライン。公開モデルのみ取得し、**閲覧データは送信しません**。
2. **端末内翻訳（任意）**——クロス言語検索に Chrome 内蔵の翻訳 API を**端末上で**使用。Chrome が言語パックを取得する場合がありますが、クエリはローカルで翻訳され、**サーバーには送信されません**。

**記録しないもの**：シークレットウィンドウ、ブロックリストのサイト、パスワード/カード入力欄。

**保存と露出**：本文はローカル IndexedDB に**平文**で保存され、露出範囲はブラウザ履歴と同等です。静的暗号化は意図的に行いません。エクスポートしたバックアップの保護は利用者の責任です。

**あなたの操作**：キャプチャの一時停止、サイトのブロックリスト、全データのワンクリック消去、バックアップの書き出し/読み込み。
