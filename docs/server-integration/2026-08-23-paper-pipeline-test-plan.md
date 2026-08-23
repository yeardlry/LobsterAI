# Paper Pipeline — End-to-End Test Plan

This document is the manual + automated test checklist for the LobsterAI ×
`/lit` paper processing pipeline.

The pipeline walks one task through five server-confirmed transitions:

```
xml_ready → parsed → analyzed → categorized → pdf_ready → completed
```

The pipeline is **manual-per-step**: each `advance` call runs exactly one
transition. Multi-step auto-advance would belong in a higher-level
coordinator. See `src/main/paperPipeline/paperPipelineService.ts` for the
state machine and `docs/server-integration/2026-08-16-custom-login-service-integration.md`
for the contract spec.

## 0. Environment

### 0.1 Decide whether you need the OpenClaw runtime

```bash
ls vendor/openclaw-runtime/current/ 2>/dev/null \
  && echo "runtime ready — use plain dev" \
  || echo "missing — first-time dev needs electron:dev:openclaw"
```

| Runtime ready? | Command to run |
|---|---|
| yes | `npm run electron:dev` |
| no (first time) | `npm run electron:dev:openclaw` (builds runtime, then dev) |

`electron:dev` does **not** include the OpenClaw runtime sync; it is only
Vite + Electron. `electron:dev:openclaw` chains `openclaw:runtime:host` in
front of it.

### 0.2 Backend

The `lit` RuoYi backend must be running on `localhost` (typically
`npm run dev` in the `MRnaLnpLiterature` repo). The login form writes the
access token into the `auth_tokens` kv, which the paper pipeline reads.

### 0.3 Test fixtures

Prepare at least these tasks on the backend side:

| Label | PMID example | What it exercises |
|---|---|---|
| A | `PMC8345678`-equivalent | EuropePMC direct PDF URL succeeds (priority 1 strategy) |
| B | any EuropePMC has but PMC.com doesn't | EuropePMC search API succeeds (priority 3) |
| C | old PMID e.g. `12345` | Both deterministic chains fail, token-proxy LLM takes over (priority 4) |
| D | obscure PMID nothing finds | Token-proxy also fails, hidden Cowork session takes over (priority 5) |

## 1. Unit tests (Vitest, runs in plain Node)

```bash
npm test -- paperPipeline
npm test -- hiddenCoworkSession
npm test -- pdfUrlFinder
npm test                                 # full suite, expect 3398 passing
```

Expected:

- 5 tests in `hiddenCoworkSession.test.ts`:
  - happy path: row created, prompt sent, segments captured
  - `permissionRequest` auto-approved
  - `error` event rejects with runtime message
  - timeout rejects and `stopSession` runs
  - missing cwd rejects with clear error
- 4 tests in `pdfUrlFinder.test.ts`:
  - token-proxy extracts URL from chat completion reply
  - token-proxy throws → falls back to hidden session
  - proxy down + no hidden deps → returns null
  - both strategies return NO_PDF → returns null
- 11 tests in `paperPipeline/{xmlParser,analysisService,categoryService}.test.ts`

Full suite should report **3398 passed | 2 skipped**.

## 2. Main-process smoke (Electron running)

Tail the main log while the app is up:

```bash
tail -f ~/Library/Logs/LobsterAI/main-$(date +%Y-%m-%d).log
```

### 2.1 Service Manager lifecycle

- [ ] After lit login: log shows `[PaperPipeline] init: service manager wired`
- [ ] OAuth login (non-lit account): service manager is **not** installed
- [ ] Logout: service manager is disposed

### 2.2 IPC handlers respond

In DevTools console:

```js
await window.electronAPI.paperPipeline.listPendingTasks();
```

- [ ] Returns the current task list
- [ ] Does not crash on a stale / expired token (asks for re-login instead)

## 3. UI flow (manual, Electron running)

### 3.1 Sidebar entry

- [ ] Bottom of sidebar shows the Paper Tasks entry (`zh`: 文献任务)
- [ ] Click → opens `PaperTasksView`
- [ ] When auth session is not lit, the entry is hidden / disabled

### 3.2 List rendering

- [ ] "Refresh pending" button triggers `listPendingTasks`; cards render
- [ ] Status chip colors: `xml_ready` grey / `parsed` blue / `analyzed` purple /
      `categorized` cyan / `pdf_ready` orange / `completed` green / `failed` red
- [ ] `zh` / `en` i18n toggle works on every string

### 3.3 Single-task happy path

Pick one task currently at `xml_ready`:

