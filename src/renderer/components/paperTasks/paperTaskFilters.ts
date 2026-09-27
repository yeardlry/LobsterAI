import { PaperPipelineProcessingStatus } from '../../../shared/paperPipeline/constants';
import type { PaperTask } from '../../../shared/paperPipeline/types';

/**
 * Whether the one-click advance chain has finished for a task. Covers:
 *   - `pdf_ready` (the stop node: file uploaded, awaiting the user's WeChat
 *     docUrl paste);
 *   - `completed` (terminal success: user submitted the docUrl);
 *   - `pdfReady === true` (contract v1.3 server flag for "PDF full text has
 *     been uploaded", a different label for the same state — included for
 *     cases where the status field has diverged).
 *
 * `failed` is intentionally NOT in here — failures must stay visible so
 * the user can act on them.
 *
 * View-side filter ONLY (hides these cards by default). The card's action
 * buttons gate on {@link canAutoAdvanceTask} instead — since 2026-09-23 a
 * finished-looking task may still be re-driven (missing tags / draft).
 */
export function isPaperTaskAdvancedDone(task: PaperTask): boolean {
  if (task.processingStatus === PaperPipelineProcessingStatus.PdfReady) return true;
  if (task.processingStatus === PaperPipelineProcessingStatus.Completed) return true;
  if (task.pdfReady === true) return true;
  return false;
}

/**
 * Whether the one-click advance button should be actionable for a task.
 *
 * User decision 2026-09-23: stages occasionally finish with missing
 * artifacts (no tags, no WeChat draft) and the remaining steps must be
 * re-drivable — so EVERY non-terminal stage allows one-click advance,
 * including `pdf_ready` / `pdfReady === true` (re-runs the WeChat draft +
 * word export; the task stays at `pdf_ready` awaiting the docUrl). Only
 * two statuses are excluded:
 *   - `completed`: the docUrl is submitted; the backend has no further
 *     transition to drive;
 *   - `failed`: use Reset first (which returns the task to `xml_ready`).
 */
export function canAutoAdvanceTask(task: PaperTask): boolean {
  if (task.processingStatus === PaperPipelineProcessingStatus.Completed) return false;
  if (task.processingStatus === PaperPipelineProcessingStatus.Failed) return false;
  return true;
}

/**
 * Steps whose stage the task has already passed but whose artifact on the
 * server is empty — the "unfinished intermediate steps" the status chip
 * cannot express (e.g. `pdf_ready` with zero tags, the 2026-09-23 bug).
 *
 * Signals come from contract v1.6 (2026-09-24) listPendingTasks items
 * (`extSummaryReady` / `categoryCount` / `tagCount`). `undefined` means the
 * backend predates the field — show nothing rather than a wrong verdict
 * (same posture as `openAccess`).
 */
export type PaperTaskMissingStep = 'extSummary' | 'categories' | 'tags';

export function getPaperTaskMissingSteps(task: PaperTask): PaperTaskMissingStep[] {
  const steps: PaperTaskMissingStep[] = [];
  // Stage ordering: analyze covers `analyzed` onwards; categorize covers
  // `categorized` onwards. `pdfReady === true` (server flag) also implies
  // both stages passed.
  const passedAnalyze = hasReachedStatus(task, PaperPipelineProcessingStatus.Analyzed) || task.pdfReady === true;
  const passedCategorize =
    hasReachedStatus(task, PaperPipelineProcessingStatus.Categorized) || task.pdfReady === true;

  if (passedAnalyze && task.extSummaryReady === false) steps.push('extSummary');
  if (passedCategorize && task.categoryCount === 0) steps.push('categories');
  if (passedCategorize && task.tagCount === 0) steps.push('tags');
  return steps;
}

/** Whether `task.processingStatus` has reached or passed `status` in the pipeline order. */
function hasReachedStatus(task: PaperTask, status: PaperPipelineProcessingStatus): boolean {
  const order: PaperPipelineProcessingStatus[] = [
    PaperPipelineProcessingStatus.Fetched,
    PaperPipelineProcessingStatus.XmlReady,
    PaperPipelineProcessingStatus.Parsed,
    PaperPipelineProcessingStatus.Analyzed,
    PaperPipelineProcessingStatus.Categorized,
    PaperPipelineProcessingStatus.PdfReady,
    PaperPipelineProcessingStatus.Completed,
  ];
  const current = order.indexOf(task.processingStatus);
  const target = order.indexOf(status);
  if (current === -1 || target === -1) return false;
  return current >= target;
}
