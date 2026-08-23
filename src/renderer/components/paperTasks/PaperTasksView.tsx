import React, { useCallback, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { paperTasksService } from '../../services/paperTasks';
import type { RootState } from '../../store';
import { PaperTasksDataStatus } from '../../store/slices/paperTasksSlice';
import PaperTaskList from './PaperTaskList';
import PaperTaskLog from './PaperTaskLog';
import PaperTaskWechatDraftModal from './PaperTaskWechatDraftModal';

interface PaperTasksViewProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

/**
 * Page shell for the Paper Tasks feature. Mirrors the layout of
 * `scheduledTasks/ScheduledTasksView.tsx`: a header with title + refresh
 * button, then the card grid, with an inline detail panel for the
 * currently-selected task showing its live execution log.
 */
const PaperTasksView: React.FC<PaperTasksViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
}) => {
  const tasks = useSelector((s: RootState) => s.paperTasks.tasks);
  const listStatus = useSelector((s: RootState) => s.paperTasks.listStatus);
  const listError = useSelector((s: RootState) => s.paperTasks.listError);
  const advancingPmid = useSelector((s: RootState) => s.paperTasks.advancingPmid);
  const logs = useSelector((s: RootState) => s.paperTasks.logs);
  const disabled = useSelector((s: RootState) => s.paperTasks.disabled);

  const [selectedPmid, setSelectedPmid] = useState<string | null>(null);

  const handleRefresh = useCallback((): void => {
    void paperTasksService.loadTasks();
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border bg-background px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
            className="rounded-lg p-2 text-muted hover:bg-surface-inset"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              {i18nService.t('paperTasksTitle')}
            </h1>
            <p className="mt-0.5 text-xs text-muted">
              {i18nService.t('paperTasksSubtitle')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-surface transition-opacity hover:opacity-90"
        >
          {i18nService.t('paperTasksRefresh')}
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          {disabled ? (
            <div className="rounded-2xl border border-border bg-surface p-8 text-center">
              <div className="text-sm font-medium text-secondary">
                {i18nService.t('paperTasksDisabledTitle')}
              </div>
              <div className="mt-1 text-xs text-muted">
                {i18nService.t('paperTasksDisabledHint')}
              </div>
            </div>
          ) : (
            <PaperTaskList
              tasks={tasks}
              listStatus={listStatus}
              listError={listError}
              advancingPmid={advancingPmid}
              onSelect={setSelectedPmid}
              onRefresh={handleRefresh}
            />
          )}
        </main>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-background p-4">
          {selectedPmid === null ? (
            <div className="text-xs text-muted">
              {i18nService.t('paperTasksSelectHint')}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="font-mono text-xs text-muted">PMID {selectedPmid}</div>
              <div className="text-sm font-medium text-foreground">
                {i18nService.t('paperTasksExecutionLog')}
              </div>
              <PaperTaskLog entries={logs[selectedPmid] ?? []} />
            </div>
          )}
        </aside>
      </div>

      {!isSidebarCollapsed && listStatus !== PaperTasksDataStatus.Ready && (
        <div className="border-t border-border bg-background px-6 py-2 text-xs text-muted">
          {i18nService.t('paperTasksReadyHint')}
        </div>
      )}

      <PaperTaskWechatDraftModal />
    </div>
  );
};

export default PaperTasksView;