| Click | Expected status | Expected log line |
|---|---|---|
| 推进 | `xml_ready → parsed` | `[PaperPipeline] <pmid> parsed N author(s)` |
| 推进 | `parsed → analyzed` | `[PaperPipeline] <pmid> generated extSummary (XXX chars)` |
| 推进 | `analyzed → categorized` | `[PaperPipeline] <pmid> picked N categor(ies) and M tag(s)` |
| 推进 | `categorized → pdf_ready` | `[PaperPipeline] <pmid> downloaded XXX bytes → <path>` + `uploaded to <url>` |
| 推进 | **`pdf_ready` stays** | `[PaperPipeline] <pmid> wechat draft prepared at <localPath>` |

### 3.4 WeChat draft modal

- [ ] Auto-opens once the task reaches `pdf_ready`
- [ ] Modal shows: title, summary, category/tag chips
- [ ] "Copy path" puts `~/Library/Application Support/LobsterAI/paperPipeline/wechat/wechat-<pmid>.md` on the clipboard
- [ ] "Open draft in browser" opens the local file in the default editor
- [ ] `docUrl` input rejects anything that does not start with `https://mp.weixin.qq.com/`
- [ ] Submit stays disabled until the URL is valid
- [ ] Paste a valid URL + Submit → task flips to `completed`
- [ ] Cancel → modal closes, task stays at `pdf_ready`

## 4. PDF download strategy matrix (the main thing this PR adds)

For each PMID fixture, verify which strategy served the file:

| PMID type | Expected strategy | Where to look |
|---|---|---|
| A: EuropePMC direct | `europepmc-direct` | main log `[PaperDownload] using europepmc-direct` (Phase 3 logs) |
| B: search API | `europepmc-search` | main log |
| C: token-proxy LLM | (no Phase-3 label) + `[PdfUrlFinder] token-proxy strategy returned <url>` | main log + token-proxy port responding |
| D: hidden Cowork session | `[PdfUrlFinder] token-proxy strategy failed` then `[PdfUrlFinder] hidden-session strategy returned <url>` + `[HiddenCoworkSession] created session sess-XXXX` | main log |

For PMID D, additionally confirm:

- [ ] Session row created in `cowork_sessions` table with title prefixed `[hidden]`
- [ ] `permissionRequest` events auto-approved (no UI prompt)
- [ ] Session stopped after the run (`status = 'idle'`)

## 5. Failure / reset paths

### 5.1 Force a backend failure

Make one endpoint return 500 (e.g. block `/lit/submitParseResult`):

- [ ] Click 推进 → task flips to `failed`, chip turns red
- [ ] `reportTaskFailure` was called automatically
- [ ] Card shows a Reset button
- [ ] Click Reset → task returns to `xml_ready`, can be re-advanced

### 5.2 Manual failure

- [ ] Any card's "Mark failed" → task flips to `failed`

### 5.3 PDF download total failure

- [ ] Task stays at `categorized`, chip red
- [ ] Card log shows `[PaperPdfDownloadError] All PDF strategies exhausted for PMID X`
- [ ] Reset button available

## 6. Auth switching

| Action | Expected |
|---|---|
| Logout of lit | service manager disposed, sidebar entry disappears |
| Login with OAuth account | service manager **not** initialized, no entry |
| Switch back to lit | service manager re-inits, local cache (XML / PDF / wechat md) intact |

## 7. Persistence check

```bash
ls "$HOME/Library/Application Support/LobsterAI/paperPipeline/"
# expect:
#   pdfs/<pmid>.pdf
#   xml/<pmid>.xml
#   wechat/wechat-<pmid>.md
```

- [ ] After a full walk-through, kill Electron and reopen
- [ ] Task statuses survive in SQLite
- [ ] Re-clicking 推进 on the same task reuses the cached PDF / md (no second download)

## 8. Performance / log hygiene

- [ ] Every step has a `[PaperPipeline]`-tagged log line
- [ ] Failures log via `console.error(..., err)` with the error object last
- [ ] No info-level logs in polling or per-message hot paths
- [ ] Each non-LLM step completes in < 30s
- [ ] Hidden session has a 90s upper bound (see `findPdfUrlViaHiddenCoworkSession`)
- [ ] Token-proxy path has no explicit timeout yet (relies on `net.fetch` defaults) — confirm in CI

## 9. Automation candidates (next iteration)

To automate §3–§6, drive the renderer with Playwright Electron and assert:

- `StatusChanged` event order matches §3.3
- Final status = `completed` after the user-submitted docUrl flow
- `wechat-<pmid>.md` file exists with the expected title + summary

Not in scope for this PR. Document the manual checklist above until the
E2E harness exists.