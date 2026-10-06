import { randomUUID } from 'node:crypto';

import {
  PaperPipelineAdvanceAction,
  PaperPipelineProcessingStatus,
} from '../../shared/paperPipeline/constants';
import type { PaperTask, PaperTaskAdvanceResult } from '../../shared/paperPipeline/types';
import type { PaperPipelineBridgeHandlers } from '../libs/mcpBridgeServer';
import type { PaperPipelineService } from './paperPipelineService';

/**
 * Paper-pipeline autopilot — batch "refresh + one-click advance" for the
 * scheduled-task bridge.
 *
 * A scheduled task is just an agent prompt in an isolated session, so the
 * agent needs tools to drive the pipeline. This module owns the native
 * batch orchestration those tools delegate to:
 *
 *   1. `listPendingTasks()` — refresh the todo list from the lit backend.
 *   2. For every advanceable task, run `advanceTaskAuto()` sequentially
 *      (the same one-click advance the renderer button triggers) through
 *      the stop node: word document uploaded, waiting for the user to
 *      paste the WeChat docUrl.
 *
 * Design constraints:
 *   - Two-phase on purpose: a batch over several papers can easily run
 *     10+ minutes (PDF downloads alone are capped at 300s each), which
 *     would blow through any single MCP tool-call timeout. `start` kicks
 *     the batch off in the background and returns immediately; `status`
 *     reports progress so the agent can poll and then report the summary.
 *   - One batch at a time (lock): concurrent batches would race the
 *     per-pmid hidden session pool and the renderer's manual clicks.
 *   - Single-task failures do not abort the batch — each advance is
 *     isolated in try/catch and the failure is recorded per pmid.
 *   - `pdf_ready` tasks are NOT re-advanced: the word document is already
 *     uploaded and the only remaining step is the user pasting the docUrl
 *     (the deliberate stop node). Re-running GenerateWechatDoc daily would
 *     re-convert and re-upload the docx for nothing.
 */

/**
 * Statuses the autopilot will advance. `pdf_ready` is excluded on purpose
 * (see module doc); `completed` / `failed` are terminal.
 */
const AUTO_PILOT_ADVANCEABLE_STATUSES: ReadonlySet<PaperPipelineProcessingStatus> = new Set([
  PaperPipelineProcessingStatus.Fetched,
  PaperPipelineProcessingStatus.XmlReady,
  PaperPipelineProcessingStatus.Parsed,
  PaperPipelineProcessingStatus.Analyzed,
  PaperPipelineProcessingStatus.Categorized,
]);

