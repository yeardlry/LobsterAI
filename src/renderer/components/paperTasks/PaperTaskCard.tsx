import React from 'react';

import { PaperPipelineProcessingStatus } from '../../../shared/paperPipeline/constants';
import type { PaperTask } from '../../../shared/paperPipeline/types';
import { i18nService } from '../../services/i18n';
import { paperTasksService } from '../../services/paperTasks';
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
  const isFailed = task.status === PaperPipelineProcessingStatus.Failed;
  const isTerminal = task.status === PaperPipelineProcessingStatus.Completed;
  const canAdvance = !isTerminal && !isFailed && !busy;

  const handleAdvance = async (): Promise<void> => {
    await paperTasksService.advanceTask(task.pmid, task.status);
  };
  const handleReset = async (): Promise<void> => {
    await paperTasksService.resetTask(task.pmid);
  };
  const handleMarkFailed = async (): Promise<void> => {
    await paperTasksService.reportFailure(task.pmid, 'Manually marked failed from UI');
  };

  return (
    <button
      type="button"
      onClick={() => onSelect(task.pmid)}
      className="group block w-full rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-primary/40 hover:bg-surface-hover"
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
        <PaperTaskStatusChip status={task.status} />
      </div>

      {task.errorMessage && (
        <div className="mt-3 line-clamp-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300">
          {task.errorMessage}
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
        {!isTerminal && !isFailed && (
          <button
            type="button"
            disabled={!canAdvance}
            onClick={handleMarkFailed}
            className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {i18nService.t('paperTasksMarkFailed')}
          </button>
        )}
        {!isTerminal && (
          <button
            type="button"
            disabled={!canAdvance}
            onClick={handleAdvance}
            className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? i18nService.t('paperTasksAdvancing') : i18nService.t('paperTasksAdvance')}
          </button>
        )}
      </div>
    </button>
  );
};

export default PaperTaskCard;