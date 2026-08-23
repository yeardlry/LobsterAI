import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import {
  PaperPipelineProcessingStatus,
} from '../../../shared/paperPipeline/constants';
import type {
  PaperTask,
  PaperTaskLogEntry,
  PaperTaskStatusChangedEvent,
} from '../../../shared/paperPipeline/types';

/**
 * Coarse lifecycle for the renderer-side list. Mirrors the scheduled-tasks
 * pattern: explicit status transitions driven by the service so the UI can
 * render skeletons, errors, and the populated card grid distinctly.
 */
export const PaperTasksDataStatus = {
  Starting: 'starting',
  Loading: 'loading',
  Ready: 'ready',
  Error: 'error',
} as const;
export type PaperTasksDataStatus = typeof PaperTasksDataStatus[keyof typeof PaperTasksDataStatus];

export interface WechatDraft {
  /** Local Markdown file path on disk; renderer can show a preview from this. */
  localPath: string;
  /** Public URL for the draft (currently a file:// URL stub; Phase 4 will be an OSS URL). */
  publicUrl: string;
  title: string;
  summary: string;
  /** True after the user submits the docUrl and flips status to `completed`. */
  submitted: boolean;
}

export interface PaperTasksState {
  tasks: PaperTask[];
  /** Per-task in-flight status (pmid → action in progress). */
  advancingPmid: string | null;
  listStatus: PaperTasksDataStatus;
  listError: string | null;
  /** Per-task execution log buffer; cleared when a task disappears from `tasks`. */
  logs: Record<string, PaperTaskLogEntry[]>;
  /** True when the lit session is not active. */
  disabled: boolean;
  /**
   * Per-task WeChat article draft produced when the orchestrator runs the
   * `generateWechatDoc` step. Cleared when the task moves to `completed` /
   * `failed` or disappears from the list. The UI pops a modal when this
   * shows up and asks the user to paste the docUrl they got from
   * 微信公众平台.
   */
  wechatDrafts: Record<string, WechatDraft>;
  /** Pmid whose draft modal should be open (or null when no modal). */
  activeWechatDraftPmid: string | null;
  /** True while `submitWechatDoc` IPC is in flight. */
  submittingWechatPmid: string | null;
}

const initialState: PaperTasksState = {
  tasks: [],
  advancingPmid: null,
  listStatus: PaperTasksDataStatus.Starting,
  listError: null,
  logs: {},
  disabled: false,
  wechatDrafts: {},
  activeWechatDraftPmid: null,
  submittingWechatPmid: null,
};

const paperTasksSlice = createSlice({
  name: 'paperTasks',
  initialState,
  reducers: {
    setListStatus(state, action: PayloadAction<PaperTasksDataStatus>) {
      state.listStatus = action.payload;
      if (action.payload !== PaperTasksDataStatus.Error) {
        state.listError = null;
      }
    },
    setListError(state, action: PayloadAction<string | null>) {
      state.listError = action.payload;
      if (action.payload) state.listStatus = PaperTasksDataStatus.Error;
    },
    setDisabled(state, action: PayloadAction<boolean>) {
      state.disabled = action.payload;
      if (action.payload) {
        state.tasks = [];
        state.logs = {};
        state.advancingPmid = null;
        state.wechatDrafts = {};
        state.activeWechatDraftPmid = null;
        state.submittingWechatPmid = null;
      }
    },
    setTasks(state, action: PayloadAction<PaperTask[]>) {
      state.tasks = action.payload;
      // Drop log buffers for tasks no longer in the list.
      const keep = new Set(action.payload.map(t => t.pmid));
      for (const key of Object.keys(state.logs)) {
        if (!keep.has(key)) delete state.logs[key];
      }
      for (const key of Object.keys(state.wechatDrafts)) {
        if (!keep.has(key)) delete state.wechatDrafts[key];
      }
      if (state.activeWechatDraftPmid && !keep.has(state.activeWechatDraftPmid)) {
        state.activeWechatDraftPmid = null;
      }
    },
    upsertTask(state, action: PayloadAction<PaperTask>) {
      const idx = state.tasks.findIndex(t => t.pmid === action.payload.pmid);
      if (idx >= 0) state.tasks[idx] = action.payload;
      else state.tasks.push(action.payload);
    },
    setAdvancingPmid(state, action: PayloadAction<string | null>) {
      state.advancingPmid = action.payload;
    },
    appendLogEntry(state, action: PayloadAction<PaperTaskLogEntry>) {
      const buffer = state.logs[action.payload.pmid] ?? [];
      buffer.push(action.payload);
      // Keep at most 200 entries per task in memory.
      if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
      state.logs[action.payload.pmid] = buffer;
    },
    /**
     * Apply a status-change push from main. The server is authoritative on
     * `processingStatus`, so we overwrite the local status (and optional
     * `errorMessage`) without re-fetching the whole list.
     */
    applyStatusChange(state, action: PayloadAction<PaperTaskStatusChangedEvent>) {
      const { pmid, toStatus, errorMessage } = action.payload;
      const idx = state.tasks.findIndex(t => t.pmid === pmid);
      if (idx >= 0) {
        state.tasks[idx] = {
          ...state.tasks[idx],
          status: toStatus,
          errorMessage: errorMessage ?? state.tasks[idx].errorMessage ?? null,
        };
      }
      // Draft lifecycle: once the task moves past `pdf_ready` (either the
      // user submitted the docUrl → `completed`, or the orchestrator moved
      // to `failed`), we drop the draft + close the modal.
      if (
        toStatus !== PaperPipelineProcessingStatus.PdfReady &&
        state.wechatDrafts[pmid]
      ) {
        delete state.wechatDrafts[pmid];
        if (state.activeWechatDraftPmid === pmid) {
          state.activeWechatDraftPmid = null;
        }
        state.submittingWechatPmid = null;
      }
    },
    clearTaskLog(state, action: PayloadAction<string>) {
      delete state.logs[action.payload];
    },
    /**
     * Record a freshly-rendered WeChat draft produced by the orchestrator.
     * Opens the modal so the user can paste the docUrl back.
     */
    setWechatDraft(
      state,
      action: PayloadAction<{ pmid: string; draft: WechatDraft }>,
    ) {
      state.wechatDrafts[action.payload.pmid] = action.payload.draft;
      state.activeWechatDraftPmid = action.payload.pmid;
    },
    closeWechatDraftModal(state) {
      state.activeWechatDraftPmid = null;
      state.submittingWechatPmid = null;
    },
    setSubmittingWechatPmid(state, action: PayloadAction<string | null>) {
      state.submittingWechatPmid = action.payload;
    },
  },
});

export const {
  setListStatus,
  setListError,
  setDisabled,
  setTasks,
  upsertTask,
  setAdvancingPmid,
  appendLogEntry,
  applyStatusChange,
  clearTaskLog,
  setWechatDraft,
  closeWechatDraftModal,
  setSubmittingWechatPmid,
} = paperTasksSlice.actions;

export { paperTasksSlice };
export default paperTasksSlice.reducer;

/**
 * Convenience helper for selectors. Re-exported so the component tree can
 * reach the status enum without importing from `shared/`.
 */
export { PaperPipelineProcessingStatus };