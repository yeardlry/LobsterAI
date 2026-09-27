/**
 * Paper Tasks analytics. Mirrors `scheduledTasks/analytics.ts` (one helper
 * per feature) so every paper-task action lands in the same telemetry
 * stream the rest of the app uses.
 */

type PaperTaskAnalyticsAction =
  | 'open_page'
  | 'refresh_list'
  | 'advance_task'
  | 'advance_task_auto'
  | 'mark_failed'
  | 'reset_task'
  | 'submit_wechat_doc'
  | 'save_model_config'
  | 'select_task';

export function reportPaperTaskAction(
  action: PaperTaskAnalyticsAction,
  detail: Record<string, unknown> = {},
): void {
  try {
    const reporter = (window as unknown as {
      reportPaperTaskAction?: (a: PaperTaskAnalyticsAction, d: Record<string, unknown>) => void;
    }).reportPaperTaskAction;
    if (typeof reporter === 'function') {
      reporter(action, detail);
    }
  } catch {
    // Best-effort; analytics must never break the UI.
  }
}