import { describe, expect, test } from 'vitest';

import {
  PaperPipelineProcessingStatus,
  PaperPipelineProcessingStatus as Status,
} from '../../../shared/paperPipeline/constants';
import type { PaperTask } from '../../../shared/paperPipeline/types';
import {
  canAutoAdvanceTask,
  getPaperTaskMissingSteps,
  isPaperTaskAdvancedDone,
} from './paperTaskFilters';

function task(partial: Partial<PaperTask>): PaperTask {
  return {
    pmid: '39106599',
    processingStatus: Status.PdfReady,
    ...partial,
  };
}

describe('isPaperTaskAdvancedDone', () => {
  test('hides pdf_ready, completed and pdfReady-flagged tasks', () => {
    expect(isPaperTaskAdvancedDone(task({ processingStatus: Status.PdfReady }))).toBe(true);
    expect(isPaperTaskAdvancedDone(task({ processingStatus: Status.Completed }))).toBe(true);
    expect(isPaperTaskAdvancedDone(task({ processingStatus: Status.Fetched, pdfReady: true }))).toBe(true);
  });

  test('keeps pending and failed tasks visible', () => {
    expect(isPaperTaskAdvancedDone(task({ processingStatus: Status.Categorized }))).toBe(false);
    expect(isPaperTaskAdvancedDone(task({ processingStatus: Status.Failed }))).toBe(false);
  });
});

describe('canAutoAdvanceTask', () => {
  test('allows every non-terminal stage including pdf_ready', () => {
    for (const status of [
      Status.Fetched,
      Status.XmlReady,
      Status.Parsed,
      Status.Analyzed,
      Status.Categorized,
      Status.PdfReady,
    ] as PaperPipelineProcessingStatus[]) {
      expect(canAutoAdvanceTask(task({ processingStatus: status }))).toBe(true);
    }
  });

  test('blocks completed and failed', () => {
    expect(canAutoAdvanceTask(task({ processingStatus: Status.Completed }))).toBe(false);
    expect(canAutoAdvanceTask(task({ processingStatus: Status.Failed }))).toBe(false);
  });
});

describe('getPaperTaskMissingSteps', () => {
  test('flags summary/categories/tags when the stage passed but artifacts are empty', () => {
    // The 2026-09-23 bug shape: pdf_ready, zero tags, zero categories, no summary.
    const result = getPaperTaskMissingSteps(
      task({ extSummaryReady: false, categoryCount: 0, tagCount: 0 }),
    );
    expect(result).toEqual(['extSummary', 'categories', 'tags']);
  });

  test('reports nothing when all artifacts are present', () => {
    const result = getPaperTaskMissingSteps(
      task({ extSummaryReady: true, categoryCount: 2, tagCount: 3 }),
    );
    expect(result).toEqual([]);
  });

  test('does not flag stages the task has not reached yet', () => {
    // A fetched task having no summary/tags is expected, not "missing".
    const result = getPaperTaskMissingSteps(
      task({ processingStatus: Status.Fetched, extSummaryReady: false, categoryCount: 0, tagCount: 0 }),
    );
    expect(result).toEqual([]);
    // Analyzed: categorize step not reached yet — only the summary counts.
    const analyzed = getPaperTaskMissingSteps(
      task({ processingStatus: Status.Analyzed, extSummaryReady: false, categoryCount: 0, tagCount: 0 }),
    );
    expect(analyzed).toEqual(['extSummary']);
  });

  test('shows nothing when the backend predates the fields (undefined)', () => {
    // Same posture as openAccess: undefined = backend predates the flag,
    // show nothing rather than a wrong verdict.
    const result = getPaperTaskMissingSteps(task({}));
    expect(result).toEqual([]);
  });

  test('treats the pdfReady server flag as having passed analyze + categorize', () => {
    // Contract v1.3: pdfReady = status == pdf_ready OR pdf_url non-empty —
    // a divergent status field must not mask missing artifacts.
    const result = getPaperTaskMissingSteps(
      task({ processingStatus: Status.Categorized, pdfReady: true, extSummaryReady: false, tagCount: 0 }),
    );
    expect(result).toEqual(['extSummary', 'tags']);
  });

  test('ignores null values (explicit "backend did not report")', () => {
    const result = getPaperTaskMissingSteps(
      task({ extSummaryReady: null, categoryCount: null, tagCount: null }),
    );
    expect(result).toEqual([]);
  });
});
