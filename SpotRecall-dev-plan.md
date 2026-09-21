# SpotRecall 开发方案（可开工版）
> **Chrome Extension（Manifest V3）** · Local-First Context & Entry Recall
> 目标平台：Chrome / 基于 Chromium 的浏览器（Edge、Brave 等）。**不支持 Firefox**（无对等 offscreen API，MV3 差异大）。
>
> 核心原则：**风险与关键契约全部前置到规划阶段解决（见第九章风险表 + 第十三章契约与测试对照表），实现时一次性完整交付。** 所有会产生确定性数据/结果错误的契约（主键与 GC、消息防旧、备份幂等、向量相似度）均在本方案定型并配强制测试，故无需分阶段收敛。

---

## 〇、实现现状（与下文原始设计的差异，以此为准）

下文保留原始设计与决策依据；实际实现中有以下经验证的调整（代码与测试为准）：

1. **浮窗形态**：原设计为「页内注入的 Closed Shadow DOM 浮窗」。实际改为 **工具栏 action popup（锚定下拉面板）**，另有一个**新标签页「面板」**（设置/仪表板/LLM 下载）。放弃页内注入——任何页面（含 `chrome://`、商店、PDF）都能可靠呼出;`scripting` 权限已移除。快捷键 `_execute_action` 打开 popup。
2. **键盘导航**：移除上下/回车/Esc（易误操作），改为纯鼠标点击。
3. **结果排序**：原设计「时间分桶」。实际改为 **相关性优先平铺**（时间分桶会把高相关旧结果压到低相关新结果之下）；每行显示相对时间。**空查询**时进入「最近浏览」模式，按时间分桶展示最近页面。
4. **语义模型交付**：**默认不打包、首次运行自动下载 e5-small 到本地缓存后离线**（包 ~22MB：代码+ORT WASM;模型 ~135MB 运行期下载）。可选内网打包（`download-model`）。ORT wasm/jsep 从扩展本地源加载（绕过 CSP，见 R-03/R-15b）。
5. **跨语言检索**：新增**端侧查询翻译层**（Chrome `Translator`/`LanguageDetector`，Chrome 138+）：查询翻成 UI 语言后对每个变体跑 BM25+向量再融合。实测「small+翻译」显著优于换大模型（Recall@10 0.71→1.00、MRR 0.40→0.87），故保留 e5-small。不可用时静默降级。
6. **BM25 分词**：用 `Intl.Segmenter` 做 CJK 分词（默认分词器不切分中日文）;`combineWith` 用 OR;去掉 fuzzy。§5 的「BM25 亚毫秒」目标在 5 万条+前缀展开的病态语料下不成立（实测 P95 ~数十 ms），真实语料快得多。
7. **国际化**：UI 支持 en/ja/zh，自动检测 + 手动切换。
8. **正文与向量**：捕获优先 `main/article`、剔除更多样板并去重复导航行;向量嵌入 **标题+描述+正文**（不只正文）。
9. **持久化**：因声明 `unlimitedStorage`，数据不受配额驱逐;`persist()` 结果仅作参考，不作为告警。
10. **隐私政策**：见 [PRIVACY.md](PRIVACY.md)。

---

## 一、产品定位与核心价值

* **产品名称**：SpotRecall
* **核心定位**：极简本地数字入口与上下文召回引擎（Local-First Context & Entry Recall）。
* **核心差异化**：
  * **不做臃肿的 AI 知识库**：不保存完整 DOM、不做生成式摘要（避免压缩损耗与幻觉）、不接管浏览器。
  * **做高精度动作入口索引**：帮用户找回「之前看过/操作过的地方」（GitHub Issue、报错解决页、政务办理页、配置后台等）。
  * **Local-First 隐私与轻量**：无云端同步、无登录体系、**运行期零网络依赖（模型内置随扩展打包）**，数据 100% 留存本地。
* **交付形态**：Chrome Extension，Manifest V3，纯客户端，无任何后端服务。
* **License**：AGPLv3

