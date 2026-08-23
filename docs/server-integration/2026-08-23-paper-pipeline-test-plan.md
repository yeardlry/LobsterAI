# Paper Pipeline 端到端测试方案

本文档是 LobsterAI × `/lit` 文献处理流水线的**手工 + 自动化**测试清单。

一条任务在服务端确认下走过 5 个状态转换：

```
xml_ready → parsed → analyzed → categorized → pdf_ready → completed
```

流水线是**单步手动**模式：每次调 `advance` 只走一个状态转换。多步自动推进属于更高层的协调器范畴。
状态机代码：[src/main/paperPipeline/paperPipelineService.ts](../../src/main/paperPipeline/paperPipelineService.ts)
接口契约：[2026-08-16-custom-login-service-integration.md](./2026-08-16-custom-login-service-integration.md)

---

## 0. 环境准备

### 0.1 选启动命令：要不要先编 OpenClaw runtime？

```bash
ls vendor/openclaw-runtime/current/ 2>/dev/null \
  > /dev/null && echo "runtime 已就绪 — 用普通 dev" \
  || echo "未就绪 — 首次 dev 需要先 electron:dev:openclaw"
```

| runtime 是否就绪 | 启动命令 |
|---|---|
| 已就绪 | `npm run electron:dev` |
| 没就绪（首次） | `npm run electron:dev:openclaw`（会先编 runtime，再起 dev） |

`electron:dev` **不会**同步 OpenClaw runtime，只有 Vite + Electron。
`electron:dev:openclaw` 等于在前面串一个 `openclaw:runtime:host`。

### 0.2 后端

`lit` RuoYi 后端必须跑在 `localhost`（一般是在 `MRnaLnpLiterature` 仓库里 `npm run dev`）。
登录后 access token 写到 `auth_tokens` kv，paper pipeline 从那里读。

### 0.3 测试夹具（fixture）

后端至少准备这几条任务：

| 标号 | PMID 例子 | 覆盖路径 |
|---|---|---|
| A | `PMC8345678` 同类 | EuropePMC 直链 PDF 成功（优先级 1） |
| B | EuropePMC 有但 PMC.com 没有 | EuropePMC 搜索 API 成功（优先级 3） |
| C | 老 PMID，例如 `12345` | 确定性 URL 都失败 → token-proxy LLM 接管（优先级 4） |
| D | 找不到的 PMID，啥都没有 | token-proxy 也失败 → 隐藏 Cowork 会话接管（优先级 5） |

---

## 1. 单元测试（Vitest，纯 Node 跑）

```bash
npm test -- paperPipeline
npm test -- hiddenCoworkSession
npm test -- pdfUrlFinder
npm test                                 # 全套，应有 3398 个通过
```

期望结果：

- `hiddenCoworkSession.test.ts` 5 个用例：
  - 正常路径：行被创建、prompt 发出、片段被采集
  - `permissionRequest` 自动放行
  - `error` 事件抛出 runtime 的消息
  - 超时拒绝并触发 `stopSession`
  - 缺 cwd 直接报清晰错误
- `pdfUrlFinder.test.ts` 4 个用例：
  - token-proxy 从 chat completion 回复里抽 URL
  - token-proxy 抛错 → 退到 hidden session
  - proxy 不可用且无 hidden deps → 返回 null
  - 两条策略都返回 NO_PDF → 返回 null
- `paperPipeline/{xmlParser,analysisService,categoryService}.test.ts` 共 11 个用例

全套应报 **3398 passed | 2 skipped**。

---

## 2. 主进程烟测（Electron 跑着的时候）

开着 main 日志追踪：

```bash
tail -f ~/Library/Logs/LobsterAI/main-$(date +%Y-%m-%d).log
```

### 2.1 Service Manager 生命周期

- [ ] lit 登录后：日志出现 `[PaperPipeline] init: service manager wired`
- [ ] OAuth 登录（非 lit 账号）：service manager **不**安装
- [ ] 登出：service manager 被释放

### 2.2 IPC handler 响应

在 DevTools 控制台：

```js
await window.electronAPI.paperPipeline.listPendingTasks();
```

- [ ] 返回当前任务列表
- [ ] token 过期/失效时**不**崩，提示重新登录

---

## 3. UI 流程（手工跑 Electron）

### 3.1 侧栏入口

- [ ] 侧栏底部出现 Paper Tasks 入口（中文：文献任务）
- [ ] 点击 → 打开 `PaperTasksView`
- [ ] 鉴权不是 lit 时，入口隐藏/置灰

### 3.2 列表渲染

- [ ] 「刷新待办」按钮触发 `listPendingTasks`，卡片渲染
- [ ] 状态色：`xml_ready` 灰 / `parsed` 蓝 / `analyzed` 紫 / `categorized` 青 / `pdf_ready` 橙 / `completed` 绿 / `failed` 红
- [ ] `zh` / `en` 切换时所有文案正确切换

### 3.3 单任务正常路径

挑一条当前在 `xml_ready` 的任务：

