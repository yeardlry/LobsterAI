import {
  LitAccessStatus as LitAccessStatusValue,
  PaperPipelineAdvanceAction as PaperPipelineAdvanceActionValue,
  PaperPipelineProcessingStatus as PaperPipelineProcessingStatusValue,
} from './constants';

// Re-export the constants as both values and types so consumers can
// `import { PaperPipelineProcessingStatus } from '.../types'` and use it
// in both runtime expressions (`PaperPipelineProcessingStatus.XmlReady`) and
// type positions (`PaperPipelineProcessingStatus` as a type).
export const PaperPipelineAdvanceAction = PaperPipelineAdvanceActionValue;
export type PaperPipelineAdvanceAction = typeof PaperPipelineAdvanceActionValue[keyof typeof PaperPipelineAdvanceActionValue];
export const PaperPipelineProcessingStatus = PaperPipelineProcessingStatusValue;
export type PaperPipelineProcessingStatus = typeof PaperPipelineProcessingStatusValue[keyof typeof PaperPipelineProcessingStatusValue];
export const LitAccessStatus = LitAccessStatusValue;
export type LitAccessStatus = typeof LitAccessStatusValue[keyof typeof LitAccessStatusValue];

/**
 * Paper task shape as returned by `/lit/listPendingTasks` per the
 * authoritative contract ([MRnaLnpLiterature MCP接口权威契约 §5.1](file:///Users/yeardlryng/Project/Java/MRnaLnpLiterature/docs/MCP%E6%8E%A5%E5%8F%A3%E6%9D%83%E5%A8%81%E5%A5%97%E7%BA%A6.md)).
 *
 * The contract returns `processingStatus` (LobsterAI used to call this
 * `status` — renamed 2026-08-26 to match the wire format).
 */
export interface PaperTask {
  /** Server-side primary key. */
  id?: number | string | null;
  pmid: string;
  title?: string | null;
  /** Current processing state (matches `PaperPipelineProcessingStatus` enum). */
  processingStatus: PaperPipelineProcessingStatus;
  /** Publication date from PubMed, ISO-8601 string. */
  publishDate?: string | null;
  doi?: string | null;
  /** True iff `literature.xml_url` is non-empty on the server. */
  xmlReady?: boolean | null;
  /** True iff `literature.pdf_url` is non-empty on the server. */
  pdfReady?: boolean | null;
  /**
   * `literature.access_status` — 'public' (PMCID present) or 'private'.
   * Contract v1.3 (2026-09-19).
   */
  accessStatus?: LitAccessStatus | null;
  /**
   * True = OA PDF downloadable; false = closed access, the pipeline uses
   * the HTML landing page (`submitFile(html)`). Drives the download-chain
   * short-circuit so known-closed papers skip the doomed PDF attempts.
   * Contract v1.3 (2026-09-19); null when the backend predates it.
   */
  openAccess?: boolean | null;
  /**
   * True iff `literature.ext_summary` is non-empty on the server.
   * Contract v1.6 (2026-09-24); undefined when the backend predates it.
   */
  extSummaryReady?: boolean | null;
  /** `literature_category` relation count. Contract v1.6 (2026-09-24). */
  categoryCount?: number | null;
  /** `literature_tag` relation count. Contract v1.6 (2026-09-24). */
  tagCount?: number | null;
  /** Optional failure reason — populated when `processingStatus === 'failed'`. */
  errorMessage?: string | null;
  /** Server timestamp of the last status transition. */
  updatedAt?: string | null;
  /** Authors already known by the server (populated once `parsed`). */
  authors?: PaperTaskAuthor[] | null;
  /** Submission summary already known by the server. */
  extSummary?: string | null;
  categoryIds?: string[] | null;
  tagIds?: string[] | null;
  pdfUrl?: string | null;
  wechatDocUrl?: string | null;
  /** Arbitrary extras preserved on the server. */
  extras?: Record<string, unknown> | null;
}

export interface PaperTaskAuthor {
  firstName?: string | null;
  lastName?: string | null;
  fullName: string;
  affiliation?: string | null;
  /** 1-based order in the author list. Filled in by the parser when known. */
  order?: number | null;
}

/** Local-only execution log line emitted by the orchestrator. */
export interface PaperTaskLogEntry {
  pmid: string;
  /** ISO-8601 timestamp. */
  at: string;
  /** Free-form level. */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Free-form message. */
  message: string;
  /** Optional structured detail. */
  detail?: Record<string, unknown> | null;
}