### 三条定位约束（已定型）
1. **隐私 = 用户数据零外发**：用户浏览/正文数据 100% 留在本机，任何路径都不外发。这是不可妥协的核心。
2. **模型 = 首次运行时一次性下载 + 本地缓存（默认），运行期零网络**：多语言语义模型体积约 135MB，随包打包会使扩展达 ~155MB。定案为**默认不打包**——BM25 关键字检索装即离线可用；语义模型在用户显式启用时一次性下载（公开资产，不含任何用户数据）并缓存到浏览器 Cache，此后完全离线。同一套代码亦支持**离线/内网打包构建**（构建前运行 `download-model` 即把模型烤进 `dist/models`，走本地加载），供 air-gapped/企业场景。验收改为：BM25 装即离线可用；语义层启用后网络请求仅命中模型主机、绝不含用户数据；缓存后断网可用；WebGPU/WASM 双路径（第十一章）。
3. **语义模型必须多语言**：核心场景大量为中文。英文单语模型（如 `all-MiniLM-L6-v2`）对中文向量检索近乎失效——正确性问题，故选用多语言模型（第五章）。

---

## 二、系统拓扑与执行上下文

MV3 background service worker 是**易失的**（空闲约 30s 回收、无 DOM、WebGPU 受限），**不可承载推理，也不可作为任何状态的唯一事实来源**。引入 **Offscreen Document** 作为常驻推理宿主。四方职责固定如下：

```
┌──────────────────────────────────────────────────────────────────────┐
│  Content Script ──INIT/COMMIT(带文档身份)──▶ Service Worker(调度中枢)   │
│  (每页/每次SPA导航)                          · 消息路由 & 防旧校验        │
│  Palette UI ──SEARCH(queryId)──▶            · IndexedDB 写(唯一事实源)    │
│             ◀─RESULTS(两段, resultVersion)─  · 生命周期状态机 & 实例表    │
│                                              · webNavigation / tabs 事件  │
│  Offscreen ◀─EMBED / VECTOR_SEARCH─────────  · offscreen 生命周期        │
│   · Transformers.js 模型常驻                                            │
│   · 向量库(内存 Int8 缓冲) + 暴力检索                                    │
│   · 所有推理任务从 IndexedDB 队列重放(不依赖内存)                        │
└──────────────────────────────────────────────────────────────────────┘
   IndexedDB(唯一事实源): records / vectors / pendingEmbed / instances* / events / meta
   MiniSearch 快照仅为可重建缓存, 绝不作为唯一事实来源
```

### 职责边界（硬约束）
| 上下文 | 只做 | 绝不做 |
|---|---|---|
| **Content Script** | 捕获元数据/正文、监听交互与 SPA 路由、发消息 | 不检索、不碰 IndexedDB、不做黑名单最终裁决 |
| **Service Worker** | 消息路由与**防旧校验**、写 IndexedDB、生命周期状态机与实例表、GC、埋点、offscreen 管理 | 不做推理、不把内存状态当事实源 |
| **Offscreen Document** | 模型加载、批量/查询向量化、向量库常驻与暴力检索、从持久队列重放任务 | 不直接被页面访问、不做去队列后立即丢弃 |
| **Palette UI** | 呈现、键盘/鼠标交互、发 SEARCH(带 queryId)、渲染两段结果 | 不做重排逻辑 |

### 消息协议（携带文档身份，防旧消息覆盖 —— 见 P0-2）
所有页面→SW 消息由 SW 侧从 `chrome.runtime.MessageSender` 读取权威身份，**不信任 content 自报**：
- `senderIdentity = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, incognito: sender.tab.incognito }`（`documentId` 自 Chrome 106 起随 `MessageSender` 提供，每次文档加载唯一）。
- SW 维护 `instances`（内存 Map，键 `${tabId}:${frameId}`，值含**当前** `documentId`）。收到 `COMMIT`/`INIT` 时，若 `sender.documentId` ≠ 该 frame 记录的当前 `documentId`，判为**旧文档延迟消息，丢弃**。
- 所有状态写入是**带条件的 upsert**（比较 documentId / status），绝无无条件覆盖。
- 明确处理：重定向、加载失败、`tabs.onReplaced`、`tabs.onRemoved`、content script 重启（重启即产生新 documentId，自动失效旧实例）。

