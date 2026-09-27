import React, { useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { paperTasksService } from '../../services/paperTasks';
import type { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import {
  resolveOpenClawModelRef,
  toOpenClawModelRef,
} from '../../utils/openclawModelRef';
import ModelSelector from '../ModelSelector';

/**
 * Inline model-settings row for the Paper Tasks page (rendered under the
 * header while the settings toggle is open). Two selectors:
 *
 *   1. 流水线模型 — model override for every hidden-session LLM step of
 *      one-click advance + scheduled-task autopilot. Default ("跟随专家
 *      Agent") keeps the driving agent's binding, except that a DeepSeek
 *      reasoner binding is auto-swapped for v4-flash (main-process rule in
 *      `paperPipelineConfig.resolvePipelineModelOverride`).
 *   2. PDF 直链推荐模型 — model for the token-proxy URL-suggestion call
 *      (previously hardcoded to `lobsterai-server/deepseek-v4-flash`).
 *
 * Both persist immediately on change via the kv-backed IPC round-trip;
 * there is no separate save button.
 */
const PaperTaskModelSettings: React.FC = () => {
  const modelConfig = useSelector((s: RootState) => s.paperTasks.modelConfig);
  const saving = useSelector((s: RootState) => s.paperTasks.modelConfigSaving);
  const availableModels = useSelector((s: RootState) => s.model.availableModels);

  useEffect(() => {
    void paperTasksService.loadModelConfig();
  }, []);

  const configLoading = modelConfig === null;

  const pipeline = useMemo(() => {
    const ref = modelConfig?.pipelineModel ?? '';
    const resolved = ref ? resolveOpenClawModelRef(ref, availableModels) : null;
    return {
      invalid: Boolean(ref) && !resolved,
      value: resolved
        ?? (ref ? ({ id: '__invalid__', name: ref.split('/').pop() || ref } as Model) : null),
    };
  }, [modelConfig?.pipelineModel, availableModels]);

  const pdfSuggest = useMemo(() => {
    const ref = modelConfig?.pdfUrlSuggestModel ?? '';
    const resolved = ref ? resolveOpenClawModelRef(ref, availableModels) : null;
    return {
      invalid: Boolean(ref) && !resolved,
      value: resolved
        ?? (ref ? ({ id: '__invalid__', name: ref.split('/').pop() || ref } as Model) : null),
    };
  }, [modelConfig?.pdfUrlSuggestModel, availableModels]);

  const disabled = saving || configLoading;

  const handlePipelineChange = (model: Model | null): void => {
    if (!modelConfig) return;
    void paperTasksService.saveModelConfig({
      ...modelConfig,
      // null = the "default / follow agent" option was picked.
      pipelineModel: model ? toOpenClawModelRef(model) : '',
    });
  };

  const handlePdfSuggestChange = (model: Model | null): void => {
    if (!modelConfig) return;
    void paperTasksService.saveModelConfig({
      ...modelConfig,
      pdfUrlSuggestModel: model ? toOpenClawModelRef(model) : '',
    });
  };

  return (
    <div className="border-b border-border bg-surface px-6 py-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <label className="flex items-center gap-2" title={i18nService.t('paperTasksModelPipelineHint')}>
          <span className="text-xs font-medium text-secondary">
            {i18nService.t('paperTasksModelPipelineLabel')}
          </span>
          <ModelSelector
            compact
            value={pipeline.value}
            onChange={handlePipelineChange}
            defaultLabel={i18nService.t('paperTasksModelFollowAgent')}
            disabled={disabled}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-xs font-medium text-secondary">
            {i18nService.t('paperTasksModelPdfSuggestLabel')}
          </span>
          <ModelSelector
            compact
            value={pdfSuggest.value}
            onChange={handlePdfSuggestChange}
            defaultLabel={i18nService.t('paperTasksModelPdfSuggestDefault')}
            disabled={disabled}
          />
        </label>
      </div>
      {(pipeline.invalid || pdfSuggest.invalid) && (
        <div className="mt-2 space-y-1 text-xs text-amber-600 dark:text-amber-300">
          {pipeline.invalid && modelConfig?.pipelineModel && (
            <div>
              {i18nService
                .t('paperTasksModelInvalidRef')
                .replace('{ref}', modelConfig.pipelineModel)}
            </div>
          )}
          {pdfSuggest.invalid && modelConfig?.pdfUrlSuggestModel && (
            <div>
              {i18nService
                .t('paperTasksModelInvalidRef')
                .replace('{ref}', modelConfig.pdfUrlSuggestModel)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PaperTaskModelSettings;
