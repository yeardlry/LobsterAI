/**
 * Paper Pipeline (literature backend) — cross-process constants.
 *
 * The literature backend is the RuoYi `/lit/*` service that already powers
 * LobsterAI's credentials login (`getLitServerBaseUrl()` in `libs/endpoints.ts`).
 * This module defines the IPC channels, processing-state enum, and the response
 * envelope code the new paper-processing endpoints agree on.
 */

export const PaperPipelineIpcChannel = {
  ListPendingTasks: 'paperPipeline:listPendingTasks',
  AdvanceTask: 'paperPipeline:advanceTask',
  /**
   * Renderer → main: run every remaining step of a task in one call,
   * stopping after the GenerateWechatDoc step (markdown draft + word
   * export + word upload). The single-step `AdvanceTask` stays available
   * for step-by-step use.
   */
  AdvanceTaskAuto: 'paperPipeline:advanceTaskAuto',
  /** Renderer → main: cancel a running one-click auto-advance. */
  CancelTaskAuto: 'paperPipeline:cancelTaskAuto',
  ReportFailure: 'paperPipeline:reportFailure',
  ResetTask: 'paperPipeline:resetTask',
  GetTaskLog: 'paperPipeline:getTaskLog',
  /**
   * Renderer → main: read the pipeline model config (local kv, no lit-auth
   * or service-init gate — mirrors GetTaskLog's local-only precedent).
   */
  GetModelConfig: 'paperPipeline:getModelConfig',
  /** Renderer → main: persist the pipeline model config. */
  SetModelConfig: 'paperPipeline:setModelConfig',
  /**
   * Renderer → main: user pasted a `https://mp.weixin.qq.com/s/...` link
   * from 微信公众平台 back into LobsterAI. Flips the task from
   * `pdf_ready` to `completed`.
   */
  SubmitWechatDoc: 'paperPipeline:submitWechatDoc',
  /** main → renderer: a task's status changed (push after every submit). */
  StatusChanged: 'paperPipeline:statusChanged',
  /** main → renderer: per-step execution log line. */
  Log: 'paperPipeline:log',
} as const;
export type PaperPipelineIpcChannel = typeof PaperPipelineIpcChannel[keyof typeof PaperPipelineIpcChannel];

/**
 * State machine for a single paper task. Mirrors the contract the lit backend
 * owns — LobsterAI advances `xml_ready → parsed → analyzed → categorized →
 * pdf_ready → completed` and may mark `failed` or reset to `xml_ready`.
 *
 * `fetched` (序 0) only occurs on historical imports — fresh PubMed pulls
 * are INSERTed directly at `xml_ready` (PubmedSyncTask), and there is no
 * Quartz hop out of `fetched`. The backend's assertTransition still accepts
 * `fetched → parsed` when OSS already holds the XML for the pmid (it
 * back-fills `xml_ready` first), so LobsterAI treats `fetched` like
 * `xml_ready`: fetch the XML, parse authors, submit `submitParseResult`.
 *
 * `failed` self-heals: any `submit*` call (or a successful
 * `getXmlContent`) that finds the XML in OSS moves the task back to
 * `xml_ready` before validation, so a failed task can be re-advanced
 * without an explicit reset.
 */
export const PaperPipelineProcessingStatus = {
  Fetched: 'fetched',
  XmlReady: 'xml_ready',
  Parsed: 'parsed',
  Analyzed: 'analyzed',
  Categorized: 'categorized',
  PdfReady: 'pdf_ready',
  Completed: 'completed',
  Failed: 'failed',
} as const;
export type PaperPipelineProcessingStatus =
  typeof PaperPipelineProcessingStatus[keyof typeof PaperPipelineProcessingStatus];

/**
 * lit-backend response envelope — RuoYi style: `code === 200` is success.
 * `msg` (RuoYi native) takes priority over `message` for error text.
 */
export const LitResponseCode = {
  Success: 200,
} as const;
export type LitResponseCode = typeof LitResponseCode[keyof typeof LitResponseCode];

/**
 * Full-text accessibility of a paper (contract v1.3, 2026-09-19): the lit
 * backend's `literature.access_status`, where a PMCID means the article is
 * on PubMed Central and thus public. `openAccess` on `PaperTask` is the
 * derived boolean convenience — `public` ⇔ OA PDF downloadable, `private`
 * ⇔ closed access, HTML landing-page path.
 */
export const LitAccessStatus = {
  Public: 'public',
  Private: 'private',
} as const;
export type LitAccessStatus = typeof LitAccessStatus[keyof typeof LitAccessStatus];

/**
 * Lit OSS archive-key contract (2026-09-16, agreed with the lit backend):
 * every archival upload is keyed by PMID — `{dir}/{pmid}.{ext}`, overwrite
 * in place (re-uploading the same pmid updates the version). Chosen over
 * PMCID because pmid is the pipeline's primary key with 100% coverage,
 * while pmcid only exists for PMC-deposited OA articles.
 *
 * `POST /lit/upload/oss` returns `data.url` = the key itself, and the
 * client passes that key straight into `submitFile`, which rejects any
 * url that does not match this rule (backend-side guard against clients
 * bypassing the upload endpoint with legacy timestamp names).
 *
 * Non-archive uploads (none today) omit pmid and keep the legacy
 * `{dir}{timestamp}_{filename}` naming.
 */