### Offscreen 可重入生命周期状态机（见 P1-5）
状态：`NONE → CREATING → LOADING_MODEL → RESTORING_VECTORS → READY`，异常进入 `ERROR/DEGRADED`。
- **并发合并**：单一 `ensureOffscreen()` promise，多个调用者 await 同一个；用 `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` 探测是否已存在，避免重复创建。
- **崩溃/断连恢复**：端口断开或推理请求失败即将状态置 `NONE`，下次请求重建；**不把 keepalive 端口当作永不终止的保证**（R-01 残余风险已知）。
- **任务重放**：每个向量化任务从 `pendingEmbed` 取出后**不立即出队**；完成时在一个 IndexedDB 事务内「写 vectors + 出队 + 更新 record.embedModelId」原子提交。中途崩溃 → 任务仍在队列，下次重放。向量库内存缓冲随时可从 `vectors` 表重建。
- **就绪门**：仅 `READY` 状态接受 `VECTOR_SEARCH`；未就绪时检索自动降级为纯 BM25（UI 状态提示「语义索引加载中」）。

### 版本基线（按 API 分别声明）
- `chrome.offscreen`：稳定于 Chrome 109。
- `MessageSender.documentId` / `webNavigation` documentId：Chrome 106。
- WebGPU：Chrome 113（不可用则回退 WASM）。
- **综合最低基线 Chrome 116+**（取各依赖 API 稳定版的上界并留余量）；`manifest.minimum_chrome_version = "116"`。

---

## 三、数据捕获与生命周期状态机（含 SPA、页面实例、防竞态）

**核心概念区分（见 P0-1）**：
- **内容记录（content record）**：按 `id = hash(normalizedUrl)` 去重的持久记录，跨多次访问/多标签共享。
- **页面实例（page instance）**：一次具体的文档加载，键 `${tabId}:${frameId}:${documentId}`。GC 与转正针对实例，**绝不按 URL 主键直接删共享记录**。

```
[导航完成 / SPA 路由变化(webNavigation.onHistoryStateUpdated 或 onCommitted)]
   → SW 更新 instances[tab:frame].documentId = 新值(旧实例作废)
   → 通知 content: 重置转正状态并重发 INIT
        │
        ▼
【阶段1 Provisional】SW 侧:
   · upsert 内容记录: 若新建 committedVisits=0,status='provisional'; 更新 lastVisited
   · instances 登记该实例, refCount[id]++
   · 立即进 BM25
        │
        ├── 2A 主动交互(click/keydown/scroll>半屏) ──┐
        └── 2B 累计前台停留满 15s ──────────────────┘
        ▼
【阶段3 Committed】(带 documentId 条件校验通过才执行):
   · status='committed'; 该实例首次转正时 committedVisits++
   · 抽取清洗正文(前2000字, 见12.1过滤); 计算 contentHash
   · contentHash 变化才: BM25 更新 + 入 pendingEmbed(低优)
        │
        ▼ (实例结束: 导航离开 / tabs.onRemoved / content 重启)
【阶段4 GC】refCount[id]--; 仅当 refCount==0 且 committedVisits==0 且 status=='provisional'
           → 事务内删除 record + vector + pendingEmbed 项
   (曾被任一实例转正过的记录永久保留; 多标签共享记录不会被误删)
```

**转正阈值单位统一（见 P1-8）**：滚动转正阈值为**半个视口高度**，即 `scrollY > innerHeight * 0.5`（正文与代码统一，不再用易歧义的 `0.5vh`）。边界值（恰好 0.5、极短页面不可滚）写测试。

**阶段 2B 计时口径**：必须是**累计前台计时**（`visibilitychange` + `document.hasFocus()` 驱动累加器），非「注入后 15s 墙钟」。多窗口下标签可能 visible 却未 focus，墙钟会误判；后台标签不计时。

---

## 四、数据模型（已定型）

### 4.1 主键与 URL 归一化
- `id = sha256(normalizedUrl)` 前 16 字节 hex。
- `normalizedUrl`：小写 host、去 fragment、剔除 tracking 参数（`utm_*`、`fbclid`、`gclid`、`ref`、`spm` 等黑名单），保留有语义 query。
- **同 URL 重访 = upsert 同一内容记录**（更新 `lastVisited`；转正时 `committedVisits++`），不新增。时间轴按 `lastVisited` 分桶。
- `contentHash = sha256(cleanText)`；未变跳过重新向量化。

