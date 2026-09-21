# SpotRecall

极简本地数字入口与上下文召回引擎（Local-First Context & Entry Recall）。Chrome MV3 扩展，帮你找回"之前看过/操作过的地方"。数据 100% 留在本地，运行期零网络依赖。

设计与架构见 [SpotRecall-dev-plan.md](SpotRecall-dev-plan.md)。

## 快速开始

```bash
npm install
npm run build            # 产出 dist/（~22MB：代码+ORT WASM，不含模型）
npm test                 # 纯逻辑契约单测（32 项）
```

在 Chrome 打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/` 目录。

- **弹窗（下拉面板）**：点击工具栏图标或按 `Cmd/Ctrl + Shift + K` → 锚定在图标下方的搜索面板。点结果即在新标签打开。
- **面板（新标签页）**：弹窗右上角「打开面板」按钮 → 完整面板（LLM 下载、仪表板、黑名单、备份、隐私）。
- **最近浏览**：呼出弹窗未输入时，按时间分组展示最近访问的页面；输入后切换为相关性排序。
- **跨语言检索**：查询与页面语言不同也能搜到——端侧翻译查询后再检索（Chrome 138+，不可用时降级）。
- **国际化**：英文 / 日文 / 简体中文，自动检测浏览器语言，弹窗与面板右上角可手动切换。
- **BM25 关键字检索装即离线可用**；语义检索是可选项，在面板中开启后一次性下载多语言模型（约 135MB）到本地缓存,**下载完成即可语义搜索**,之后完全离线。

### 可选：内网/离线打包（air-gapped）

若需要模型随包发布、扩展全程无需联网：

```bash
npm run download-model   # 一次性把模型烤进 public/models
npm run build            # 产出含模型的 dist/（~155MB）
```

代码同时支持本地打包与运行期下载两条路径——是否运行 `download-model` 决定走哪条。

## 架构一览

| 上下文 | 职责 |
|---|---|
| Content `capture` | 每帧捕获元数据/正文、监听交互与 SPA、隐私过滤 |
| Content `palette` | 玻璃拟态浮窗（closed Shadow DOM，Preact） |
| Service Worker | 消息路由 + documentId 防旧 + 生命周期状态机 + 实例表 + 唯一 IndexedDB 写入 + GC + 遥测 |
| Offscreen | 常驻模型推理 + int8 向量库 + 暴力检索（从 IndexedDB 重放） |

BM25（MiniSearch）即时 + 端侧向量（multilingual-e5-small, int8）异步，加权 RRF 融合，时间轴分桶。

## 已通过（本仓库可执行验证）

- `npm test`：URL 归一化、加权 RRF、int8 量化打分（Recall@10 相对 float32 基线 > 0.98、MRR 降 < 0.02）、时间轴分桶、页面实例状态机（refCount GC / documentId 防旧 / SPA 路由 / 重载重提交）、DAO 生命周期与原子事务、LRU 保留、**备份重复导入幂等**。
- `npm run build`：类型干净、扩展打包成功、ORT WASM 已内联进包（离线）。

## 需在真实 Chrome 验证（R8 校准：本环境无法执行）

以下为方案第十一章验收项中依赖真机/真实浏览的部分，代码已接线到位，请在本地逐项确认：

1. **零网络/隐私**：BM25 关键字检索装即离线可用；在选项页启用语义搜索时，用 DevTools Network 确认请求**仅命中模型主机、载荷不含任何用户数据**；模型缓存后断网仍可语义检索；在支持/不支持 WebGPU 的机器上确认 WASM 回退可用。（内网打包构建则全程断网。）
2. **主链路 & SPA**：正常浏览若干页面 → 呼出 → 命中 → 打开；在 GitHub Issue 间前端跳转，确认每个 URL 生成独立记录。
3. **生命周期竞态**：同一 URL 开两个标签，关闭其一不应删除记录；快速开关、重定向下无旧消息覆盖。
4. **隐私**：无痕窗口零记录；黑名单域零记录；密码/信用卡字段不进正文。
5. **持久化**：选项页显示 `navigator.storage.persist()` 的真实结果；未授予时有提示。
6. **性能 benchmark**：按第十一章测量协议固定机型/版本，产出 BM25 / 查询向量化 / 点积 / 端到端 的 P50/P95。
7. **召回质量**：用固定中文标注集产出 Recall@K / MRR / 首条命中率。

## 隐私声明

正文以**明文**存于本地 IndexedDB，安全边界等同浏览器历史（同机进程、备份文件、DevTools 均可读）。不做静态加密是经威胁模型评估的产品定案。无痕窗口与黑名单站点不记录，表单值/密码/信用卡字段不进正文。选项页提供全局暂停、站点黑名单、一键清空、备份导出/导入。

完整隐私政策（en/zh/ja）见 [PRIVACY.md](PRIVACY.md)。

## License

AGPL-3.0-only
