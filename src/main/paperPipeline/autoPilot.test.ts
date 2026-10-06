import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  PaperPipelineAdvanceAction,
  PaperPipelineProcessingStatus,
} from '../../shared/paperPipeline/constants';
import type { PaperTask } from '../../shared/paperPipeline/types';
import {
  getPaperAutoPilotStatus,
  type PaperAutoPilotDeps,
  resetPaperAutoPilotForTest,
  startPaperAutoPilotBatch,
} from './autoPilot';

/**
 * Autopilot batch tests. The heavy collaborators (list + advance) are
 * injected, so these drive ONLY the batch orchestration: lit gate, the
 * one-batch lock, per-task error isolation, the pdf_ready stop-node
 * reporting, and the summary text the scheduled-task agent reports.
 */

function buildTask(
  pmid: string,
  status: PaperPipelineProcessingStatus,
  title?: string,
  openAccess?: boolean | null,
): PaperTask {
  return { pmid, processingStatus: status, title: title ?? null, openAccess: openAccess ?? null };
}

function buildDeps(overrides?: {
  tasks?: PaperTask[];
  advance?: (pmid: string, status: PaperPipelineProcessingStatus) => Promise<{ toStatus: PaperPipelineProcessingStatus; action: PaperPipelineAdvanceAction }>;
  isLitAuthSession?: () => boolean;
}): { deps: PaperAutoPilotDeps; listMock: ReturnType<typeof vi.fn>; advanceMock: ReturnType<typeof vi.fn> } {
  const listMock = vi.fn(async () => overrides?.tasks ?? []);
  const advanceMock = vi.fn(
    overrides?.advance ??
      (async () => ({
        // Mirror the real service: the full one-click run ends at the
        // GenerateWechatDoc stop node with the task still at pdf_ready.
        toStatus: PaperPipelineProcessingStatus.PdfReady,
        action: PaperPipelineAdvanceAction.GenerateWechatDoc,
      })),
  );
  const deps: PaperAutoPilotDeps = {
    listPendingTasks: listMock,
    advanceTaskAuto: advanceMock,
    isLitAuthSession: overrides?.isLitAuthSession ?? (() => true),
  };
  return { deps, listMock, advanceMock };
}