### 4.2 IndexedDB Stores 与事务边界（见 P2-16）
| store | keyPath | 索引 | 说明 |
|---|---|---|---|
| `records` | `id` | `lastVisited,domain,status,contentHash` | **唯一事实源** |
| `vectors` | `id` | — | int8 量化向量，与 records 1:1 |
| `pendingEmbed` | `id` | `enqueuedAt` | 待向量化队列 |
| `events` | auto | `ts,type` | 埋点 |
| `meta` | `key` | — | `schemaVersion,modelId,modelDim,sourceDeviceId,persistGranted` |

- `instances` 为 **SW 内存表**（非持久），随 SW 重启由 `chrome.tabs.query` + `webNavigation` 重建；持久记录的正确性不依赖它。
- **事务边界**：跨 store 的关联写（写 record + 入队 / 写 vector + 出队 + 更新 record / GC 删三表 / LRU 淘汰删 record+vector）必须在**同一 IndexedDB `readwrite` 事务**内完成，保证不出现「有记录无向量」「有队列无记录」的中间态。
- `records` 字段：`id,url,normalizedUrl,title,domain,description,favicon,cleanText,contentHash,status,firstSeen,lastVisited,committedVisits,embedModelId`。
- **MiniSearch 快照仅为缓存**：可从 `records` 全量重建，损坏/落后时重建即可，绝不作为唯一事实来源。
- **Schema 迁移**：`meta.schemaVersion` 单调递增，`onupgradeneeded` 内按版本顺序迁移；迁移失败保留旧库并提示导出。

### 4.3 向量存储与相似度契约（见 P0-4，已定型公式）
- **量化前必须 L2 归一化**：`u = v / ||v||`（文档与查询同样处理）。
- **对称 int8 量化**：`scale = max(|u_i|)/127`；`q_i = round(u_i / scale)`；**`zero_point ≡ 0`**。单条存 `Int8Array(dim) + f32 scale`（384 维 ≈ 388B；5 万条 ≈ 19MB，整块常驻 Offscreen）。
- **查询侧不量化**（保精度）：查询归一化为 float32 `uq`。
- **打分公式（近似余弦）**：`score(doc) = Σ_i (q_i · scale_doc) · uq_i`。因两侧均单位化，等价于余弦相似度的量化近似。取 top-K。
- **检索策略**：Offscreen 内连续 `Int8Array` 大缓冲 + 平行 `id`/`scale` 数组，**暴力**遍历（WASM SIMD 下 5 万条 < 10ms）。≤5 万条暴力足够且零索引维护（R3）；> 8 万触发降级（R-08）。
- **正确性阈值（强制测试，见十一章）**：以 float32 未量化检索为基线，int8 检索 **Recall@10 下降 < 2%，MRR 下降 < 0.02**。测试指标是**排序质量**，孤立的余弦误差仅作辅助。
- `embedModelId` 随记录保存；模型升级 → 全量入 `pendingEmbed` 重算。

---

## 五、检索架构（已定型）

### 5.1 模型
- **`multilingual-e5-small`**（384 维，int8 量化后 ≈ 60–70MB，随扩展打包）。
- **e5 前缀契约（易错，强制）**：文档 `passage: <text>`，查询 `query: <text>`。漏前缀显著掉召回。
- 后端优先 WebGPU，回退 WASM(SIMD+多线程)；`env.allowRemoteModels=false`、`env.localModelPath` 指向打包目录。**两条路径均须通过断网验收**（P1-6）。

### 5.2 双层响应（逐键即时 + 向量异步）
1. **BM25 即时层**：MiniSearch 逐键返回，UI 立刻渲染（`resultVersion=1`）。
2. **向量层（debounce ~200ms）**：对 query 向量化 + 暴力检索，返回后与 BM25 做加权 RRF 重排，UI 二次刷新（`resultVersion=2`，带轻微过渡）。两段结果通过同一 `queryId` 关联（见第八章），避免旧查询的第二段覆盖新查询。

