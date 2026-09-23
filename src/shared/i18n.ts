// Lightweight runtime i18n (en / ja / zh-CN). Auto-detects browser language and
// supports manual override (persisted, synced across popup & panel). Not using
// chrome.i18n because that is fixed to the browser UI locale (no runtime switch).

export type Lang = 'en' | 'ja' | 'zh';

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '简体' },
];

export function detectLang(): Lang {
  const l = (navigator.language || 'en').toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('ja')) return 'ja';
  return 'en';
}

type Dict = Record<string, string>;

const en: Dict = {
  appName: 'SpotRecall',
  tagline: 'Local-first context & entry recall — your data never leaves this device.',
  searchPlaceholder: "Search where you've been…",
  modeKeyword: 'Keyword',
  modeSemantic: 'Semantic',
  modeKeywordTip: 'Keyword (BM25) matching only. Enable semantic search in the panel.',
  modeSemanticTip: 'Semantic (vector) search is active.',
  openPanel: 'Open panel',
  emptyNoResults: 'No matches',
  emptyStart: 'Type to start recalling',
  bucket_today: 'Today',
  bucket_yesterday: 'Yesterday',
  bucket_week: 'This week',
  bucket_older: 'Earlier',
  statusPaused: 'Paused',
  statusIndexing: 'Indexing {count}…',
  statusAllIndexed: 'All indexed · {count}',
  semanticHintOff: 'Semantic search is off — download the model in the panel to enable it.',
  langLabel: 'Language',
  histLabel: 'Recent searches',
  histRemove: 'Remove',
  recentLabel: 'Recent pages',
  bookmarkLabel: 'Bookmarked',

  // panel
  panelTitle: 'SpotRecall Panel',
  dashboard: 'Dashboard',
  mIndexed: 'Indexed',
  mPending: 'Pending',
  mOpen: 'Open success',
  mOpenTip:
    'Of results you clicked, the share whose page actually finished loading — separates "clicked" from "opened successfully".',
  mCTR: 'Recall click-through',
  mCTRTip: 'Of effective searches (had input and at least one result), the share that led to a click. Higher means results were useful.',
  mMRR: 'MRR',
  mMRRTip:
    'Mean Reciprocal Rank: the average of 1/(rank of the result you clicked). 1.00 = you always clicked the very first result; ~0.50 ≈ 2nd on average; ~0.33 ≈ 3rd. Higher is better — it measures how close to the top the right answer appears.',
  effectiveN: '{n} effective searches',
  openRate: 'open success',
  semanticTitle: 'Semantic search',
  semanticToggle: 'Enable on-device semantic search',
  semanticDesc:
    'Keyword (BM25) search works offline immediately. A multilingual model (~135MB) downloads automatically on first run and is cached locally; once ready, semantic search is active — fully offline. Your data never leaves the device.',
  semanticConfirm:
    'Enabling semantic search downloads a multilingual model (~135MB) once to local cache, then works offline. Download now?',
  semanticReadyNote: 'Once the download completes, semantic search is available automatically.',
  statusLabel: 'Status',
  backendLabel: 'Backend',
  vectorized: 'vectorized',
  stDownloading: 'Downloading {p}%',
  stLoading: 'Loading model',
  stRestoring: 'Restoring vectors',
  stReady: 'Ready',
  stError: 'Error',
  stIdle: 'Not started',
  captureTitle: 'Capture',
  pauseLabel: 'Pause capture',
  pauseDesc: 'When paused, no new pages are recorded. Existing data is kept.',
  blacklistLabel: 'Site blocklist (one domain per line, includes subdomains)',
  saveBlocklist: 'Save blocklist',
  savedBlocklist: 'Blocklist saved',
  backupTitle: 'Backup & restore',
  backupNote:
    'Backup is a single ZIP. Vectors are excluded by default (small; re-computed on import). Re-importing the same backup is idempotent.',
  exportBtn: 'Export backup',
  exportVecBtn: 'Export (with vectors)',
  importBtn: 'Import backup',
  exporting: 'Exporting…',
  importing: 'Importing…',
  importDone: 'Imported {imported}{mismatch}, requeued {requeued}',
  mismatchNote: ' (model mismatch — requeued for re-embedding)',
  storageTitle: 'Storage & privacy',
  persistOn:
    'Storage: persistent (the extension holds the `unlimitedStorage` permission, so your data is not evicted under storage pressure).',
  persistOff: '',
  plaintextNote:
    'Page text is stored in PLAINTEXT in local IndexedDB — same exposure as browser history (other local processes, backup files, DevTools). No static encryption is a deliberate decision. Incognito and blocklisted sites are never recorded; password/credit-card fields never enter the text.',
  clearAll: 'Clear all data',
  clearConfirm: 'Clear all local data? This cannot be undone.',
  cleared: 'Cleared',
  loading: 'Loading…',

  // auto-close
  autoCloseTitle: 'Auto-close tabs',
  autoCloseDesc:
    'Quietly closes inactive tabs when you have too many open. Closed pages stay searchable in SpotRecall (except empty ones). Best-effort — pinned, grouped, audible, and active tabs are never touched.',
  autoCloseLabel: 'Enable auto-close',
  autoCloseNote:
    'Off until you turn it on. A window is never emptied, and recently-restored tabs get a grace period.',
  autoCloseKeepLabel: 'Tabs to keep open',
  autoCloseKeepDesc: 'Target number of open tabs across all normal windows (default 12).',
  autoCloseLogTitle: 'Closed in the last 48h ({n})',
  autoCloseLogEmpty: 'Nothing closed yet.',
  autoCloseIndexed: 'Indexed — searchable in SpotRecall.',
  autoCloseNotIndexed: 'Not indexed (empty page) — not recoverable.',
  autoCloseNotIndexedTag: 'not indexed',
  autoCloseTooltip:
    'Auto-close: quietly closes inactive tabs when you have more than your keep limit open. Already-indexed pages stay searchable here. Pinned, grouped, audible and active tabs are never touched.',
  autoCloseClosed: '{n} closed · 48h',
  autoCloseCountTip: 'View the tabs closed in the last 48h',
  autoCloseReopen: 'Click to reopen',
};

