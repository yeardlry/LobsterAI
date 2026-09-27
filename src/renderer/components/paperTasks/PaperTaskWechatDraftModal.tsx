import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { paperTasksService } from '../../services/paperTasks';
import type { RootState } from '../../store';
import type { WechatDraft } from '../../store/slices/paperTasksSlice';
import { showToast } from '../../utils/localFileActions';

const DOC_URL_PATTERN = /^https:\/\/mp\.weixin\.qq\.com\//i;

/**
 * Modal that pops after the orchestrator renders a WeChat article draft.
 *
 * Workflow shown to the user:
 *   1. Open 微信公众平台 in their browser, paste the Markdown from
 *      `draft.localPath` (or open `draft.publicUrl` directly).
 *   2. Hit 微信's "发布" → copy the resulting `https://mp.weixin.qq.com/s/...`
 *      link.
 *   3. Paste it back here and hit "完成" → main calls
 *      `submitWechatDoc(pmid, docUrl)` and the task flips to `completed`.
 */
const PaperTaskWechatDraftModal: React.FC = () => {
  const activePmid = useSelector(
    (s: RootState) => s.paperTasks.activeWechatDraftPmid,
  );
  const draft = useSelector(
    (s: RootState) =>
      (activePmid ? s.paperTasks.wechatDrafts[activePmid] : undefined) ??
      undefined,
  );
  const submitting = useSelector(
    (s: RootState) => s.paperTasks.submittingWechatPmid,
  );

  const [docUrl, setDocUrl] = useState('');

  // Reset the input when the modal opens for a different pmid.
  useEffect(() => {
    setDocUrl('');
  }, [activePmid]);

  if (!activePmid || !draft) return null;

  const isSubmitting = submitting === activePmid;
  const urlLooksValid = DOC_URL_PATTERN.test(docUrl.trim());

  const handleOpenLocal = async (): Promise<void> => {
    // Copy the on-disk Markdown path via the preload clipboard bridge.
    // `navigator.clipboard` is unreliable in the sandboxed renderer and
    // failed silently here; the IPC bridge goes through Electron's
    // clipboard module in the main process. A toast confirms the click
    // actually did something.
    try {
      await window.electron?.clipboard?.writeText(draft.localPath);
      showToast(i18nService.t('paperTasksWechatDraftPathCopied'));
    } catch {
      showToast(i18nService.t('paperTasksWechatDraftPathCopyFailed'));
    }
  };

  const handleOpenPublic = (): void => {
    window.open(draft.publicUrl, '_blank', 'noopener,noreferrer');
  };

  const handleSubmit = async (): Promise<void> => {
    const trimmed = docUrl.trim();
    if (!urlLooksValid) return;
    await paperTasksService.submitWechatDoc(activePmid, trimmed, {
      markdownUrl: draft.publicUrl,
    });
  };

  const handleCancel = (): void => {
    paperTasksService.cancelWechatDraft();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={i18nService.t('paperTasksWechatDraftTitle')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-background shadow-xl">
        <header className="border-b border-border px-5 py-4">
          <div className="text-base font-semibold text-foreground">
            {i18nService.t('paperTasksWechatDraftTitle')}
          </div>
          <div className="mt-1 font-mono text-xs text-muted">
            PMID {activePmid}
          </div>
        </header>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-secondary">
            {i18nService.t('paperTasksWechatDraftBody')}
          </p>

          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs font-medium text-muted">
              {i18nService.t('paperTasksWechatDraftTitleLabel')}
            </div>
            <div className="mt-1 text-sm text-foreground">{draft.title}</div>
            <div className="mt-3 text-xs font-medium text-muted">
              {i18nService.t('paperTasksWechatDraftSummaryLabel')}
            </div>
            <div className="mt-1 line-clamp-3 text-xs text-secondary">
              {draft.summary}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void handleOpenLocal();
              }}
              className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover"
            >
              {i18nService.t('paperTasksWechatDraftCopyPath')}
            </button>
            <button
              type="button"
              onClick={handleOpenPublic}
              className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover"
            >
              {i18nService.t('paperTasksWechatDraftOpenPublic')}
            </button>
          </div>

          <label className="block">
            <div className="text-xs font-medium text-muted">
              {i18nService.t('paperTasksWechatDraftDocUrlLabel')}
            </div>
            <input
              type="url"
              value={docUrl}
              onChange={event => setDocUrl(event.target.value)}
              placeholder="https://mp.weixin.qq.com/s/..."
              className="mt-1.5 h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:border-primary/40 focus:outline-none"
              disabled={isSubmitting}
            />
            {docUrl.length > 0 && !urlLooksValid && (
              <div className="mt-1 text-xs text-red-600">
                {i18nService.t('paperTasksWechatDraftDocUrlInvalid')}
              </div>
            )}
          </label>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="h-9 rounded-lg border border-border bg-surface px-4 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {i18nService.t('paperTasksWechatDraftCancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={!urlLooksValid || isSubmitting}
            className="h-9 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting
              ? i18nService.t('paperTasksWechatDraftSubmitting')
              : i18nService.t('paperTasksWechatDraftSubmit')}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default PaperTaskWechatDraftModal;
export type { WechatDraft };