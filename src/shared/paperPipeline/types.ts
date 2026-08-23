import {
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

/**
 * Paper task shape as returned by `/lit/listPendingTasks`.
 * Only the fields LobsterAI needs to drive the state machine are typed.
 */
export interface PaperTask {
  pmid: string;
  title?: string | null;
  status: PaperPipelineProcessingStatus;
  /** Optional failure reason — populated when status === 'failed'. */
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
  /** Optional extras to forward (e.g. the OSS markdown URL for traceability). */
  extras?: Record<string, unknown>;
}

export interface PaperTaskReportFailureRequest {
  pmid: string;
  errorMessage: string;
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