const ja: Dict = {
  appName: 'SpotRecall',
  tagline: 'ローカル優先のコンテキスト＆入口の呼び出し — データは端末外に出ません。',
  searchPlaceholder: 'アクセスした場所を検索…',
  modeKeyword: 'キーワード',
  modeSemantic: 'セマンティック',
  modeKeywordTip: 'キーワード（BM25）検索のみ。パネルでセマンティック検索を有効化できます。',
  modeSemanticTip: 'セマンティック（ベクトル）検索が有効です。',
  openPanel: 'パネルを開く',
  emptyNoResults: '一致する結果がありません',
  emptyStart: 'キーワードを入力して呼び出し',
  bucket_today: '今日',
  bucket_yesterday: '昨日',
  bucket_week: '今週',
  bucket_older: 'それ以前',
  statusPaused: '一時停止中',
  statusIndexing: 'インデックス作成中 {count}…',
  statusAllIndexed: 'インデックス完了 · {count}',
  semanticHintOff: 'セマンティック検索は無効です — パネルでモデルをダウンロードして有効化してください。',
  langLabel: '言語',
  histLabel: '最近の検索',
  histRemove: '削除',
  recentLabel: '最近のページ',
  bookmarkLabel: 'ブックマーク済み',

  panelTitle: 'SpotRecall パネル',
  dashboard: 'ダッシュボード',
  mIndexed: 'インデックス済み',
  mPending: '待機中',
  mOpen: '開封成功率',
  mOpenTip:
    'クリックした結果のうち、ページの読み込みが実際に完了した割合。「クリック」と「正常に開けた」を区別します。',
  mCTR: '有効呼び出しクリック率',
  mCTRTip: '有効な検索（入力があり結果が1件以上）のうち、クリックに至った割合。高いほど結果が役立っている。',
  mMRR: 'MRR',
  mMRRTip:
    '平均逆順位（MRR）：クリックした結果の 1/順位 の平均。1.00＝常に1位をクリック、約0.50＝平均2位、約0.33＝3位。高いほど良く、正解がどれだけ上位に出るかを表す。',
  effectiveN: '有効検索 {n} 回',
  openRate: '開封成功率',
  semanticTitle: 'セマンティック検索',
  semanticToggle: '端末内セマンティック検索を有効化',
  semanticDesc:
    'キーワード（BM25）検索はインストール後すぐオフラインで利用可。多言語モデル（約135MB）は初回に自動ダウンロードしローカルにキャッシュ。準備完了後はセマンティック検索が有効になり、完全オフラインで動作します。データは端末外に出ません。',
  semanticConfirm:
    'セマンティック検索を有効化するには多言語モデル（約135MB）を一度ダウンロードします。以降はオフライン。今すぐダウンロードしますか？',
  semanticReadyNote: 'ダウンロード完了後、自動的にセマンティック検索が利用できます。',
  statusLabel: '状態',
  backendLabel: 'バックエンド',
  vectorized: 'ベクトル化済み',
  stDownloading: 'ダウンロード中 {p}%',
  stLoading: 'モデル読み込み中',
  stRestoring: 'ベクトル復元中',
  stReady: '準備完了',
  stError: 'エラー',
  stIdle: '未起動',
  captureTitle: 'キャプチャ',
  pauseLabel: 'キャプチャを一時停止',
  pauseDesc: '一時停止中は新しいページを記録しません。既存データは保持されます。',
  blacklistLabel: 'サイト ブロックリスト（1行に1ドメイン、サブドメイン含む）',
  saveBlocklist: 'ブロックリストを保存',
  savedBlocklist: 'ブロックリストを保存しました',
  backupTitle: 'バックアップと復元',
  backupNote:
    'バックアップは単一の ZIP。ベクトルは既定で含みません（小さく、インポート時に再計算）。同じバックアップの再インポートは冪等です。',
  exportBtn: 'バックアップを書き出し',
  exportVecBtn: '書き出し（ベクトル込み）',
  importBtn: 'バックアップを読み込み',
  exporting: '書き出し中…',
  importing: '読み込み中…',
  importDone: '{imported} 件をインポート{mismatch}、{requeued} 件を再キュー',
  mismatchNote: '（モデル不一致 — 再ベクトル化のため再キュー）',
  storageTitle: 'ストレージとプライバシー',
  persistOn:
    'ストレージ：永続（拡張は `unlimitedStorage` 権限を持つため、空き容量不足でもデータは削除されません）。',
  persistOff: '',
  plaintextNote:
    'ページ本文はローカル IndexedDB に平文で保存されます — ブラウザ履歴と同等の露出（同一端末の他プロセス、バックアップファイル、DevTools）。静的暗号化を行わないのは意図的な決定です。シークレットとブロックリストのサイトは記録されず、パスワード／カード欄は本文に入りません。',
  clearAll: '全データを消去',
  clearConfirm: 'すべてのローカルデータを消去しますか？元に戻せません。',
  cleared: '消去しました',
  loading: '読み込み中…',

  // auto-close
  autoCloseTitle: 'タブ自動クローズ',
  autoCloseDesc:
    '開きすぎた非アクティブなタブを静かに閉じます。閉じたページは SpotRecall で検索可能なまま（中身が空のものを除く）。ベストエフォート — 固定・グループ・音声再生中・アクティブなタブは対象外です。',
  autoCloseLabel: '自動クローズを有効化',
  autoCloseNote:
    'オンにするまで動作しません。ウィンドウ最後の1枚は閉じず、復元直後のタブには猶予期間があります。',
  autoCloseKeepLabel: '開いたままにするタブ数',
  autoCloseKeepDesc: '通常ウィンドウ全体で開いておく目標タブ数（既定 12）。',
  autoCloseLogTitle: '直近48時間で閉じたタブ（{n}）',
  autoCloseLogEmpty: 'まだ閉じたタブはありません。',
  autoCloseIndexed: 'インデックス済み — SpotRecall で検索できます。',
  autoCloseNotIndexed: '未インデックス（空ページ）— 復元できません。',
  autoCloseNotIndexedTag: '未インデックス',
  autoCloseTooltip:
    '自動クローズ：保持上限を超えたとき、非アクティブなタブを静かに閉じます。インデックス済みのページはここから検索可能。固定・グループ・音声再生中・アクティブなタブは対象外です。',
  autoCloseClosed: '{n} 件 · 48h',
  autoCloseCountTip: '直近48時間で閉じたタブを表示',
  autoCloseReopen: 'クリックで再度開く',
};