### 5.3 加权 RRF
默认 `bm25Weight=1.2, vectorWeight=1.0, k=60`（BM25 对错误码/版本号/精确 URL 权重更高，契合「高精度入口」定位）。融合后按 `lastVisited` 做时间轴分桶。

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

## 六、后台流水线、性能与持久化

### 6.1 算力治理
- Offscreen 内串行小批（batch=4），批间 `await idle`（`requestIdleCallback`/`setTimeout(0)`）让出主线程。
- `pendingEmbed` 背压：超阈值暂停接收重算，只保留最新。
- 电源感知：`navigator.getBattery()` 放电低电量降批。
- 浮窗状态：`全部已索引` / `正在索引 N 项…`（读队列计数）。

### 6.2 持久化与配额（见 P1-13）
- 首启调用 `navigator.storage.persist()`，**将真实 `persisted()` 结果**存 `meta.persistGranted`。**返回 `false` 不算实现失败**——转而：设置页显式提示驱逐风险、引导定期备份、启用更保守的 LRU 上限。
- **保留上限 + LRU**：`records` 超上限（默认 10 万，可配）按 `lastVisited` 淘汰最旧，同事务删 `vectors`。
- MiniSearch 增量维护；每 N 次变更或空闲时序列化快照；启动优先从快照重建，快照缺失/损坏则从 `records` 全量重建。

---

## 七、隐私、安全与备份/差分导入（已定型）

### 7.1 威胁模型与静态加密决策（见保留意见）
**攻击者模型（显式声明）**：
- 覆盖：不慎的 UI 泄露（浮窗内容）、日常他人短暂借用（incognito/黑名单/密码框过滤缓解）。
- **不覆盖**：同机其他用户进程、他人物理访问磁盘、备份文件外泄、DevTools 直读 IndexedDB。这些暴露面**与浏览器历史相同或更高**，用户须知悉。
- **不做静态加密（作为威胁模型的结论，非"加密无用"的推导）**：本地密钥无法防御上述"不覆盖"项，弱加密制造虚假安全感。**在设置页与 README 明确：正文明文存于本地 IndexedDB；备份文件的保护是用户责任；提供一键清空与按站点删除路径。**

### 7.2 隐私过滤（澄清能力边界，见 P1-7）
- **过滤对象明确为：DOM 节点级移除 + 不采集表单值**。移除 `script/style/nav/footer/svg/noscript`、`input/textarea/select`（连同其值）、`[type=password]`、`[autocomplete^=cc-]`（覆盖 `cc-number/cc-csc/...` 全变体）、`[autocomplete=one-time-code]`。仅保留可见文本节点。
- **不宣称对已渲染成正文的账号/证件信息做全面 PII 防护**——文档如实标注这是已知局限。
- **黑名单加载先于捕获的顺序保证**：SW 为**唯一裁决者**。content 发 `INIT_PROVISIONAL` 后，SW 依据 `sender.tab.incognito`、域名黑名单裁决；命中则**不写库并回 `STOP_CAPTURE`**，content 收到后立即拆除转正监听、不再抽取正文。incognito 窗口一律不写。
- 无法注入页面（`chrome://`、`file://`、PDF、商店页、跨域 iframe）列为已知盲区。
- 端到端测试：incognito / 黑名单域 / 密码框 / 信用卡字段 / 动态插入敏感字段 各一条。

### 7.3 备份 / 差分导入（幂等语义已定型，见 P0-3、P2-14）
- **数据语义 = 累计快照（非事件日志）**。因此**合并按字段规则、不求和**：
  - `lastVisited = max`、`firstSeen = min`、`committedVisits = max`（**不相加**）、`visitCount 类字段一律 max`；
  - 正文取 `lastVisited` 较大一侧；`contentHash` 不同且更新 → 入 `pendingEmbed` 重算。
  - 该规则**天然幂等**：同快照二次导入，max/min 与自身运算结果不变。