export interface PaperAutoPilotDeps {
  listPendingTasks: () => Promise<PaperTask[]>;
  advanceTaskAuto: (
    pmid: string,
    currentStatus: PaperPipelineProcessingStatus,
    /** Contract v1.3 `openAccess` from the task list; null = unknown. */
    openAccess: boolean | null,
    /** Full PDF URL from the task list, when available. */
    pdfUrl?: string | null,
  ) => Promise<Pick<PaperTaskAdvanceResult, 'toStatus' | 'action'>>;
  /** Gate: the lit token must be live before any backend call is made. */
  isLitAuthSession: () => boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface PaperAutoPilotTaskResult {
  pmid: string;
  title: string | null;
  fromStatus: PaperPipelineProcessingStatus;
  toStatus: PaperPipelineProcessingStatus | null;
  /** True when the run reached the stop node: word uploaded, docUrl pending. */
  awaitingDocUrl: boolean;
  error: string | null;
}

export interface PaperAutoPilotSkippedTask {
  pmid: string;
  title: string | null;
  status: PaperPipelineProcessingStatus;
  reason: string;
}

export interface PaperAutoPilotRunState {
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  /** Advanceable tasks picked up by this run. */
  total: number;
  currentIndex: number;
  /** PMID currently being advanced, null when idle/finished. */
  currentPmid: string | null;
  results: PaperAutoPilotTaskResult[];
  skipped: PaperAutoPilotSkippedTask[];
  summary: string;
}

export interface PaperAutoPilotStartResult {
  ok: boolean;
  reason: 'started' | 'already_running' | 'lit_not_logged_in' | 'list_failed' | 'nothing_to_do';
  message: string;
  jobId: string | null;
  total: number;
  skippedCount: number;
  /** Resolves when the batch finishes. Never serialized over the bridge. */
  done?: Promise<void>;
}

let activeRun: PaperAutoPilotRunState | null = null;
let lastFinishedRun: PaperAutoPilotRunState | null = null;

/** Test seam: reset module state between tests. */
export function resetPaperAutoPilotForTest(): void {
  activeRun = null;
  lastFinishedRun = null;
}

/**
 * Kick off a batch run in the background. Returns immediately with the
 * initial snapshot. When a batch is already running the same job is
 * returned (`already_running`) instead of double-starting.
 */
export async function startPaperAutoPilotBatch(
  deps: PaperAutoPilotDeps,
): Promise<PaperAutoPilotStartResult> {
  const log = deps.log ?? defaultLog;

  if (!deps.isLitAuthSession()) {
    return {
      ok: false,
      reason: 'lit_not_logged_in',
      message: '当前会话未登录 lit（文献后台），无法自动推进。请先在 LobsterAI 登录 lit 账号。',
      jobId: null,
      total: 0,
      skippedCount: 0,
    };
  }

  if (activeRun?.running) {
    return {
      ok: true,
      reason: 'already_running',
      message: `已有批次在运行（jobId=${activeRun.jobId}），本次不会重复启动。请用 status 查询进度。`,
      jobId: activeRun.jobId,
      total: activeRun.total,
      skippedCount: activeRun.skipped.length,
    };
  }

  let tasks: PaperTask[];
  try {
    tasks = await deps.listPendingTasks();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    log('error', `autopilot listPendingTasks failed: ${message}`);
    return {
      ok: false,
      reason: 'list_failed',
      message: `刷新待办列表失败：${message}`,
      jobId: null,
      total: 0,
      skippedCount: 0,
    };
  }

  const advanceable: PaperTask[] = [];
  const skipped: PaperAutoPilotSkippedTask[] = [];
  for (const task of tasks) {
    if (AUTO_PILOT_ADVANCEABLE_STATUSES.has(task.processingStatus)) {
      advanceable.push(task);
    } else if (task.processingStatus === PaperPipelineProcessingStatus.PdfReady) {
      skipped.push({
        pmid: task.pmid,
        title: task.title ?? null,
        status: task.processingStatus,
        reason: 'word 已上传，等待用户粘贴公众号 docUrl',
      });
    } else {
      skipped.push({
        pmid: task.pmid,
        title: task.title ?? null,
        status: task.processingStatus,
        reason: '终态（completed/failed），自动推进不处理',
      });
    }
  }

  const state: PaperAutoPilotRunState = {
    jobId: randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    total: advanceable.length,
    currentIndex: 0,
    currentPmid: null,
    results: [],
    skipped,
    summary: '',
  };
  activeRun = state;

  if (advanceable.length === 0) {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.summary = buildSummary(state);
    lastFinishedRun = state;
    log('info', `autopilot: nothing to advance (${skipped.length} skipped)`);
    return {
      ok: true,
      reason: 'nothing_to_do',
      message: `当前没有可推进的任务。${skipped.length > 0 ? `${skipped.length} 个任务被跳过（详见 status）。` : ''}`,
      jobId: state.jobId,
      total: 0,
      skippedCount: skipped.length,
      done: Promise.resolve(),
    };
  }

  log('info', `autopilot: starting batch ${state.jobId} with ${advanceable.length} task(s), ${skipped.length} skipped`);

  const done = runBatch(state, advanceable, deps);
  return {
    ok: true,
    reason: 'started',
    message: `批次已启动（jobId=${state.jobId}）：${advanceable.length} 篇待推进，${skipped.length} 个跳过。请轮询 status 直到 running=false。`,
    jobId: state.jobId,
    total: advanceable.length,
    skippedCount: skipped.length,
    done,
  };
}

async function runBatch(
  state: PaperAutoPilotRunState,
  tasks: PaperTask[],
  deps: PaperAutoPilotDeps,
): Promise<void> {
  const log = deps.log ?? defaultLog;
  try {
    for (const task of tasks) {
      state.currentIndex += 1;
      state.currentPmid = task.pmid;
      const result: PaperAutoPilotTaskResult = {
        pmid: task.pmid,
        title: task.title ?? null,
        fromStatus: task.processingStatus,
        toStatus: null,
        awaitingDocUrl: false,
        error: null,
      };
      try {
        log('info', `autopilot: advancing ${task.pmid} from ${task.processingStatus}`);
        const advance = await deps.advanceTaskAuto(
          task.pmid,
          task.processingStatus,
          task.openAccess ?? null,
          task.pdfUrl ?? null,
        );
        result.toStatus = advance.toStatus;
        result.awaitingDocUrl = advance.action === PaperPipelineAdvanceAction.GenerateWechatDoc;
        log(
          'info',
          `autopilot: ${task.pmid} advanced to ${advance.toStatus}${result.awaitingDocUrl ? ' (word uploaded, awaiting docUrl)' : ''}`,
        );
      } catch (err) {
        result.error = err instanceof Error ? err.message : 'unknown';
        // `advanceTask` already reported the failure to the backend and
        // emitted the status push; record it and keep the batch going.
        log('error', `autopilot: ${task.pmid} failed: ${result.error}`);
      }
      state.results.push(result);
    }
  } finally {
    state.running = false;
    state.currentPmid = null;
    state.finishedAt = new Date().toISOString();
    state.summary = buildSummary(state);
    lastFinishedRun = state;
    log('info', `autopilot: batch ${state.jobId} finished — ${state.summary.split('\n')[0]}`);
  }
}

/**
 * Current (or, when idle, the most recent finished) batch state. Returns
 * null when no batch has ever run.
 */
export function getPaperAutoPilotStatus(jobId?: string): PaperAutoPilotRunState | null {
  if (jobId) {
    if (activeRun?.jobId === jobId) return snapshotRun(activeRun);
    if (lastFinishedRun?.jobId === jobId) return snapshotRun(lastFinishedRun);
    return null;
  }
  const run = activeRun ?? lastFinishedRun;
  return run ? snapshotRun(run) : null;
}

function snapshotRun(state: PaperAutoPilotRunState): PaperAutoPilotRunState {
  // Shallow copy is enough — the arrays are only appended to, and callers
  // receive the run either live (activeRun) or frozen (lastFinishedRun).
  return { ...state, results: [...state.results], skipped: [...state.skipped] };
}

/** Human-readable Chinese summary for the agent's report. */
function buildSummary(state: PaperAutoPilotRunState): string {
  const succeeded = state.results.filter(r => r.error === null);
  const failed = state.results.filter(r => r.error !== null);
  const awaiting = succeeded.filter(r => r.awaitingDocUrl);
  const lines: string[] = [
    `自动推进${state.running ? '进行中' : '完成'}：待推进 ${state.total} 篇，` +
      `成功 ${succeeded.length} 篇（其中 ${awaiting.length} 篇已生成 word、待用户粘贴公众号 docUrl），` +
      `失败 ${failed.length} 篇，跳过 ${state.skipped.length} 篇。`,
  ];
  if (state.running && state.currentPmid) {
    lines.push(`正在处理：PMID ${state.currentPmid}（第 ${state.currentIndex}/${state.total} 篇）。`);
  }
  if (awaiting.length > 0) {
    lines.push(
      '待粘贴 docUrl：\n' +
        awaiting
          .map(r => `- PMID ${r.pmid}${r.title ? `《${r.title}》` : ''}`)
          .join('\n'),
    );
  }
  if (failed.length > 0) {
    lines.push(
      '失败：\n' +
        failed.map(r => `- PMID ${r.pmid}：${r.error}`).join('\n'),
    );
  }
  const pdfReadySkipped = state.skipped.filter(
    s => s.status === PaperPipelineProcessingStatus.PdfReady,
  );
  if (pdfReadySkipped.length > 0) {
    lines.push(
      `本次跳过且此前已在等 docUrl 的任务：${pdfReadySkipped.map(s => s.pmid).join('、')}。`,
    );
  }
  return lines.join('\n');
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  const tag = `[PaperAutoPilot] ${message}`;
  if (level === 'error') console.error(tag);
  else if (level === 'warn') console.warn(tag);
  else console.log(tag);
}

/**
 * Build the bridge handlers the `lobsterai-paper` MCP server calls. Wired
 * by `McpRuntime` (which already holds `isLitAuthSession`); returns null
 * upstream when the service manager has not initialized yet.
 */
export function buildPaperPipelineBridgeHandlers(deps: {
  isLitAuthSession: () => boolean;
  service: PaperPipelineService;
}): PaperPipelineBridgeHandlers {
  const autoPilotDeps = (): PaperAutoPilotDeps => ({
    listPendingTasks: async () => {
      // The lit backend now returns a paginated envelope; the autopilot only
      // needs the items (it advances everything it gets). Default to the
      // largest stable page so a single batch can drain a meaningful slice.
      const page = await deps.service.listPendingTasks({ page: 1, pageSize: 50 });
      return page.items;
    },
    advanceTaskAuto: (pmid, currentStatus, openAccess, pdfUrl) =>
      deps.service.advanceTaskAuto(pmid, currentStatus, undefined, { openAccess, pdfUrl }),
    isLitAuthSession: deps.isLitAuthSession,
  });
  return {
    listPendingTasks: async () => deps.service.listPendingTasks(),
    // Strip `done` (a Promise, meaningless once serialized) before the
    // bridge JSON-encodes the result for the MCP tool reply.
    startAutopilot: async () => {
      const { done: _done, ...rest } = await startPaperAutoPilotBatch(autoPilotDeps());
      return rest;
    },
    autopilotStatus: async (jobId?: string) => getPaperAutoPilotStatus(jobId),
  };
}