export const LitArchiveFileType = {
  Pdf: 'pdf',
  Html: 'html',
  Word: 'word',
  /**
   * DANGER: do not upload xml artifacts from LobsterAI. The backend's
   * `xml_url` column holds the ORIGINAL PubMed XML, whose OSS key is
   * `xml/{pmcid}.xml` (or `xml/{pmid}.xml` for non-PMC records) — a
   * LobsterAI xml upload at `xml/{pmid}.pdf`-style keys would overwrite
   * the raw source object. Parse results go through `submitParseResult`,
   * never through file upload. Kept here only because the backend
   * contract defines the mapping.
   */
  Xml: 'xml',
  Md: 'md',
} as const;
export type LitArchiveFileType = typeof LitArchiveFileType[keyof typeof LitArchiveFileType];

const LitArchiveKeyLayout: Record<LitArchiveFileType, { dir: string; ext: string }> = {
  [LitArchiveFileType.Pdf]: { dir: 'pdf', ext: 'pdf' },
  [LitArchiveFileType.Html]: { dir: 'html', ext: 'html' },
  [LitArchiveFileType.Word]: { dir: 'word', ext: 'docx' },
  [LitArchiveFileType.Xml]: { dir: 'xml', ext: 'xml' },
  [LitArchiveFileType.Md]: { dir: 'md', ext: 'md' },
};

/**
 * Expected OSS key for a pmid-keyed archive upload, e.g. `pdf/12345.pdf`.
 * Returns null for non-archive file types (caller keeps whatever the
 * backend returned).
 */
export const buildLitArchiveKey = (
  fileType: string,
  pmid: string,
): string | null => {
  const layout = LitArchiveKeyLayout[fileType as LitArchiveFileType];
  if (!layout) return null;
  return `${layout.dir}/${pmid}.${layout.ext}`;
};

/** Highest status a task can be reset to from any later step. */
export const PaperPipelineResetTarget = {
  XmlReady: PaperPipelineProcessingStatus.XmlReady,
} as const;
export type PaperPipelineResetTarget = typeof PaperPipelineResetTarget[keyof typeof PaperPipelineResetTarget];

/**
 * Per-step actions `AdvanceTask` can dispatch to, in priority order.
 * The orchestrator maps `currentStatus → action` and runs the right stub.
 */
export const PaperPipelineAdvanceAction = {
  ParseXml: 'parseXml',
  Analyze: 'analyze',
  Categorize: 'categorize',
  DownloadAndUploadPdf: 'downloadAndUploadPdf',
  GenerateWechatDoc: 'generateWechatDoc',
} as const;
export type PaperPipelineAdvanceAction =
  typeof PaperPipelineAdvanceAction[keyof typeof PaperPipelineAdvanceAction];

/**
 * Header that lets the lit backend's filter dispatch a request directly to
 * `LitTokenService` instead of attempting both `TokenService` and
 * `LitTokenService` and logging a DEBUG mismatch on the wrong branch.
 *
 * Every authenticated `/lit/*` call from the main process should set
 * `X-Token-Type: lit`. Login (`/lit/login`) is unauthenticated and does
 * not need it. See `docs/server-integration/...` for the backend contract.
 */
export const LitAuthHeader = {
  Name: 'X-Token-Type',
  Value: 'lit',
} as const;
export type LitAuthHeader = typeof LitAuthHeader[keyof typeof LitAuthHeader];

/**
 * Marker the lit backend puts in the error message when a submit endpoint
 * rejects a transition its server-side state machine does not allow, with a
 * fixed format `状态转换非法: {from} → {to}（pmid=...）`. It almost always
 * means the client's view of the task status is stale relative to the
 * server (duplicate submit, task reset/advanced elsewhere) — NOT a
 * processing failure.
 *
 * Contract (agreed 2026-09-16, backend LiteratureExternalServiceImpl): this
 * marker appears ONLY in the genuine state-machine rejection. The backend
 * pins that with a `hasMessageNotContaining("状态转换非法")` test and will
 * notify LobsterAI before changing the wording.
 *
 * Both processes key off this marker: the main-process orchestrator skips
 * `reportTaskFailure` (markAsFailed would pollute a recoverable task), and
 * the renderer re-fetches the pending list so the card shows the
 * authoritative status.
 */
export const LitStateTransitionConflictMarker = '状态转换非法';

/** True when a message is the backend's state-transition rejection. */
export const isLitStateTransitionConflict = (
  message: string | null | undefined,
): boolean =>
  typeof message === 'string' && message.includes(LitStateTransitionConflictMarker);

/**
 * Marker for the backend's retryable "XML not in OSS" rejection, emitted
 * when a `fetched` task's submit cannot be back-filled because OSS holds
 * no XML for the pmid (transient Qiniu/network trouble, or the row
 * legitimately sits at `fetched` with no XML yet). Format:
 * `XML 不可用：OSS 未找到 XML，无法推进 fetched → parsed（pmid=...）...`.
 *
 * This is NOT a state conflict — the row is exactly where it should be —
 * so the renderer must NOT refresh/skip; the correct client reaction is to
 * surface the message and let the user retry later.
 */
export const LitXmlUnavailableMarker = 'XML 不可用';

/** True when a message is the backend's retryable XML-unavailable rejection. */
export const isLitXmlUnavailableError = (
  message: string | null | undefined,
): boolean =>
  typeof message === 'string' && message.includes(LitXmlUnavailableMarker);

/**
 * Default model for the token-proxy PDF-URL-suggestion chat completion
 * (the value previously hardcoded in `pdfUrlFinder.ts`). Shared so both the
 * main process (fallback) and the renderer (default-state display) use one
 * literal. Used when `PaperPipelineModelConfig.pdfUrlSuggestModel` is `''`.
 */
export const DEFAULT_PDF_URL_SUGGEST_MODEL = 'lobsterai-server/deepseek-v4-flash';