- **容器格式 = 单个 ZIP**：`meta.json`（`schemaVersion,modelId,modelDim,exportId,sourceDeviceId,exportedAt`）+ `records.ndjson` + `vectors.bin`（可选，默认不含，缺失则导入后重算）。
- **原子导入**：解压校验 `schemaVersion`/大小上限 → 写入**临时 store** → 全量校验通过后在一个事务内 swap/merge → 失败或中断则丢弃临时区，原库不变。
- **跨设备/跨模型**：`meta.modelId ≠ 本地` → 忽略导入向量，全部入 `pendingEmbed` 重算（维度不兼容硬约束）。
- **幂等验收（强制测试）**：同一 ZIP 导入两次，`records` 与 `committedVisits`、正文逐字段不变。

---

## 八、验证指标与埋点（可关联、可归因，见 P1-12）

### 8.1 事件 schema（`events` store）
`{ ts, type, sessionId, queryId, payload }`，`type ∈ {palette_open, query_input, results_shown, result_click, open_attempt, open_success, palette_close}`。
- `queryId`：每次查询唯一；两段返回（BM25/向量）共享同一 `queryId`，`results_shown.payload.resultVersion ∈ {1,2}` 区分，**避免把一次查询的两段计成两次展示**。
- `result_click.payload = { queryId, resultVersion, rank, id }`。
- `open_attempt` → `open_success`（新标签页 `tabs.onUpdated` 确认 `complete` 才记 success），区分「点了」与「真的打开成功」。

### 8.2 指标（分层，不混淆）
- **有效召回点击率** = 产生点击的查询数 / **发起过有效检索（有输入且 `results_shown>0`）的查询数**（按 `queryId` 去重，呼出未输入不计）。
- **打开成功率** = `open_success` / `open_attempt`（独立指标，不并入召回率）。
- **离线排序基准**：Recall@K / MRR / 首条命中率，来自固定标注集（第十一章），**不以线上点击替代离线排序质量**（点击含选择偏差）。
- **延迟**：BM25 / 查询向量化 / 点积 / 消息往返 / 端到端，分别度量。
- 本地仪表板呈现，可一键清空。

---

## 九、风险登记表（前置深度评估）

> 处置在实现时**一次性落地**；「概率/影响」为未处置时评估；残余为落地后仍存部分。

| # | 风险 | 概率 | 影响 | 处置（本次即实现） | 残余 |
|---|---|---|---|---|---|
| R-01 | SW 易失、Offscreen 非永驻 | 高 | 致命 | 可重入创建状态机 + 任务从持久队列重放 + 原子出队；keepalive 仅尽力 | 低 |
| R-02 | 英文单语模型对中文失效 | 高 | 致命 | `multilingual-e5-small` + e5 前缀契约 | 低 |
| R-03 | 「零网络依赖」构建/运行未证 | 高 | 高 | 模型默认首启下载+缓存（公开资产不含用户数据）+ BM25 装即离线 + 缓存后断网可用 + WebGPU/WASM 双路径验收；可选内网打包 | 低 |
| R-04 | SPA 不重捕 | 高 | 高 | `webNavigation` + patch pushState 重置转正 | 低 |
| R-05 | 主键与 GC 冲突误删共享记录 | 高 | 致命 | 内容记录 vs 页面实例分离 + refCount + 仅按实例 GC | 无 |
| R-06 | 旧文档延迟消息覆盖新记录 | 高 | 致命 | 消息携权威 `documentId` + SW 防旧校验 + 条件 upsert | 低 |
| R-07 | 备份求和破坏幂等 | 高 | 高 | 累计快照 + 字段级 max/min 合并（不求和）+ 幂等测试 | 无 |
| R-08 | int8 检索相似度未定义致排序退化 | 高 | 高 | 归一化→对称量化(zp=0)→查询 float→定分数公式 + Recall/MRR 阈值测试 | 低 |
| R-09 | 敏感正文明文落盘 | 中 | 高 | 威胁模型声明 + incognito/黑名单/表单值过滤 + 一键清空 | 中（已知） |
| R-10 | 逐键向量化卡顿 | 高 | 中 | BM25 即时 + 向量 debounce 二段 + queryId 关联 | 低 |
| R-11 | 向量库 >8 万暴力变慢 | 低 | 中 | ≤5 万暴力；超阈值降级为 BM25 top-N 候选重排 | 低 |
| R-12 | IndexedDB 被驱逐 | 中 | 高 | `persist()` + 真实结果处理 + 未授予时提示/备份引导 | 低 |
| R-13 | 大页面 innerText reflow 卡顿 | 中 | 中 | 空闲时转正 + 克隆剪枝 + 2000 字截断 + 后台延后 | 低 |
| R-14 | `document.body` 空/注入时机 | 中 | 中 | `document_idle` 注入 + 空值保护 | 无 |
| R-15 | 模型升级致存量向量失效 | 低 | 中 | `embedModelId` 随记录 + 变更后台重算 | 低 |
| R-15b | 打包含模型体积过大(~155MB) | 中 | 中 | 默认不打包、首启下载缓存（包 ~22MB：代码+ORT WASM，模型 ~135MB 运行期下载）；可选内网打包构建(~155MB) | 低 |
| R-16 | 备份格式不可实现 | 中 | 中 | 单 ZIP + schema/大小校验 + 临时区原子提交 + 中断恢复 | 低 |
| R-17 | 商店审核（`<all_urls>`+采集+模型） | 中-高 | 高 | 最小 manifest 审核实验 + 全局暂停/站点排除/一键清空 + 隐私政策 | 中 |
| R-18 | 快捷键与 manifest 不闭环 | 中 | 低 | `commands` 声明 + 平台键位 + 冲突提示 + 工具栏 action 兜底 | 低 |
| R-19 | 跨 store 无事务致中间态 | 中 | 高 | 关联写同一 IDB 事务 + 快照仅缓存 + 崩溃重建队列 | 低 |
| R-20 | 性能/召回验收不可复现 | 中 | 中 | 固定设备/版本/数据集 + benchmark 脚本 + 冷热分离 | 低 |

