import React, { useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { paperTasksService } from '../../services/paperTasks';
import type { RootState } from '../../store';
import { PaperTasksDataStatus } from '../../store/slices/paperTasksSlice';
import { isPaperTaskAdvancedDone } from './paperTaskFilters';
import PaperTaskList from './PaperTaskList';
import PaperTaskLog from './PaperTaskLog';
import PaperTaskModelSettings from './PaperTaskModelSettings';
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
  const page = useSelector((s: RootState) => s.paperTasks.page);
  const pageSize = useSelector((s: RootState) => s.paperTasks.pageSize);
  const total = useSelector((s: RootState) => s.paperTasks.total);

  const [selectedPmid, setSelectedPmid] = useState<string | null>(null);
  /**
   * Hide cards whose one-click advance has finished (pdf_ready / completed
   * / already-uploaded PDF). Default on — the user usually cares about
   * what still needs attention. Local state, resets on remount.
   */
  const [hideAdvancedDone, setHideAdvancedDone] = useState<boolean>(true);
  /**
   * Whether the inline model-settings row is expanded under the header.
   * Local state, resets on remount.
   */
  const [modelSettingsOpen, setModelSettingsOpen] = useState<boolean>(false);

  const visibleTasks = useMemo(
    () => (hideAdvancedDone ? tasks.filter(t => !isPaperTaskAdvancedDone(t)) : tasks),
    [tasks, hideAdvancedDone],
  );

  const handleRefresh = useCallback((): void => {
    void paperTasksService.loadTasks();
  }, []);

  const goToPage = useCallback((next: number) => {
    if (next < 1) return;
    void paperTasksService.loadTasks({ page: next });
  }, []);

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const canPrev = page > 1;
  const canNext = page < totalPages;

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
        <div className="flex items-center gap-3">
          {tasks.length > 0 && (
            <span className="text-xs text-muted">
              {i18nService
                .t('paperTasksShowingCount')
                .replace('{shown}', String(visibleTasks.length))
                .replace('{total}', String(tasks.length))}
            </span>
          )}
          <label
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-secondary transition-colors hover:border-foreground/30 hover:text-foreground"
            title={i18nService.t('paperTasksHideCompletedHint')}
          >
            <input
              type="checkbox"
              checked={hideAdvancedDone}
              onChange={e => setHideAdvancedDone(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-foreground"
            />
            <span>{i18nService.t('paperTasksHideCompletedLabel')}</span>
          </label>
          <button
            type="button"
            onClick={() => setModelSettingsOpen(v => !v)}
            aria-expanded={modelSettingsOpen}
            aria-label={i18nService.t('paperTasksModelSettings')}
            title={i18nService.t('paperTasksModelSettings')}
            className={`flex h-9 items-center rounded-lg border px-3 text-xs font-medium transition-colors ${
              modelSettingsOpen
                ? 'border-foreground/40 bg-surface text-foreground'
                : 'border-border bg-surface text-secondary hover:border-foreground/30 hover:text-foreground'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 15a3 3 0 100-6 3 3 0 000 6z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
          type="button"
          onClick={handleRefresh}
          className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-surface transition-opacity hover:opacity-90"
        >
          {i18nService.t('paperTasksRefresh')}
        </button>
        </div>
      </header>

      {modelSettingsOpen && <PaperTaskModelSettings />}

      <div className="flex flex-1 overflow-hidden">
        <main className="flex flex-1 flex-col overflow-hidden p-6">
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
            <>
              <div className="flex-1 overflow-y-auto">
                <PaperTaskList
                  tasks={visibleTasks}
                  listStatus={listStatus}
                  listError={listError}
                  advancingPmid={advancingPmid}
                  onSelect={setSelectedPmid}
                  onRefresh={handleRefresh}
                  totalCount={tasks.length}
                />
              </div>
              {total > 0 && (
                <nav
                  className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4"
                  aria-label="Paper tasks pagination"
                >
                  <div className="text-xs text-muted">
                    {i18nService
                      .t('paperTasksPaginationTotal')
                      .replace('{total}', String(total))}
                    {' · '}
                    {i18nService
                      .t('paperTasksPaginationPageSize')
                      .replace('{size}', String(pageSize))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => goToPage(page - 1)}
                      disabled={!canPrev}
                      className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {i18nService.t('paperTasksPaginationPrev')}
                    </button>
                    <span className="text-xs font-medium text-secondary">
                      {i18nService
                        .t('paperTasksPaginationPage')
                        .replace('{page}', String(page))
                        .replace('{totalPages}', String(totalPages))}
                    </span>
                    <button
                      type="button"
                      onClick={() => goToPage(page + 1)}
                      disabled={!canNext}
                      className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {i18nService.t('paperTasksPaginationNext')}
                    </button>
                  </div>
                </nav>
              )}
            </>
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