# 接入自研登录服务：可替换接口与现有页面盘点

> 目的：把 LobsterAI 桌面端当前对接的官方登录/账号服务（`lobsterai-server.youdao.com`，即网易有道 Portal 账号体系）替换为自研登录服务。
> 本文回答两个问题：
> 1. **哪些接口可以被替换**（客户端依赖的服务端 HTTP 接口契约 + 客户端侧可改造点）；
> 2. **原有接口对应的页面/组件有哪些**（哪些 UI 在消费登录态）。

代码核对基线：2026-08-16 的 `main` 分支源码。行号以 `src/main/main.ts` 当前内容为准，可能随版本漂移，定位时以符号名为准。

---

## 1. 现状架构总览

```
┌───────────────────────────── Renderer (React) ─────────────────────────────┐
│ services/auth.ts (authService)                                             │
│   login() / handleCallback() / refreshAuthState() / logout() / quota...    │
│ store/slices/authSlice.ts (isLoggedIn / user / quota / profileSummary)     │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ window.electron.auth.*  (preload.ts, contextBridge)
               │ IPC 通道: AuthIpcChannel (src/shared/auth/constants.ts)
┌──────────────▼───────────────────────────── Main ───────────────────────────┐
│ main.ts 「Auth IPC handlers」(~L6592-7137)                                  │
│ libs/authSessionManager.ts   —— token 刷新 / fetchWithAuth 401 重试        │
│ libs/authLocalCallbackServer.ts —— 127.0.0.1 登录回调服务器                │
│ libs/authCallbackRouter.ts   —— lobsterai:// deep link 回调路由            │
│ libs/endpoints.ts            —— 服务端 base URL (testMode 切换)            │
│ Token 持久化: SQLite kv 表 key = auth_tokens {accessToken, refreshToken}   │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ net.fetch / fetchWithAuth (Bearer accessToken)
┌──────────────▼──────────────────────────────────────────────────────────────┐
│ LobsterAI Server (https://lobsterai-server.youdao.com，测试环境为          │
│ lobsterai-server.inner.youdao.com)：/login、/api/auth/*、/api/user/*、     │
│ /api/proxy/*、/api/models/*、/api/media/* ……                               │
│ 登录页本体：Portal Web 页 https://lobsterai.youdao.com/portal#/login       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 当前登录时序（OAuth 授权码模式 + 系统浏览器）

1. 用户点击登录 → `authService.login()`（`src/renderer/services/auth.ts`）。
2. 渲染进程先请求 overmind 配置拿登录页 URL（`getLoginOvermindUrl()`，返回 `data.value`），失败时回退 `getPortalLoginUrl()`（`portal#/login`）。见 `src/renderer/services/endpoints.ts`。
3. 调 IPC `auth:login`。主进程（main.ts ~L6592）：
   - 启动本机回调服务器 `startAuthLocalCallback()`：监听 `127.0.0.1:随机端口/auth/callback`，生成 `state`，5 分钟超时（`libs/authLocalCallbackServer.ts`）；
   - 给登录页 URL 追加参数 `source=electron`、`redirect_uri=<本机回调地址?return_to=<登录成功回跳页>>`、`state`（`appendLoginParams` 支持 hash 路由 URL）；
   - `shell.openExternal(finalUrl)` 打开**系统浏览器**；失败时回退为无 `redirect_uri` 的 deep link 模式。
4. 用户在浏览器 Portal 登录页完成登录，Web 页把浏览器重定向到
   `redirect_uri?code=<authCode>&state=<state>`：
   - 本机回调服务器校验 `state` 后把 `code` 交给 `authCallbackRouter`，并渲染「登录成功」HTML、自动回跳 `return_to`；
   - 备用通道：`lobsterai://auth/callback?code=...` deep link（main.ts ~L4276 注册协议；macOS `open-url`、Windows/Linux `second-instance` 命令行），由 `AuthCallbackRouter` 缓存或转发。