---

## 十、工程基线与用户可控能力

- **平台**：MV3，`minimum_chrome_version="116"`。
- **语言/构建**：TypeScript + Vite + `@crxjs/vite-plugin`。
- **Palette UI**：Preact + Closed Shadow DOM。键盘上下选择、`Enter` 新标签打开、`Esc` 关闭，兼容鼠标。
- **快捷键（见 P2-15）**：manifest `commands` 声明 `toggle-palette`，默认 `Ctrl+Shift+K`（Win/Linux）/ `Command+Shift+K`（Mac）；Chrome 上限 4 个 command；用户改键经 `chrome://extensions/shortcuts`（扩展内不能任意改浏览器 command）；冲突时提示；**工具栏 action 点击为兜底入口**。
- **权限（见 P1-9 / R-17）**：`scripting,tabs,storage,unlimitedStorage,webNavigation,offscreen`，`host_permissions:["<all_urls>"]`。以**最小 manifest 先做安装/审核实验**验证 `<all_urls>` 是否不可替代（评估 `activeTab`+动态注入替代方案）。
- **用户可控能力（纳入验收）**：全局暂停捕获、按站点排除开关、一键清空全部数据、导出备份、按记录删除、隐私政策页。
- **模块**：`content/`（捕获+SPA+过滤）、`background/`（路由+防旧+状态机+实例表+写库+GC+埋点+offscreen 管理）、`offscreen/`（模型+向量库+重放）、`search/`（MiniSearch+RRF）、`storage/`（DAO+迁移+备份导入导出）、`ui/`（Palette+仪表板+设置）、`shared/`（类型+URL 归一化+hash+消息协议+queryId）。

---

## 十一、可执行验收标准与测量协议（R5）

### 11.1 测量协议（固定，保证可复现，见 P1-10）
- **基准机**：指定一台机型 + 固定 Chrome 版本；记录冷启动（SW/Offscreen 未起、模型未载）与热启动分别数据。
- **数据规模**：分别在 1 万 / 5 万条 `records` 下测。
- **分段度量**：BM25、查询向量化、点积、消息往返、端到端，各取 P50/P95（≥200 次采样）。
- 产出**可重复 benchmark 脚本 + 原始结果文件**，随仓库提交。