const zh: Dict = {
  appName: 'SpotRecall',
  tagline: '本地优先的上下文与入口召回 — 数据始终不出本机。',
  searchPlaceholder: '搜索你去过的地方…',
  modeKeyword: '关键字',
  modeSemantic: '语义',
  modeKeywordTip: '仅关键字（BM25）匹配。可在面板中启用语义搜索。',
  modeSemanticTip: '语义（向量）搜索已生效。',
  openPanel: '打开面板',
  emptyNoResults: '没有匹配结果',
  emptyStart: '输入关键字开始召回',
  bucket_today: '今天',
  bucket_yesterday: '昨天',
  bucket_week: '本周',
  bucket_older: '更早',
  statusPaused: '已暂停',
  statusIndexing: '正在索引 {count} 项…',
  statusAllIndexed: '全部已索引 · {count}',
  semanticHintOff: '语义搜索未启用 — 在面板中下载模型即可开启。',
  langLabel: '语言',
  histLabel: '最近搜索',
  histRemove: '删除',
  recentLabel: '最近页面',
  bookmarkLabel: '已收藏',

  panelTitle: 'SpotRecall 面板',
  dashboard: '仪表板',
  mIndexed: '已索引',
  mPending: '待向量化',
  mOpen: '打开成功率',
  mOpenTip: '在你点击的结果中,页面真正加载完成的比例——区分"点了"和"成功打开"。',
  mCTR: '有效召回点击率',
  mCTRTip: '在"有效检索(有输入且至少一条结果)"中最终产生点击的比例。越高说明结果越有用。',
  mMRR: 'MRR',
  mMRRTip:
    '平均倒数排名(Mean Reciprocal Rank):对你点击的那条结果取 1/排名 再求平均。1.00=每次都点第 1 条;≈0.50≈平均点到第 2 条;≈0.33≈第 3 条。越高越好——它衡量正确结果出现得有多靠前。',
  effectiveN: '有效检索 {n} 次',
  openRate: '打开成功率',
  semanticTitle: '语义搜索',
  semanticToggle: '启用端侧语义检索',
  semanticDesc:
    '关键字（BM25）检索装即离线可用。多语言模型（约 135MB）首次运行时自动下载并缓存到本地；就绪后即启用语义搜索，完全离线。数据始终不出本机。',
  semanticConfirm: '启用语义搜索需一次性下载多语言模型（约 135MB）到本地缓存，之后离线。现在下载？',
  semanticReadyNote: '模型下载完成后，即可自动使用语义搜索。',
  statusLabel: '状态',
  backendLabel: '后端',
  vectorized: '已向量化',
  stDownloading: '下载中 {p}%',
  stLoading: '模型加载中',
  stRestoring: '恢复向量库中',
  stReady: '就绪',
  stError: '出错',
  stIdle: '未启动',
  captureTitle: '捕获',
  pauseLabel: '暂停捕获',
  pauseDesc: '暂停后不再记录新页面，已有数据保留。',
  blacklistLabel: '站点黑名单（每行一个域名，含子域）',
  saveBlocklist: '保存黑名单',
  savedBlocklist: '已保存黑名单',
  backupTitle: '备份与恢复',
  backupNote: '备份为单个 ZIP。默认不含向量（体积小，导入后重算）；同一备份重复导入是幂等的。',
  exportBtn: '导出备份',
  exportVecBtn: '导出（含向量）',
  importBtn: '导入备份',
  exporting: '导出中…',
  importing: '导入中…',
  importDone: '导入 {imported} 条{mismatch}，重排 {requeued} 条',
  mismatchNote: '（模型不一致，已排队重算）',
  storageTitle: '存储与隐私',
  persistOn:
    '存储：持久（扩展已声明 `unlimitedStorage` 权限，数据不会在空间紧张时被浏览器清理）。',
  persistOff: '',
  plaintextNote:
    '正文以明文存于本地 IndexedDB，安全边界等同浏览器历史（同机进程、备份文件、DevTools 均可读）。不做静态加密是经评估的定案。无痕窗口与黑名单站点不记录，密码/信用卡字段不进正文。',
  clearAll: '清空全部数据',
  clearConfirm: '确定清空全部本地数据？此操作不可撤销。',
  cleared: '已清空',
  loading: '载入中…',

  // auto-close
  autoCloseTitle: '自动关闭标签页',
  autoCloseDesc:
    '当打开的标签页过多时，静默关闭不活跃的标签页。被关闭的页面仍可在 SpotRecall 中搜到（内容为空的除外）。尽力而为——固定、分组、正在播放音频、当前活动的标签页永不处理。',
  autoCloseLabel: '启用自动关闭',
  autoCloseNote: '开启前不会动作。绝不关闭窗口最后一个标签页；刚恢复的标签页有宽限期。',
  autoCloseKeepLabel: '保持打开的标签页数',
  autoCloseKeepDesc: '所有普通窗口合计要保留的目标标签页数（默认 12）。',
  autoCloseLogTitle: '最近 48 小时关闭的标签页（{n}）',
  autoCloseLogEmpty: '暂无自动关闭的标签页。',
  autoCloseIndexed: '已收录——可在 SpotRecall 中搜到。',
  autoCloseNotIndexed: '未收录（空页面）——无法找回。',
  autoCloseNotIndexedTag: '未收录',
  autoCloseTooltip:
    '自动关闭：当打开的标签页超过保留上限时，静默关闭不活跃的标签页。已收录的页面仍可在此搜到。固定、分组、正在播放音频、当前活动的标签页永不处理。',
  autoCloseClosed: '已关 {n} · 48h',
  autoCloseCountTip: '查看最近 48 小时自动关闭的标签页',
  autoCloseReopen: '点击重新打开',
};

const dicts: Record<Lang, Dict> = { en, ja, zh };

export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let s = dicts[lang]?.[key] ?? en[key] ?? key;
  if (params) for (const k of Object.keys(params)) s = s.replace(`{${k}}`, String(params[k]));
  return s;
}