| 点击 | 期望状态 | 期望日志 |
|---|---|---|
| 推进 | `xml_ready → parsed` | `[PaperPipeline] <pmid> parsed N author(s)` |
| 推进 | `parsed → analyzed` | `[PaperPipeline] <pmid> generated extSummary (XXX chars)` |
| 推进 | `analyzed → categorized` | `[PaperPipeline] <pmid> picked N categor(ies) and M tag(s)` |
| 推进 | `categorized → pdf_ready` | `[PaperPipeline] <pmid> downloaded XXX bytes → <path>` + `uploaded to <url>` |
| 推进 | **`pdf_ready` 保持不变** | `[PaperPipeline] <pmid> wechat draft prepared at <localPath>` |

### 3.4 微信公众号草稿弹窗

- [ ] 任务到达 `pdf_ready` 时自动弹出
- [ ] 弹窗显示：标题、摘要、分类/标签 chip
- [ ] 「复制路径」按钮把 `~/Library/Application Support/LobsterAI/paperPipeline/wechat/wechat-<pmid>.md` 写到剪贴板
- [ ] 「在浏览器打开草稿」用默认编辑器打开本地文件
- [ ] `docUrl` 输入框拒绝非 `https://mp.weixin.qq.com/` 开头的链接
- [ ] URL 合法前提交按钮置灰
- [ ] 粘贴合法 URL + 提交 → 任务翻到 `completed`
- [ ] 取消 → 弹窗关闭，任务停在 `pdf_ready`

---

## 4. PDF 下载策略矩阵（本 PR 的核心新增）

每个 PMID fixture，确认是哪条策略拉的文件：

| PMID 类型 | 期望策略 | 在哪里看 |
|---|---|---|
| A：EuropePMC 直链 | `europepmc-direct` | main 日志 `[PaperDownload] using europepmc-direct`（Phase 3 日志） |
| B：搜索 API | `europepmc-search` | main 日志 |
| C：token-proxy LLM | （无 Phase-3 label）+ `[PdfUrlFinder] token-proxy strategy returned <url>` | main 日志 + token-proxy 端口有响应 |
| D：隐藏 Cowork 会话 | `[PdfUrlFinder] token-proxy strategy failed` 紧接 `[PdfUrlFinder] hidden-session strategy returned <url>` + `[HiddenCoworkSession] created session sess-XXXX` | main 日志 |

PMID D 还要再确认：

- [ ] `cowork_sessions` 表里出现新行，标题前缀是 `[hidden]`
- [ ] `permissionRequest` 事件被自动放行（无 UI 弹窗）
- [ ] 跑完一次后会话被停掉（`status = 'idle'`）

---

## 5. 失败 / 重置路径

### 5.1 强制后端失败

把某个端点改返回 500（例如拦 `/lit/submitParseResult`）：

- [ ] 点推进 → 任务翻到 `failed`，chip 变红
- [ ] `reportTaskFailure` 被自动调用
- [ ] 卡片显示 Reset 按钮
- [ ] 点 Reset → 任务回到 `xml_ready`，可以重新推进

### 5.2 手工标失败

- [ ] 任一卡片的「标为失败」→ 任务翻到 `failed`

### 5.3 PDF 下载全失败

- [ ] 任务停在 `categorized`，chip 红色
- [ ] 卡片日志显示 `[PaperPdfDownloadError] All PDF strategies exhausted for PMID X`
- [ ] Reset 按钮可用

---

## 6. 鉴权切换

| 操作 | 期望 |
|---|---|
| 登出 lit | service manager 释放，侧栏入口消失 |
| 用 OAuth 账号登录 | service manager **不**初始化，没有入口 |
| 切回 lit | service manager 重启，本地缓存（XML / PDF / wechat md）原样保留 |

---

## 7. 持久化检查

```bash
ls "$HOME/Library/Application Support/LobsterAI/paperPipeline/"
# 期望：
#   pdfs/<pmid>.pdf
#   xml/<pmid>.xml
#   wechat/wechat-<pmid>.md
```

- [ ] 全流程跑完一次后，杀掉 Electron 再打开
- [ ] 任务状态在 SQLite 里保留
- [ ] 对同一任务再点 推进 时复用本地缓存的 PDF / md（不再下第二次）

---

## 8. 性能 / 日志规范

- [ ] 每一步都有 `[PaperPipeline]` tag 的日志行
- [ ] 失败用 `console.error(..., err)`，错误对象放在最后一个参数
- [ ] 轮询/热路径里没有 info 级日志
- [ ] 每个非 LLM 步骤 < 30s 完成
- [ ] hidden session 有 90s 上限（见 `findPdfUrlViaHiddenCoworkSession`）
- [ ] token-proxy 路径目前没显式超时（依赖 `net.fetch` 默认值），CI 里需要确认

---

## 9. 自动化候选（下一阶段）

要把 §3–§6 自动化，用 Playwright Electron 驱动 renderer，断言：

- `StatusChanged` 事件顺序匹配 §3.3
- 用户提交 docUrl 流程后最终状态为 `completed`
- `wechat-<pmid>.md` 文件存在，标题 + 摘要内容符合预期

不在本 PR 范围。E2E harness 落地之前，先按上面的手工清单跑。