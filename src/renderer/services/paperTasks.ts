import {
  isLitStateTransitionConflict,
  PaperPipelineProcessingStatus,
} from '../../shared/paperPipeline/constants';
import {
  type PaperPipelineModelConfig,
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
  setModelConfig,
  setModelConfigSaving,
  setSubmittingWechatPmid,
  setTasks,
  setWechatDraft,
} from '../store/slices/paperTasksSlice';
import { i18nService } from './i18n';

/** Default page size for /lit/listPendingTasks — backend caps at 50. */
export const DEFAULT_PAPER_TASKS_PAGE_SIZE = 20;

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
  /**
   * Tasks with an `advanceTaskAuto` full run in flight. The StatusChanged
   * listener normally clears `advancingPmid` on every push, but an auto run
   * emits one push per intermediate step — clearing mid-run would re-enable
   * the advance button and invite a double click. Cleared in the auto
   * method's finally block.
   */
  private readonly autoRunningPmids = new Set<string>();
  /**
   * Debounce timer for background list refreshes. Status pushes from an
   * autopilot batch (scheduled task) arrive several times per paper; one
   * debounced silent reload keeps the whole list fresh without the loading
   * flicker a manual refresh shows.
   */
  private backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setupListeners();
    // Do not auto-load: the lit session may not be active at app start. The
    // user triggers `loadTasks()` from the Paper Tasks page.
  }

  destroy(): void {
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.paperPipeline;
    if (!api) return;

    this.cleanupFns.push(
      api.onStatusChanged(event => {
        const changed = event as { pmid?: string };
        store.dispatch(applyStatusChange(event));
        // A single-step advance is over once its push arrives; an auto run
        // keeps its busy flag until the whole run settles.
        if (!changed.pmid || !this.autoRunningPmids.has(changed.pmid)) {
          store.dispatch(setAdvancingPmid(null));
        }
        // A scheduled-task autopilot batch advances tasks without any
        // renderer involvement — schedule a silent reload so the cards
        // reflect its progress even when the user is just watching.
        this.scheduleBackgroundRefresh();
      }),
    );
    this.cleanupFns.push(
      api.onLog(entry => {
        store.dispatch(appendLogEntry(entry));
      }),
    );
  }

  private scheduleBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer);
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null;
      void this.loadTasks({ silent: true });
    }, 1500);
  }

  /**
   * Fetch a page of pending tasks from the lit backend. If lit auth is not
   * active the service marks itself `disabled` so the UI can render a clear
   * hint instead of stale data.
   *
   * - `silent` skips the loading state, analytics, and error surfacing —
   *   used by background refreshes where a spinner or toast would be noise.
   * - `page` / `pageSize` are explicit overrides for "jump to page N";
   *   when omitted the call refreshes whichever page the UI is currently
   *   on (so a status-push-driven silent refresh doesn't yank the user
   *   back to page 1).
   */
  async loadTasks(
    options: { silent?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    const silent = options.silent ?? false;
    const state = store.getState().paperTasks;
    const page = options.page ?? state.page ?? 1;
    const pageSize = options.pageSize ?? state.pageSize ?? DEFAULT_PAPER_TASKS_PAGE_SIZE;
    if (!silent) {
      store.dispatch(setListStatus(PaperTasksDataStatus.Loading));
      reportPaperTaskAction('refresh_list', { page, pageSize });
    }
    const result = await api.listPendingTasks({ page, pageSize });
    if (!result.success) {
      if (!silent) {
        store.dispatch(setListError(result.error ?? 'listPendingTasks failed'));
        store.dispatch(setDisabled(true));
      }
      return;
    }
    store.dispatch(setDisabled(false));
    // The handler always returns a PaperTaskPage; defensively fall back to
    // an empty page so dispatch types stay sound if the backend contract
    // ever drifts.
    const pageResult = result.data ?? {
      items: [],
      total: 0,
      page,
      pageSize,
    };
    store.dispatch(setTasks(pageResult));
    if (!silent) {
      store.dispatch(setListStatus(PaperTasksDataStatus.Ready));
    }
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
      // A state-transition rejection means the card's status is stale
      // relative to the backend (Quartz hop not run yet, duplicate
      // submit, task reset elsewhere). Re-fetch the list so the card
      // shows the authoritative status instead of inviting another
      // blind click from the same stale status.
      if (isLitStateTransitionConflict(result.error)) {
        void this.loadTasks();
      }
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

  /**
   * Advance a task through EVERY remaining step in one call (parse →
   * analyze → categorize → pdf → wechat doc incl. word export/upload),
   * stopping after the word document is uploaded. The per-step logs stream
   * in through the Log listener; each intermediate status push updates the
   * card without clearing the busy flag (see {@link autoRunningPmids}).
   *
   * On success the final GenerateWechatDoc payload opens the WeChat draft
   * modal — the only remaining manual action is pasting the docUrl back.
   * A step failure stops the run, shows the toast, and leaves the task in
   * whatever status survived (the main process already reported it).
   */
  async advanceTaskAuto(
    pmid: string,
    currentStatus: PaperPipelineProcessingStatus,
    /**
     * Contract v1.3 `openAccess` from the task list. False tells the main
     * process the paper is closed access so it skips the doomed PDF
     * download chain and goes straight to the HTML landing page.
     */
    openAccess?: boolean | null,
    pdfUrl?: string | null,
  ): Promise<AdvanceResult | null> {
    const api = window.electron?.paperPipeline;
    if (!api) return null;
    // Double-click / repeat-click guard: one auto run per task.
    if (this.autoRunningPmids.has(pmid)) return null;
    this.autoRunningPmids.add(pmid);
    store.dispatch(setAdvancingPmid(pmid));
    reportPaperTaskAction('advance_task_auto', { pmid, fromStatus: currentStatus });
    try {
      const result = await api.advanceTaskAuto(pmid, currentStatus, openAccess ?? null, pdfUrl ?? null);
      if (!result.success || !result.data) {
        showToast(result.error ?? 'advanceTaskAuto failed');
        if (isLitStateTransitionConflict(result.error)) {
          void this.loadTasks();
        }
        return null;
      }
      if (isDraftResult(result.data)) {
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
    } finally {
      this.autoRunningPmids.delete(pmid);
      store.dispatch(setAdvancingPmid(null));
    }
  }

  /** Request cancellation of the running one-click advance for one task. */
  async cancelTaskAuto(pmid: string): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    const result = await api.cancelTaskAuto(pmid);
    if (!result.success) {
      showToast(result.error ?? 'cancelTaskAuto failed');
    }
  }

  /** Manual "Mark failed" UI button. */
  async reportFailure(pmid: string, errorMsg: string): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    reportPaperTaskAction('mark_failed', { pmid });
    const result = await api.reportFailure({
      pmid,
      errorMsg,
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
   * Load the pipeline model config into the store. On failure we still
   * dispatch the default config so the settings UI renders instead of
   * staying permanently disabled.
   */
  async loadModelConfig(): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    const fallback: PaperPipelineModelConfig = { pipelineModel: '', pdfUrlSuggestModel: '' };
    try {
      const result = await api.getModelConfig();
      store.dispatch(
        setModelConfig(result.success && result.data ? result.data : fallback),
      );
    } catch {
      store.dispatch(setModelConfig(fallback));
    }
  }

  /** Persist the pipeline model config; dispatches the sanitized echo. */
  async saveModelConfig(config: PaperPipelineModelConfig): Promise<void> {
    const api = window.electron?.paperPipeline;
    if (!api) return;
    reportPaperTaskAction('save_model_config', {});
    store.dispatch(setModelConfigSaving(true));
    try {
      const result = await api.setModelConfig(config);
      if (!result.success || !result.data) {
        showToast(result.error ?? i18nService.t('paperTasksModelSaveFailed'));
        return;
      }
      store.dispatch(setModelConfig(result.data));
    } catch {
      showToast(i18nService.t('paperTasksModelSaveFailed'));
    } finally {
      store.dispatch(setModelConfigSaving(false));
    }
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
