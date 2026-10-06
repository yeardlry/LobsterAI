import { ipcMain } from 'electron';

import { PaperPipelineIpcChannel } from '../../../shared/paperPipeline/constants';
import {
  type PaperPipelineHandlerEnvelope,
  type PaperPipelineModelConfig,
  PaperPipelineProcessingStatus,
  type PaperTaskAdvanceResult,
  type PaperTaskLogEntry,
  type PaperTaskPage,
  type PaperTaskReportFailureRequest,
  type PaperTaskResetRequest,
  type PaperTaskSubmitWechatDocRequest,
} from '../../../shared/paperPipeline/types';
import {
  getPaperPipelineService,
  isPaperPipelineServiceInitialized,
} from '../../paperPipeline/paperPipelineServiceManager';

export interface PaperPipelineHandlerDeps {
  isLitAuthSession: () => boolean;
  /** Reads the pipeline model config (kv store). Local, no lit-auth gate. */
  readPipelineModelConfig: () => PaperPipelineModelConfig;
  /** Sanitizes + persists the pipeline model config. Local, no lit-auth gate. */
  writePipelineModelConfig: (raw: unknown) => PaperPipelineModelConfig;
}

function envelopeOk<T>(data: T): PaperPipelineHandlerEnvelope<T> {
  return { success: true, data };
}

function envelopeError(error: string): PaperPipelineHandlerEnvelope<never> {
  return { success: false, error };
}

/**
 * Register the paper-pipeline IPC handlers. Called from main.ts right after
 * `registerScheduledTaskHandlers(...)`.
 *
 * Every handler:
 *   - returns a uniform `{ success, data?, error? }` envelope;
 *   - bails early with a clear error when the lit session is not active;
 *   - never throws — orchestrator errors are surfaced through `error`.
 */