### 11.2 召回标注集（固定 ground truth，见 P1-11）
- 提交**固定匿名数据集**（≥1000 条）、**≥30 条中文 query**、每 query 的相关 URL 与相关性等级、"命中"判定定义、评测脚本。
- 指标：Recall@10、MRR、首条命中率；线上点击**不**替代此离线基准。

### 11.3 功能与正确性验收（全部由执行验证）
1. **主链路**：浏览→捕获→转正→呼出→点击打开端到端可用。
2. **生命周期竞态**：两标签同 URL、连续 SPA 导航、重定向、快速关闭下，无误删共享记录、无旧消息覆盖（复现脚本）。
3. **SPA**：GitHub Issue 间前端跳转，每 URL 独立可检索。
4. **向量正确性**：int8 vs float32 基线 Recall@10 降 <2%、MRR 降 <0.02。
5. **零网络/隐私**：BM25 装即离线可用；启用语义时用 DevTools Network 确认请求仅命中模型主机、载荷不含任何用户数据；模型缓存后断网可用；WebGPU 与 WASM 两路径均通过；下载中断/资源损坏有明确报错与恢复。可选内网打包构建走本地加载，全程断网。
6. **延迟**：按 11.1 协议达标（目标随基准机确定后写死，不再用架构推导）。
7. **持久化**：读真实 `persisted()`；返回 false 时提示/备份引导/LRU 生效。
8. **隐私**：incognito 无痕；黑名单域零记录；密码/信用卡/表单值不入正文；`STOP_CAPTURE` 顺序生效。
9. **备份**：导出→清库→导入还原一致；**同 ZIP 二次导入逐字段幂等**；跨模型导入触发重算；中断导入原库不变。
10. **权限/审核**：最小 manifest 审核实验结论记录在案；全局暂停/站点排除/一键清空可用。

### 11.4 单元/集成测试契约（R6）
- URL 归一化与去重；加权 RRF（单侧/双侧/权重）；生命周期状态机（含非法转移、documentId 失配丢弃、refCount GC）；差分合并幂等（max/min、跨模型重算）；int8 量化/反量化与打分公式；跨 store 事务原子性（模拟中途失败不留中间态）；埋点 `queryId` 两段关联。

---

## 十二、核心代码参考（修正版）

### 12.1 Content Script（SPA 重捕 + 累计前台计时 + 空值保护 + SW 裁决过滤）

```javascript
// content_script.js  (document_idle 注入)
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
    // 身份由 SW 从 sender 读取, content 不自报 tabId/documentId
    chrome.runtime.sendMessage({ type: 'COMMIT_PAGE_RECORD',
      data: { url: location.href, content: extractClean() } });
  }

  const onInteract = () => commitPage();
  const onScroll = () => { if (scrollY > innerHeight * 0.5) commitPage(); }; // 半屏, 统一单位

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
    if (msg.type === 'STOP_CAPTURE') { stopped = true; teardown(); } // SW 裁决黑名单/incognito
  });

  initProvisional();
})();
```

### 12.2 加权 RRF：见 5.3。相似度打分：见 4.3。

---

## 十三、契约与测试对照表（把"开工闸门实验"前置为已定型契约 + 强制测试）

| 契约 | 定型位置 | 强制测试 | 验收编号 |
|---|---|---|---|
| 页面实例 vs 内容记录、按实例 GC | 三、四 | 生命周期状态机、refCount GC | 11.3-2 |
| documentId 防旧消息、条件 upsert | 二、三 | documentId 失配丢弃 | 11.3-2 |
| 备份累计快照 + max/min 合并幂等 | 7.3 | 差分合并幂等、二次导入 | 11.3-9 |
| int8 归一化+量化+打分公式 | 4.3 | int8 vs float32 Recall/MRR | 11.3-4 |
| 零网络（构建+运行） | 1、5.1 | 断网首启+请求拦截+双路径 | 11.3-5 |
| 跨 store 事务原子性 | 4.2、6.2 | 事务中途失败无中间态 | 11.4 |
| 埋点 queryId 两段关联 | 八 | queryId 关联 | 11.4 |

*说明：本方案将所有会造成确定性数据/结果错误的契约在纸面解决（第九、十三章），并配强制测试与固定测量协议，实现阶段按第十~十一章一次交付、以执行验证收敛。*