5. 渲染进程通过 `auth:callback` 事件（或启动时 `auth:getPendingCallback`）拿到 code → `authService.handleCallback(code)` → IPC `auth:exchange`。
6. 主进程 POST `${server}/api/auth/exchange`（body: `{authCode, ...keyfrom}`），响应 `data` 含 `accessToken/refreshToken/user/quota`，写入 SQLite kv（`auth_tokens`）。
7. 后续请求统一走 `fetchWithAuth`：带 `Authorization: Bearer <accessToken>`，401 自动用 `POST /api/auth/refresh` 刷新（`AuthSessionManager`）；另有 JWT `exp` 提前 5 分钟的主动刷新（main.ts ~L13319，**假定 accessToken 是 JWT**）。

> 关键结论：**真正的「登录页」不在客户端里**，而是 Portal Web 页（系统浏览器打开）。客户端只负责：发起登录、接收 code、换 token、存 token、刷 token。这是替换成本最低的设计支点。

---

## 2. 可替换的服务端 HTTP 接口清单

服务端 base URL 统一来自 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts`，按 testMode 切换测试/生产，dev 可用 `LOBSTER_SERVER_BASE_URL` 覆盖）。**替换登录服务时，这是第一改动点。**

响应信封约定：所有接口均为 `{ code: 0, message?, data: ... }`，`code !== 0` 视为业务失败。自研服务必须保持该信封，否则需要同时改客户端解析逻辑。

### 2.1 核心认证接口（替换登录服务必须提供）

| 接口 | 方法 | 用途 | 请求 | 响应 `data` 契约 |
|---|---|---|---|---|
| `/login`（登录页） | GET（页面） | 系统浏览器打开的登录页 URL。当前实际 URL 由 overmind 配置下发（renderer `getLoginOvermindUrl`），回退 Portal | URL 参数：`source=electron`、`redirect_uri`（含 `return_to`）、`state` | 登录成功后须 302/JS 重定向到 `redirect_uri?code=<authCode>&state=<state>` |
| `/api/auth/exchange` | POST | 授权码换 token | `{ authCode, ...keyfrom归因字段 }` | `{ accessToken, refreshToken, user, quota }` |
| `/api/auth/refresh` | POST | 刷新 token | `{ refreshToken, ...keyfrom }` | `{ accessToken, refreshToken? }`（refreshToken 缺省时沿用旧值）。**终止性错误码：HTTP 401 或业务码 `40100`/`40101`/企业 NotMember 码 → 客户端强制登出**（`authSessionManager.ts` `TERMINAL_REFRESH_ERROR_CODES`） |
| `/api/auth/logout` | POST | 远端注销（本地先清，失败仅告警） | Bearer + 空 body | 无强约束 |
| `/api/user/profile` | GET | 用户资料（`auth:getUser`） | Bearer | `{ yid, nickname, avatarUrl, id, accountMode, ... }`（见 §4 UserProfile） |
| `/api/user/quota` | GET | 额度/订阅（`auth:getQuota`） | Bearer | 多种格式均可被 `normalizeAuthQuota` 归一化（`src/main/authQuota.ts`），推荐直接给 `{ creditsLimit, creditsUsed, planName, subscriptionStatus: 'free'|'active'|'enterprise', hasPaidCredits, mediaGenerationEntitled, shareEntitled, deploymentEntitled }` |
| `/api/user/profile-summary` | GET | 积分明细/活动状态（侧栏菜单展示） | Bearer | `{ totalCreditsRemaining, creditItems[], creditsResetCampaign, ... }`（见 authSlice `ProfileSummary`） |

### 2.2 功能相关接口（保留对应功能则需实现；否则可让调用返回失败、功能自动降级）

| 分组 | 接口 | 调用方 | 说明 |
|---|---|---|---|
| 服务器模型 | `GET /api/models/available`；`GET /api/models/pricing-catalog`（公开、无需登录） | main.ts `loadAvailableServerModels` / GetPricingCatalog；`libs/startupCacheWarmup.ts` | 「LobsterAI 服务器模型」列表。**若自研服务不做模型托管，可放弃**，用户仅用本地/第三方模型 |
| LLM 推理代理 | `/api/proxy/v1/*`（OpenAI 兼容；另有 Anthropic/Gemini 变体） | `libs/openclawTokenProxy.ts`（OpenClaw 网关流量经本机代理转发）、`libs/claudeSettings.ts`、`libs/coworkOpenAICompatProxy.ts` | **服务器模型聊天的真正数据面**：Bearer accessToken + 企业 headers。OpenClaw 配置里 `lobsterai-server` provider 的 baseUrl 被写成本机 token 代理（见 §5.2）。替换登录但保留官方模型 → 此代理必须继续可达 |
| 媒体生成 | `GET /api/media/{images|videos}/models`、`POST /api/media/{images|videos}/generate`、`GET /api/media/{images|videos}/tasks/{taskId}`、`POST /api/media/videos/tasks/{taskId}/cancel` | main.ts（~L5309-5928、6221、7775-7820、9618） | 图片/视频生成 |
| 语音输入 | `POST /api/asr/realtime/sessions` | `ipcHandlers/asr/handlers.ts` | 实时 ASR 会话票据 |
| 活动/Banner | `GET /api/client-activities/slot`、`GET /api/client-activities/{code}/context`、`POST /api/client-activities/{code}/actions/{actionId}`；`GET /api/client-banners/active(-list)` | `libs/activity/activityClient.ts`；main.ts banner handlers | 每日签到、启动赠送、侧栏广告位 |
| 积分活动 | `POST /api/credits-reset-campaign/free-credits/claim` | main.ts ClaimCreditsFinalReward | 积分重置活动领取 |
| HTML 分享 | `POST /api/html-shares`、`GET/PATCH /api/html-shares/{shareId}`、`.../status`、`.../access-mode`、`GET /api/html-shares/source`、`GET /api/html-shares/my` | `libs/htmlShare/htmlShareClient.ts` | 产物分享发布 |
| 站点/部署 | `GET /api/sites`、`GET/DELETE /api/sites/{shareId}`、`PATCH .../access-mode`、`GET .../analytics`、`GET /api/sites/deployment-quota`、配额预留；`POST /api/share-deployments/{node|static}`、`GET /api/share-deployments/{id}`、持久化卷 | `libs/site/siteClient.ts`、`libs/shareDeployment/shareDeploymentClient.ts` | 站点管理、静态/Node 部署 |
| 企业版 | `GET /api/enterprise/context`、`GET /api/enterprise/identities`、`POST /api/enterprise/{enterpriseId}/quota-requests` | `src/main/enterpriseAccount/context.ts` | 企业账号上下文/成员配额。**自研服务无企业版可整体不实现**，客户端在企业码缺失时会按个人账号路径走 |

### 2.3 与登录无关、不需要动的远端服务

- 应用更新：`api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/{test|prod}/update*`
- Skill/Kit 商店：overmind `skill-store` / `kit-store`
- 日志上报：`rlogs.youdao.com/rlog.php`（`mainLogReporter`）
- 独立 OAuth：xAI（`libs/xaiAuth.ts`）、OpenAI Codex（`libs/openaiCodexAuth.ts`）、GitHub Copilot（`libs/githubCopilotAuth.ts`）——各自独立，不经过 `auth_tokens`

---

## 3. 客户端可替换/可改造点

### 3.1 IPC 契约（渲染进程唯一依赖面）

全部通道定义在 `src/shared/auth/constants.ts` 的 `AuthIpcChannel`；preload 暴露面在 `src/main/preload.ts` ~L1170（`window.electron.auth`）。**只要保持这些通道与返回结构不变，渲染进程几乎零改动。**

| 通道 | 方向 | 说明 |
|---|---|---|
| `auth:login` | invoke | 发起登录（打开系统浏览器） |
| `auth:callback` | event→renderer | 授权码到达 |
| `auth:getPendingCallback` | invoke | 启动时取缓存的授权码 |
| `auth:exchange` | invoke | code 换 token |
| `auth:getUser` / `auth:getQuota` / `auth:getProfileSummary` | invoke | 登录态恢复与刷新 |
| `auth:logout` / `auth:refreshToken` / `auth:getAccessToken` | invoke | 注销/手动刷新/取 token |
| `auth:getModels` / `auth:getPricingCatalog` | invoke | 服务器模型 |
| `auth:claimCreditsFinalReward` / `auth:getActiveClientBanner(s)` | invoke | 活动/横幅 |
| `auth:sessionChanged` / `auth:lifecycleEvent` / `auth:quotaChanged` | event→renderer | 会话过期、生命周期、额度变化通知 |

### 3.2 主进程改动点（按优先级）

| 位置 | 内容 | 替换动作 |
|---|---|---|
| `libs/endpoints.ts` `getServerApiBaseUrl()` | 服务端地址 | **改指向自研服务**（或走 `LOBSTER_SERVER_BASE_URL`/testMode 开关） |
| `renderer/services/endpoints.ts` `getLoginOvermindUrl()` / `getPortalLoginUrl()` | 登录页 URL 来源 | 改为自研登录页 URL（可直接返回固定值，去掉 overmind 请求） |
| main.ts `AuthIpcChannel.Exchange` handler（~L6644） | exchange 请求/解析 | 若自研服务信封不同在此适配；保持返回 `{success, user, quota, enterpriseContext}` |
| `libs/authSessionManager.ts` 注入参数（main.ts ~L4975-4990） | `getRefreshUrl` / `buildRefreshRequestBody` / 终止码 | **已是注入式设计**：换 refresh URL 与请求体只需改构造参数；终止码集合 `TERMINAL_REFRESH_ERROR_CODES` 按自研服务错误码调整 |
| `libs/authLocalCallbackServer.ts` | 本机回调服务器 | `resolveSafeReturnTo()` 的域名白名单当前是 `*.youdao.com` + loopback（~L130），**必须改为自研域名**；回调页文案为硬编码中文，可顺带调整 |
| main.ts 协议注册（~L4276） | deep link scheme `lobsterai://auth/callback` | 若换应用标识需同步改 scheme 与登录页回跳约定 |
| main.ts `setAuthTokensGetter`（~L1319-13335） | JWT `exp` 主动刷新 | **假定 accessToken 是 JWT**；自研 token 若不是 JWT，这段解析会静默跳过（无副作用），但会失去提前刷新，建议改成按服务端返回的过期时间 |
| main.ts keyfrom 相关（`withKeyfromBody` / `appendKeyfromQuery`） | 渠道归因字段 | 自研服务不需要时可在适配层剥离 |
| SQLite kv `auth_tokens` | token 持久化结构 `{accessToken, refreshToken}` | 保持不变即可；注意 `mediaAccountIsolation.ts` 与数据迁移（`dataMigrationService`）依赖该 key 结构 |

### 3.3 渲染进程改动点

| 位置 | 说明 |
|---|---|
| `services/auth.ts` | 登录编排中心。`fetchLoginUrl()` 改自研 URL；其余流程（callback→exchange→状态落库）可原样复用 |
| `store/slices/authSlice.ts` | `UserProfile`：`{yid, nickname, avatarUrl, phone?, userId?, id?, status?, accountMode?}`；`UserQuota`：见 §2.1。自研服务返回字段对齐这两个类型即可 |
| `services/endpoints.ts` | Portal 系列 URL（充值/邀请/企业控制台等跳转），按自研门户替换或隐藏 |

---

## 4. 现有页面/UI 盘点（原接口的消费方）

> 客户端内**没有独立登录页**——登录页是浏览器里的 Portal Web 页。客户端内的「登录相关 UI」是下列入口与状态展示。

### 4.1 登录入口（触发 `authService.login()`）

| 组件 | 文件 | 场景 |
|---|---|---|
| `App` | `src/renderer/App.tsx` | `handleWelcomeLogin`；启动 `authService.init()`（恢复登录态/监听回调） |
| `WelcomeDialog` | `components/WelcomeDialog.tsx` | 首启欢迎弹窗的登录按钮 |
| `LoginButton` | `components/LoginButton.tsx` | 侧栏账号按钮（未登录态） |
| `ModelAccessPromptModal` | `components/ModelSelector.tsx` | 选择受限模型弹出「登录/订阅」 |
| `DailyCheckInLoginModal` | `components/DailyCheckInActivity.tsx` | 签到领奖前要求登录 |
| `StartupCreditCampaign` | `components/StartupCreditCampaign.tsx` | 启动赠送积分活动 |
| `MediaModelPicker` | `components/cowork/MediaModelPicker.tsx` | 媒体模型选择处登录 |

授权码回调统一由 `services/auth.ts` 的 `init()` 订阅处理，无独立回调页面。

### 4.2 用户资料 / 登出（消费 `auth:getUser`、`auth:logout`）

| 组件 | 文件 | 场景 |
|---|---|---|
| `LoginButton` → `UserMenu` | `components/LoginButton.tsx` | 头像/昵称/套餐徽章/退出登录；打开 Portal 充值、邀请、用量页 |
| `EnterpriseAccountMenu` | `features/enterpriseAccount/components/EnterpriseAccountMenu.tsx` | 企业账号版菜单（含退出） |

### 4.3 额度 / 积分展示（消费 `auth:getQuota`、`auth:getProfileSummary`）

| 组件 | 文件 | 场景 |
|---|---|---|
| `UserMenu` | `components/LoginButton.tsx` | 剩余积分、积分构成、到期时间、充值入口、`CreditsFinalRewardModal` |
| `CreditsResetCampaignFloat` | `components/CreditsResetCampaignFloat.tsx` | 积分重置活动浮层 |
| `StartupCreditCampaign` | `components/StartupCreditCampaign.tsx` | 赠送积分弹窗 |
| `DailyCheckInActivity` + `useDailyCheckInActivity` | `components/` | 每日签到领取 |
| `EnterpriseQuotaPrompt` | `features/enterpriseAccount/components/EnterpriseQuotaPrompt.tsx` | 企业配额不可用提示 |
| （纯逻辑）`accountMenuState.ts` | `components/accountMenuState.ts` | 套餐/奖励展示派生 |

### 4.4 以登录态/额度做功能门槛的页面（消费 `state.auth`）

| 组件 | 文件 | 门槛逻辑 |
|---|---|---|
| `CoworkView` | `components/cowork/CoworkView.tsx` | 无可用模型时弹登录/订阅提示 |
| `CoworkPromptInput` | `components/cowork/CoworkPromptInput.tsx` | **未登录且无本地模型时禁止发送**；服务器模型受限拦截；ASR 订阅检查 |
| `VoiceInputButton` / `useCoworkVoiceInput` | `components/cowork/voiceInput/` | 未登录禁止录音 |
| `ModelSelector` | `components/ModelSelector.tsx` | `accessible === false` 的服务器模型需登录/订阅 |
| `MediaModelPicker` | `components/cowork/MediaModelPicker.tsx` | 媒体生成权益（`quota.mediaGenerationEntitled` 等） |
| `ArtifactPanel` / `ArtifactFileShareController` / `artifactSubscriptionGate` | `components/artifacts/` | 分享/发布/部署权益（`shareEntitled`、`deploymentEntitled`） |
| `SitesView` | `components/sites/SitesView.tsx` | 按账号隔离站点列表 |
| （服务层）`cowork.ts`、`coworkQueuedFollowUpCoordinator.ts` | `services/` | 用 `ownerAccountKey` 做账号切换防串数据 |
| `Settings` | `components/Settings.tsx` | 仅取 `user.yid` 用于更新检查上报 |

### 4.5 浏览器内的原有页面（Portal，属于被替换对象）

这些 URL 由 `renderer/services/endpoints.ts` 生成，是自研门户需要对应承接（或隐藏入口）的页面：

- `portal#/login` 登录页（**核心**）
- `portal#/pricing` 定价页、`portal#/profile` 个人中心、`portal#/profile/detail` 积分明细、`portal#/invitation` 邀请页
- 企业控制台：`portal#/enterprise/console/{id}/{overview|usage|billing|recharge}`、`portal#/enterprise/profile/{id}`

---

## 5. 推荐接入路径

### 方案 A：服务端兼容替换（改动最小，推荐起步）

自研服务实现 §2.1 的 7 个核心接口，沿用 `{code:0,data}` 信封与字段名。客户端改动收敛为：

1. `libs/endpoints.ts`：`getServerApiBaseUrl()` 指向自研服务；
2. `renderer/services/endpoints.ts`：`getLoginOvermindUrl/getPortalLoginUrl` 指向自研登录页；
3. `authLocalCallbackServer.ts`：`resolveSafeReturnTo` 域名白名单；
4. （可选）`authSessionManager` 终止错误码、JWT 主动刷新改为服务端过期时间；
5. 自研登录页实现重定向约定：`redirect_uri?code=&state=`（见 §1.1）。

UI 层（§4 全部组件）**不需要改动**——它们只依赖 IPC 契约。不实现的功能（媒体/分享/部署/企业版）对应 UI 会自动降级或走错误提示。

### 方案 B：完全自定义登录体验（客户端内登录）

若要抛弃系统浏览器流程（如客户端内嵌账号密码表单 / 内嵌 WebView）：

- 重写 `AuthIpcChannel.Login` handler：不再 `shell.openExternal`，改为打开应用内登录窗口或直接调自研登录 API；
- 登录成功后跳过授权码环节，直接构造 `auth:exchange` 等价结果（服务端直接下发 accessToken/refreshToken/user/quota）；
- `AuthCallbackRouter`、本地回调服务器、deep link 协议可整体废弃；
- 注意保留 `auth:sessionChanged`/过期通知语义，否则 §4.4 的门槛 UI 无法正确登出。

### 风险提示

- **`/api/proxy/*` 是服务器模型的数据面**：只换登录不换模型代理时，须确认 accessToken 对旧代理仍有效，否则聊天主链路（OpenClaw token 代理 → `/api/proxy/v1`）会 401/503；
- refresh 终止码判定（401 / 40100 / 40101 / 企业码）直接决定是否强制登出，错误码语义必须对齐；
- `auth_tokens` kv 结构被媒体账号隔离与数据迁移读取，不要改 key 名与字段；
- 登录参数 `source=electron`、hash 路由参数拼接（`appendLoginParams`）是现有登录页的约定，自研登录页需兼容或同步修改拼接逻辑。

---

## 6. 关键文件索引

| 文件 | 职责 |
|---|---|
| `src/shared/auth/constants.ts` | IPC 通道、会话状态、刷新结果等全部常量 |
| `src/main/main.ts`（Auth IPC handlers，~L4692-7137） | token 存取、exchange/getUser/getQuota/logout 等处理器、`AuthSessionManager` 装配 |
| `src/main/libs/authSessionManager.ts` | token 刷新、`fetchWithAuth`、401 重试、终止失败判定 |
| `src/main/libs/authLocalCallbackServer.ts` | 127.0.0.1 登录回调服务器、登录参数拼接、return_to 白名单 |
| `src/main/libs/authCallbackRouter.ts` | deep link 授权码路由/缓存 |
| `src/main/libs/endpoints.ts` | 服务端 base URL（testMode / 环境变量切换） |
| `src/main/authQuota.ts` | quota 多格式归一化与权益推导 |
| `src/main/libs/openclawTokenProxy.ts` | OpenClaw 网关 → `/api/proxy/*` 的 token 代理 |
| `src/main/enterpriseAccount/context.ts` | 企业账号上下文接口 |
| `src/main/preload.ts`（~L1170） | `window.electron.auth` 暴露面 |
| `src/renderer/services/auth.ts` | 渲染进程登录编排（init/login/callback/quota/logout） |
| `src/renderer/services/endpoints.ts` | 登录页/Portal 各页面 URL |
| `src/renderer/store/slices/authSlice.ts` | 登录态 Redux 切片（UserProfile/UserQuota/ProfileSummary） |