describe('startPaperAutoPilotBatch', () => {
  beforeEach(() => {
    resetPaperAutoPilotForTest();
  });

  test('refuses to run when the lit session is not active', async () => {
    const { deps, listMock } = buildDeps({
      tasks: [buildTask('1', PaperPipelineProcessingStatus.XmlReady)],
      isLitAuthSession: () => false,
    });

    const result = await startPaperAutoPilotBatch(deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lit_not_logged_in');
    expect(listMock).not.toHaveBeenCalled();
  });

  test('advances every advanceable task, skips pdf_ready + terminal, reports docUrl pending', async () => {
    const { deps, advanceMock } = buildDeps({
      tasks: [
        buildTask('111', PaperPipelineProcessingStatus.XmlReady, 'LNP paper', true),
        buildTask('222', PaperPipelineProcessingStatus.Categorized, 'mRNA paper', false),
        buildTask('333', PaperPipelineProcessingStatus.PdfReady, 'awaiting paste'),
        buildTask('444', PaperPipelineProcessingStatus.Completed),
        buildTask('555', PaperPipelineProcessingStatus.Failed),
      ],
    });

    const start = await startPaperAutoPilotBatch(deps);
    expect(start.ok).toBe(true);
    expect(start.reason).toBe('started');
    expect(start.total).toBe(2);
    expect(start.skippedCount).toBe(3);
    await start.done;

    expect(advanceMock).toHaveBeenCalledTimes(2);
    // The contract v1.3 openAccess flag rides along so the closed-access
    // short-circuit works in batch mode too — passed as the 3rd argument.
    expect(advanceMock).toHaveBeenCalledWith(
      '111',
      PaperPipelineProcessingStatus.XmlReady,
      true,
      null,
    );
    expect(advanceMock).toHaveBeenCalledWith(
      '222',
      PaperPipelineProcessingStatus.Categorized,
      false,
      null,
    );

    const status = getPaperAutoPilotStatus();
    expect(status?.running).toBe(false);
    expect(status?.results).toHaveLength(2);
    expect(status?.results.every(r => r.awaitingDocUrl)).toBe(true);
    // pdf_ready shows up as skipped with the docUrl reason, not re-advanced.
    const pdfReadySkip = status?.skipped.find(s => s.pmid === '333');
    expect(pdfReadySkip?.reason).toContain('docUrl');
    expect(status?.summary).toContain('成功 2 篇');
    expect(status?.summary).toContain('111');
    expect(status?.summary).toContain('待粘贴 docUrl');
  });

  test('a single task failure does not abort the batch', async () => {
    const { deps } = buildDeps({
      tasks: [
        buildTask('111', PaperPipelineProcessingStatus.Parsed),
        buildTask('222', PaperPipelineProcessingStatus.Analyzed),
      ],
      advance: async (pmid: string) => {
        if (pmid === '111') {
          throw new Error('All PDF strategies exhausted for PMID 111');
        }
        return {
          toStatus: PaperPipelineProcessingStatus.PdfReady,
          action: PaperPipelineAdvanceAction.GenerateWechatDoc,
        };
      },
    });

    const start = await startPaperAutoPilotBatch(deps);
    await start.done;

    const status = getPaperAutoPilotStatus();
    expect(status?.results).toHaveLength(2);
    expect(status?.results[0].error).toContain('All PDF strategies exhausted');
    expect(status?.results[1].error).toBeNull();
    expect(status?.summary).toContain('失败 1 篇');
    expect(status?.summary).toContain('成功 1 篇');
  });

  test('a running batch rejects double-starts and returns the same jobId', async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const { deps } = buildDeps({
      tasks: [buildTask('111', PaperPipelineProcessingStatus.XmlReady)],
      advance: async () => {
        await gate;
        return {
          toStatus: PaperPipelineProcessingStatus.PdfReady,
          action: PaperPipelineAdvanceAction.GenerateWechatDoc,
        };
      },
    });

    const first = await startPaperAutoPilotBatch(deps);
    expect(first.reason).toBe('started');

    const second = await startPaperAutoPilotBatch(deps);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('already_running');
    expect(second.jobId).toBe(first.jobId);

    // Progress is visible mid-run.
    const midStatus = getPaperAutoPilotStatus();
    expect(midStatus?.running).toBe(true);
    expect(midStatus?.currentPmid).toBe('111');

    releaseFirst();
    await first.done;
    expect(getPaperAutoPilotStatus()?.running).toBe(false);
  });

  test('reports nothing_to_do when every task is at a stop node', async () => {
    const { deps, advanceMock } = buildDeps({
      tasks: [buildTask('333', PaperPipelineProcessingStatus.PdfReady)],
    });

    const start = await startPaperAutoPilotBatch(deps);
    await start.done;

    expect(start.reason).toBe('nothing_to_do');
    expect(start.message).toContain('没有可推进的任务');
    expect(advanceMock).not.toHaveBeenCalled();
    const status = getPaperAutoPilotStatus();
    expect(status?.summary).toContain('跳过 1 篇');
    expect(status?.summary).toContain('333');
  });

  test('listPendingTasks failure surfaces as list_failed', async () => {
    const { deps } = buildDeps({ tasks: [] });
    deps.listPendingTasks = vi.fn(async () => {
      throw new Error('lit 502');
    });

    const result = await startPaperAutoPilotBatch(deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('list_failed');
    expect(result.message).toContain('lit 502');
  });

  test('status by jobId returns null for unknown ids', async () => {
    const { deps } = buildDeps({ tasks: [] });
    await startPaperAutoPilotBatch(deps);
    expect(getPaperAutoPilotStatus('nope')).toBeNull();
  });
});
