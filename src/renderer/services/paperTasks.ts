import {
  PaperPipelineProcessingStatus,
  type PaperTask,
} from '../../shared/paperPipeline/types';
import { reportPaperTaskAction } from '../components/paperTasks/analytics';
import { store } from '../store';
import {
  appendLogEntry,
  applyStatusChange,
  closeWechatDraftModal,
  PaperTasksDataStatus,
  setAdvancingPmid,
  setDisabled,
  setListError,
  setListStatus,
  setSubmittingWechatPmid,
  setTasks,
  setWechatDraft,
} from '../store/slices/paperTasksSlice';

function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
}

interface AdvanceResult {
  pmid: string;
  toStatus: string;
}

/** Shape returned when an advance step produced a WeChat draft. */
interface DraftAdvanceResult {
  pmid: string;
  toStatus: string;
  draftLocalPath: string;
  draftUrl: string;
  draftTitle: string;
  draftSummary: string;
}

function isDraftResult(value: unknown): value is DraftAdvanceResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.draftLocalPath === 'string' &&
    typeof v.draftUrl === 'string' &&
    typeof v.draftTitle === 'string'
  );
}

export class PaperTasksService {
  private cleanupFns: Array<() => void> = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setupListeners();
    // Do not auto-load: the lit session may not be active at app start. The
    // user triggers `loadTasks()` from the Paper Tasks page.
  }

  destroy(): void {
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.paperPipeline;
    if (!api) return;

    this.cleanupFns.push(
      api.onStatusChanged(event => {
        store.dispatch(applyStatusChange(event));
        store.dispatch(setAdvancingPmid(null));
      }),
    );
    this.cleanupFns.push(
      api.onLog(entry => {
        store.dispatch(appendLogEntry(entry));
      }),
    );
  }

  /**
   * Fetch the pending task list from the lit backend. If lit auth is not
   * active the service marks itself `disabled` so the UI can render a clear
   * hint instead of stale data.
   */
  async loadTasks(): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    store.dispatch(setListStatus(PaperTasksDataStatus.Loading));
    reportPaperTaskAction('refresh_list', {});
    const result = await api.listPendingTasks();
    if (!result.success) {
      store.dispatch(setListError(result.error ?? 'listPendingTasks failed'));
      store.dispatch(setDisabled(true));
      return;
    }
    store.dispatch(setDisabled(false));
    store.dispatch(setTasks(result.data ?? []));
    store.dispatch(setListStatus(PaperTasksDataStatus.Ready));
  }

  /**
   * Advance one task through one state transition. Returns the resulting
   * status (or null on failure) so the caller can show a toast.
   *
   * If the step produces a WeChat draft (`status === 'pdf_ready'` and the
   * orchestrator stayed there), this also dispatches `setWechatDraft` so
   * the modal pops automatically.
   */
  async advanceTask(pmid: string, currentStatus: PaperPipelineProcessingStatus): Promise<AdvanceResult | null> {
    const api = window.electron?.paperPipeline;
    if (!api) return null;
    store.dispatch(setAdvancingPmid(pmid));
    reportPaperTaskAction('advance_task', { pmid, fromStatus: currentStatus });
    const result = await api.advanceTask(pmid, currentStatus);
    store.dispatch(setAdvancingPmid(null));
    if (!result.success || !result.data) {
      showToast(result.error ?? 'advanceTask failed');
      return null;
    }
    // If the orchestrator handed us a draft (Phase 4 — generateWechatDoc),
    // the IPC envelope already carries the draft payload. Forward it to the
    // slice so the modal opens.
    if (isDraftResult(result.data) && currentStatus === PaperPipelineProcessingStatus.PdfReady) {
      store.dispatch(
        setWechatDraft({
          pmid,
          draft: {
            localPath: result.data.draftLocalPath,
            publicUrl: result.data.draftUrl,
            title: result.data.draftTitle,
            summary: result.data.draftSummary,
            submitted: false,
          },
        }),
      );
    }
    return { pmid: result.data.pmid, toStatus: result.data.toStatus };
  }

  /** Manual "Mark failed" UI button. */
  async reportFailure(pmid: string, errorMessage: string): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    reportPaperTaskAction('mark_failed', { pmid });
    const result = await api.reportFailure({
      pmid,
      errorMessage,
      markAsFailed: true,
    });
    if (!result.success) {
      showToast(result.error ?? 'reportFailure failed');
    }
  }

  /** Manual "Reset" UI button. */
  async resetTask(pmid: string): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    reportPaperTaskAction('reset_task', { pmid });
    const result = await api.resetTask(pmid, 'xml_ready');
    if (!result.success) {
      showToast(result.error ?? 'resetTask failed');
    }
  }

  /** Read the buffered log for a single task. */
  async getTaskLog(pmid: string): Promise<unknown[]> {
    const api = window.electron?.paperPipeline;
    if (!api) return [];
    const result = await api.getTaskLog(pmid);
    return result.success ? (result.data ?? []) : [];
  }

  /**
   * Submit a user-pasted `https://mp.weixin.qq.com/s/...` link after the
   * user has copied the prepared Markdown into 微信公众平台 and pasted the
   * resulting docUrl back into LobsterAI. Flips the task to `completed`.
   */
  async submitWechatDoc(
    pmid: string,
    docUrl: string,
    extras?: Record<string, unknown>,
  ): Promise<AdvanceResult | null> {
    const api = window.electron?.paperPipeline;
    if (!api) return null;
    store.dispatch(setSubmittingWechatPmid(pmid));
    reportPaperTaskAction('submit_wechat_doc', { pmid });
    const result = await api.submitWechatDoc({ pmid, docUrl, extras });
    store.dispatch(setSubmittingWechatPmid(null));
    if (!result.success || !result.data) {
      showToast(result.error ?? 'submitWechatDoc failed');
      return null;
    }
    // The StatusChanged push from main will also clear the draft + close
    // the modal, but we close immediately so the UI doesn't flicker.
    store.dispatch(closeWechatDraftModal());
    return { pmid: result.data.pmid, toStatus: result.data.toStatus };
  }

  /** Close the WeChat draft modal without submitting. */
  cancelWechatDraft(): void {
    store.dispatch(closeWechatDraftModal());
  }
}

export const paperTasksService = new PaperTasksService();
export type { PaperTask };