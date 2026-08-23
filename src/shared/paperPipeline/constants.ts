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
  ReportFailure: 'paperPipeline:reportFailure',
  ResetTask: 'paperPipeline:resetTask',
  GetTaskLog: 'paperPipeline:getTaskLog',
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
 */
export const PaperPipelineProcessingStatus = {
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