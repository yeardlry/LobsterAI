import { ipcMain } from 'electron';

import { PaperPipelineIpcChannel } from '../../../shared/paperPipeline/constants';
import {
  type PaperPipelineHandlerEnvelope,
  PaperPipelineProcessingStatus,
  type PaperTask,
  type PaperTaskAdvanceResult,
  type PaperTaskLogEntry,
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
    async (): Promise<PaperPipelineHandlerEnvelope<PaperTask[]>> => {
      if (!deps.isLitAuthSession()) {
        return envelopeError('Lit session required for paper pipeline');
      }
      if (!isPaperPipelineServiceInitialized()) {
        return envelopeError('Paper pipeline service not initialized');
      }
      try {
        const tasks = await getPaperPipelineService().listPendingTasks();
        console.debug(`[PaperPipeline] listPendingTasks → ${tasks.length} task(s)`);
        return envelopeOk(tasks);
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
      if (!payload?.pmid || !payload?.errorMessage) {
        return envelopeError('reportFailure requires { pmid, errorMessage }');
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
          errorMessage: 'Manually reset from UI',
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