export function registerPaperPipelineHandlers(deps: PaperPipelineHandlerDeps): void {
  ipcMain.handle(
    PaperPipelineIpcChannel.ListPendingTasks,
    async (
      _event,
      payload?: { page?: number; pageSize?: number },
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskPage>> => {
      // Defense-in-depth: PaperPipelineClient.request() also gates on
      // isLitAuthSession() and would throw a 401-shaped error here.
      // We surface the same message at the IPC boundary so the renderer
      // gets a clean envelope error instead of an orchestrator exception.
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      try {
        const page = await getPaperPipelineService().listPendingTasks({
          page: payload?.page,
          pageSize: payload?.pageSize,
        });
        console.debug(
          `[PaperPipeline] listPendingTasks → ${page.items.length}/${page.total} task(s) (page=${page.page}, pageSize=${page.pageSize})`,
        );
        return envelopeOk(page);
      } catch (err) {
        console.error('[PaperPipeline] listPendingTasks failed', err);
        return envelopeError(err instanceof Error ? err.message : 'listPendingTasks failed');
      }
    },
  );

  ipcMain.handle(
    PaperPipelineIpcChannel.AdvanceTask,
    async (
      _event,
      payload: { pmid: string; currentStatus: PaperPipelineProcessingStatus },
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskAdvanceResult>> => {
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid || !payload?.currentStatus) {
        return envelopeError('advanceTask requires { pmid, currentStatus }');
      }
      try {
        const result = await getPaperPipelineService().advanceTask(
          payload.pmid,
          payload.currentStatus,
        );
        return envelopeOk(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'advanceTask failed';
        console.error(
          `[PaperPipeline] advanceTask ${payload.pmid} from ${payload.currentStatus} failed`,
          err,
        );
        return envelopeError(message);
      }
    },
  );

  ipcMain.handle(
    PaperPipelineIpcChannel.AdvanceTaskAuto,
    async (
      _event,
      payload: {
        pmid: string;
        currentStatus: PaperPipelineProcessingStatus;
        /** Contract v1.3 `openAccess` flag from the task list; optional. */
        openAccess?: boolean | null;
        /** Full PDF URL from listPendingTasks; optional for older callers. */
        pdfUrl?: string | null;
      },
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskAdvanceResult>> => {
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid || !payload?.currentStatus) {
        return envelopeError('advanceTaskAuto requires { pmid, currentStatus }');
      }
      try {
        const result = await getPaperPipelineService().advanceTaskAuto(
          payload.pmid,
          payload.currentStatus,
          undefined,
          {
            openAccess: payload.openAccess ?? null,
            pdfUrl: payload.pdfUrl ?? null,
          },
        );
        return envelopeOk(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'advanceTaskAuto failed';
        console.error(
          `[PaperPipeline] advanceTaskAuto ${payload.pmid} from ${payload.currentStatus} failed`,
          err,
        );
        return envelopeError(message);
      }
    },
  );

  ipcMain.handle(
    PaperPipelineIpcChannel.CancelTaskAuto,
    async (
      _event,
      payload: { pmid: string },
    ): Promise<PaperPipelineHandlerEnvelope<{ cancelled: boolean }>> => {
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid) {
        return envelopeError('cancelTaskAuto requires { pmid }');
      }
      const cancelled = getPaperPipelineService().cancelTaskAuto(payload.pmid);
      return envelopeOk({ cancelled });
    },
  );

  ipcMain.handle(
    PaperPipelineIpcChannel.ReportFailure,
    async (
      _event,
      payload: PaperTaskReportFailureRequest,
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskAdvanceResult>> => {
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid || !payload?.errorMsg) {
        return envelopeError('reportFailure requires { pmid, errorMsg }');
      }
      try {
        const result = await getPaperPipelineService().reportFailure(payload);
        return envelopeOk(result);
      } catch (err) {
        console.error(`[PaperPipeline] reportFailure ${payload.pmid} failed`, err);
        return envelopeError(err instanceof Error ? err.message : 'reportFailure failed');
      }
    },
  );

  ipcMain.handle(
    PaperPipelineIpcChannel.ResetTask,
    async (
      _event,
      payload: PaperTaskResetRequest,
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskAdvanceResult>> => {
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid) {
        return envelopeError('resetTask requires { pmid }');
      }
      try {
        const result = await getPaperPipelineService().reportFailure({
          pmid: payload.pmid,
          errorMsg: 'Manually reset from UI',
          markAsFailed: false,
          resetTo: payload.resetTo ?? 'xml_ready',
        });
        return envelopeOk(result);
      } catch (err) {
        console.error(`[PaperPipeline] resetTask ${payload.pmid} failed`, err);
        return envelopeError(err instanceof Error ? err.message : 'resetTask failed');
      }
    },
  );

  ipcMain.handle(
    PaperPipelineIpcChannel.GetTaskLog,
    async (
      _event,
      payload: { pmid: string },
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskLogEntry[]>> => {
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid) {
        return envelopeError('getTaskLog requires { pmid }');
      }
      try {
        const log = getPaperPipelineService().getTaskLog(payload.pmid);
        return envelopeOk(log);
      } catch (err) {
        return envelopeError(err instanceof Error ? err.message : 'getTaskLog failed');
      }
    },
  );

  /**
   * Renderer → main: read the pipeline model config. Purely local (kv
   * store) — no lit-auth and no service-init gate, mirroring the
   * GetTaskLog local-only precedent.
   */
  ipcMain.handle(
    PaperPipelineIpcChannel.GetModelConfig,
    async (): Promise<PaperPipelineHandlerEnvelope<PaperPipelineModelConfig>> => {
      try {
        return envelopeOk(deps.readPipelineModelConfig());
      } catch (err) {
        console.error('[PaperPipeline] getModelConfig failed', err);
        return envelopeError(err instanceof Error ? err.message : 'getModelConfig failed');
      }
    },
  );

  /**
   * Renderer → main: persist the pipeline model config. Field-level shape
   * validation here; deep sanitization (ref shape, fallbacks) lives in
   * `sanitizePaperPipelineModelConfig` via the write thunk.
   */
  ipcMain.handle(
    PaperPipelineIpcChannel.SetModelConfig,
    async (
      _event,
      payload: { pipelineModel?: unknown; pdfUrlSuggestModel?: unknown },
    ): Promise<PaperPipelineHandlerEnvelope<PaperPipelineModelConfig>> => {
      const isValidField = (value: unknown): boolean =>
        value === undefined || typeof value === 'string';
      if (
        !payload
        || typeof payload !== 'object'
        || !isValidField(payload.pipelineModel)
        || !isValidField(payload.pdfUrlSuggestModel)
      ) {
        return envelopeError(
          'setModelConfig requires { pipelineModel, pdfUrlSuggestModel } as strings',
        );
      }
      try {
        return envelopeOk(deps.writePipelineModelConfig(payload));
      } catch (err) {
        console.error('[PaperPipeline] setModelConfig failed', err);
        return envelopeError(err instanceof Error ? err.message : 'setModelConfig failed');
      }
    },
  );

  /**
   * Renderer → main: user pasted a `https://mp.weixin.qq.com/s/...` link
   * from 微信公众平台 back into LobsterAI. Flips the task to `completed`.
   */
  ipcMain.handle(
    PaperPipelineIpcChannel.SubmitWechatDoc,
    async (
      _event,
      payload: PaperTaskSubmitWechatDocRequest,
    ): Promise<PaperPipelineHandlerEnvelope<PaperTaskAdvanceResult>> => {
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      if (!payload?.pmid || !payload?.docUrl) {
        return envelopeError('submitWechatDoc requires { pmid, docUrl }');
      }
      if (!/^https:\/\/mp\.weixin\.qq\.com\//i.test(payload.docUrl)) {
        return envelopeError('docUrl must start with https://mp.weixin.qq.com/');
      }
      try {
        const result = await getPaperPipelineService().submitUserProvidedDocUrl(
          payload.pmid,
          payload.docUrl,
          payload.extras ?? {},
        );
        return envelopeOk(result);
      } catch (err) {
        console.error(`[PaperPipeline] submitWechatDoc ${payload.pmid} failed`, err);
        return envelopeError(err instanceof Error ? err.message : 'submitWechatDoc failed');
      }
    },
  );
}
