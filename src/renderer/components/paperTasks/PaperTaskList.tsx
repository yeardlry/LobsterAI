import React from 'react';

import type { PaperTask } from '../../../shared/paperPipeline/types';
import { i18nService } from '../../services/i18n';
import type { PaperTasksState } from '../../store/slices/paperTasksSlice';
import { PaperTasksDataStatus } from '../../store/slices/paperTasksSlice';
import PaperTaskCard from './PaperTaskCard';

interface PaperTaskListProps {
  tasks: PaperTask[];
  listStatus: PaperTasksState['listStatus'];
  listError: string | null;
  advancingPmid: string | null;
  onSelect: (pmid: string) => void;
  onRefresh: () => void;
}

/**
 * Card grid that mirrors `scheduledTasks/TaskList.tsx`. Renders a skeleton
 * while loading, an error / empty panel on failure / no-tasks, and the
 * populated grid otherwise.
 */
const PaperTaskList: React.FC<PaperTaskListProps> = ({
  tasks,
  listStatus,
  listError,
  advancingPmid,
  onSelect,
  onRefresh,
}) => {
  if (listStatus === PaperTasksDataStatus.Loading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-2xl border border-border bg-surface/50"
          />
        ))}
      </div>
    );
  }

  if (listStatus === PaperTasksDataStatus.Error) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="text-sm font-medium text-red-700 dark:text-red-300">
          {i18nService.t('paperTasksListErrorTitle')}
        </div>
        <div className="text-xs text-red-700/80 dark:text-red-300/80">
          {listError ?? 'Unknown error'}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="h-8 rounded-lg bg-foreground px-3 text-xs font-medium text-surface transition-opacity hover:opacity-90"
        >
          {i18nService.t('paperTasksRefresh')}
        </button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center">
        <div className="text-sm font-medium text-secondary">
          {i18nService.t('paperTasksEmptyTitle')}
        </div>
        <div className="mt-1 text-xs text-muted">
          {i18nService.t('paperTasksEmptyHint')}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="mt-4 h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-surface transition-opacity hover:opacity-90"
        >
          {i18nService.t('paperTasksRefresh')}
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
      {tasks.map(task => (
        <PaperTaskCard
          key={task.pmid}
          task={task}
          busy={advancingPmid === task.pmid}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};

export default PaperTaskList;