export interface PaperTaskAdvanceRequest {
  pmid: string;
}

/**
 * Page of pending paper tasks as returned by `/lit/listPendingTasks`.
 * Mirrors the RuoYi paginated envelope — total / page / pageSize let the
 * renderer render a "上一页 / 下一页 / 共 N 条" pager without re-fetching
 * just to know how big the dataset is.
 *
 * See MRnaLnpLiterature MCP接口权威契约 §5.1.
 */
export interface PaperTaskPage {
  items: PaperTask[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaperTaskAdvanceResult {
  pmid: string;
  /** Status *before* the step ran. */
  fromStatus: PaperPipelineProcessingStatus;
  /** Status *after* the submit succeeded. */
  toStatus: PaperPipelineProcessingStatus;
  /** Which step ran (matches `PaperPipelineAdvanceAction`). */
  action: PaperPipelineAdvanceAction;
  /**
   * Only present when the action is `generateWechatDoc`. Tells the renderer
   * where to read the prepared Markdown from, plus a (public) OSS URL the
   * user can open in 微信编辑器 directly. Status stays `pdf_ready` until
   * the user submits the docUrl back via `submitWechatDoc`.
   */
  draftLocalPath?: string;
  draftUrl?: string;
  draftTitle?: string;
  draftSummary?: string;
}

/** Renderer → main: user pasted a `https://mp.weixin.qq.com/s/...` link. */
export interface PaperTaskSubmitWechatDocRequest {
  pmid: string;
  docUrl: string;
  /**
   * Optional extras to forward (e.g. the OSS markdown URL for traceability).
   * Wire format per contract §5.7 is a **JSON string**, not a map — the
   * paper-pipeline client serialises this property before sending.
   */
  extras?: Record<string, unknown>;
}

export interface PaperTaskReportFailureRequest {
  pmid: string;
  /**
   * Free-form error description (server logs only; not length-validated).
   * Wire name is `errorMsg` per contract §5.8 — the client (and renderer
   * service) translate to/from this property.
   */
  errorMsg: string;
  /** When true the server marks the task as `failed`. When false the task is reset. */
  markAsFailed: boolean;
  /** Required when `markAsFailed === false`; defaults to `xml_ready`. */
  resetTo?: PaperPipelineProcessingStatus;
}

export interface PaperTaskResetRequest {
  pmid: string;
  resetTo?: PaperPipelineProcessingStatus;
}

/** Envelope used by every paperPipeline:* invoke handler. */
export interface PaperPipelineHandlerEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * User-configurable model selection for the paper pipeline, edited on the
 * Paper Tasks page and persisted in the main-process kv store.
 *
 * Values are provider-qualified model refs (e.g.
 * `'deepseek/deepseek-v4-flash'`, `'lobsterai-server/deepseek-v4-flash'`).
 *
 * Known limitation (out of scope): subagents spawned INSIDE the pipeline's
 * hidden Cowork sessions use OpenClaw's `agents.defaults.model.primary`
 * (the global default model) and cannot be overridden per-session from
 * LobsterAI today.
 */
export interface PaperPipelineModelConfig {
  /**
   * Model override for every hidden-session LLM step of one-click advance
   * and scheduled-task autopilot (analysis, categorization, PDF download,
   * fulltext-md, WeChat draft, word export).
   *
   * `''` = smart follow: use the driving agent's binding, except that a
   * DeepSeek-family reasoner model (`deepseek-reasoner` / `deepseek-r1`)
   * is swapped for `deepseek-v4-flash` within the same provider. Other
   * providers are never cross-overridden.
   */
  pipelineModel: string;
  /**
   * Model for the token-proxy PDF-URL-suggestion chat completion.
   * `''` = `DEFAULT_PDF_URL_SUGGEST_MODEL`.
   */
  pdfUrlSuggestModel: string;
}

/** Payload pushed via `paperPipeline:statusChanged`. */
export interface PaperTaskStatusChangedEvent {
  pmid: string;
  fromStatus?: PaperPipelineProcessingStatus;
  toStatus: PaperPipelineProcessingStatus;
  /** Set when transitioning into `failed`. */
  errorMessage?: string | null;
}

/** Payload pushed via `paperPipeline:log`. */
export type PaperTaskLogEvent = PaperTaskLogEntry;

/** Lit endpoint response envelope (RuoYi). */
export interface LitEnvelope<T> {
  code: number;
  msg?: string;
  message?: string;
  data?: T;
}

/** Parsed result of an envelope. */
export interface LitEnvelopeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}