import React from 'react';

import { PaperPipelineProcessingStatus } from '../../../shared/paperPipeline/constants';
import type { PaperTask } from '../../../shared/paperPipeline/types';
import { i18nService } from '../../services/i18n';
import { paperTasksService } from '../../services/paperTasks';
import { canAutoAdvanceTask, getPaperTaskMissingSteps } from './paperTaskFilters';
import PaperTaskStatusChip from './PaperTaskStatusChip';

interface PaperTaskCardProps {
  task: PaperTask;
  /** True while an `advanceTask` IPC is in flight for this card. */
  busy: boolean;
  onSelect: (pmid: string) => void;
}

/**
 * Single paper-task card. Shows pmid, optional title, status chip, and the
 * appropriate action button for the current status. Failed tasks also show
 * a "Reset" button that calls `resetTask` (which routes to
 * `reportTaskFailure({markAsFailed:false, resetTo:'xml_ready'})`).
 */
const PaperTaskCard: React.FC<PaperTaskCardProps> = ({ task, busy, onSelect }) => {
  const isFailed = task.processingStatus === PaperPipelineProcessingStatus.Failed;
  const isCompleted = task.processingStatus === PaperPipelineProcessingStatus.Completed;
  // Contract v1.6 artifact signals: stages the task passed but whose
  // server-side artifacts are empty (e.g. pdf_ready with zero tags).
  const missingSteps = getPaperTaskMissingSteps(task);
  const missingStepLabel: Record<string, string> = {
    extSummary: i18nService.t('paperTasksMissingSummary'),
    categories: i18nService.t('paperTasksMissingCategories'),
    tags: i18nService.t('paperTasksMissingTags'),
  };
  // User decision 2026-09-23: EVERY non-terminal stage can be (re-)driven —
  // including `pdf_ready` / `pdfReady === true`, which re-runs the WeChat
  // draft + word export. Stages occasionally finish with missing artifacts
  // (no tags, no draft) and the user needs to re-execute. Only `completed`
  // (nothing left to drive) and `failed` (reset first) are excluded.
  const actionAvailable = canAutoAdvanceTask(task);
  // The advance button still RENDERS for a failed task (disabled, next to
  // Reset) so the layout doesn't jump; `completed` hides it entirely.
  const showAdvanceButton = !isCompleted;
  const canAdvance = actionAvailable && !busy;

  const handleAdvance = async (): Promise<void> => {
    await paperTasksService.advanceTaskAuto(
      task.pmid,
      task.processingStatus,
      task.openAccess ?? null,
      task.pdfUrl ?? null,
    );
  };
  const handleCancel = async (): Promise<void> => {
    await paperTasksService.cancelTaskAuto(task.pmid);
  };
  const handleReset = async (): Promise<void> => {
    await paperTasksService.resetTask(task.pmid);
  };
  const handleMarkFailed = async (): Promise<void> => {
    await paperTasksService.reportFailure(task.pmid, 'Manually marked failed from UI');
  };

  // The card is a clickable "select this task" surface that CONTAINS action
  // buttons, so it cannot be a real <button> — nested buttons are invalid
  // HTML and React warns about it. A div with role="button" + keyboard
  // handling keeps the same semantics.
  const handleSelectKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(task.pmid);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(task.pmid)}
      onKeyDown={handleSelectKey}
      className="group block w-full cursor-pointer rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-primary/40 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-muted">PMID {task.pmid}</div>
          {task.title && (
            <div className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
              {task.title}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Contract v1.3: null/undefined = backend predates the flag —
              show nothing rather than a wrong verdict. */}
          {(task.openAccess === true || task.openAccess === false) && (
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                task.openAccess
                  ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200'
                  : 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200'
              }`}
            >
              {i18nService.t(
                task.openAccess ? 'paperTasksAccessPublic' : 'paperTasksAccessClosed',
              )}
            </span>
          )}
          <PaperTaskStatusChip status={task.processingStatus} />
        </div>
      </div>

      {task.errorMessage && (
        <div className="mt-3 line-clamp-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300">
          {task.errorMessage}
        </div>
      )}

      {missingSteps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {i18nService.t('paperTasksMissingStepsLabel')}
          </span>
          {missingSteps.map(step => (
            <span
              key={step}
              className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {missingStepLabel[step]}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2" onClick={event => event.stopPropagation()}>
        {isFailed && (
          <button
            type="button"
            disabled={busy}
            onClick={handleReset}
            className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {i18nService.t('paperTasksReset')}
          </button>
        )}
        {actionAvailable && (
          <button
            type="button"
            disabled={!canAdvance}
            onClick={handleMarkFailed}
            className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {i18nService.t('paperTasksMarkFailed')}
          </button>
        )}
        {showAdvanceButton && (
          task.processingStatus === PaperPipelineProcessingStatus.PdfReady && !busy && (
            <button
              type="button"
              disabled={!canAdvance}
              onClick={handleAdvance}
              className="h-8 rounded-lg border border-primary/30 bg-primary/5 px-3 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
            >
              {i18nService.t('paperTasksRegenerateWechat')}
            </button>
          )
        )}
        {showAdvanceButton && (
          <button
            type="button"
            disabled={busy ? false : !canAdvance}
            onClick={busy ? handleCancel : handleAdvance}
            title={
              task.processingStatus === PaperPipelineProcessingStatus.PdfReady
                ? i18nService.t('paperTasksAdvanceRedoHint')
                : undefined
            }
            className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? i18nService.t('paperTasksCancelAdvance') : i18nService.t('paperTasksAdvanceAuto')}
          </button>
        )}
      </div>
    </div>
  );
};

export default PaperTaskCard;
