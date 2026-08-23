import React from 'react';

import { PaperPipelineProcessingStatus } from '../../../shared/paperPipeline/constants';
import { i18nService } from '../../services/i18n';

type Status = typeof PaperPipelineProcessingStatus[keyof typeof PaperPipelineProcessingStatus];

const STATUS_TONE: Record<Status, string> = {
  [PaperPipelineProcessingStatus.XmlReady]: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200',
  [PaperPipelineProcessingStatus.Parsed]: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200',
  [PaperPipelineProcessingStatus.Analyzed]: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200',
  [PaperPipelineProcessingStatus.Categorized]: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
  [PaperPipelineProcessingStatus.PdfReady]: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200',
  [PaperPipelineProcessingStatus.Completed]: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200',
  [PaperPipelineProcessingStatus.Failed]: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200',
};

const STATUS_LABEL_KEY: Record<Status, string> = {
  [PaperPipelineProcessingStatus.XmlReady]: 'paperTasksStatusXmlReady',
  [PaperPipelineProcessingStatus.Parsed]: 'paperTasksStatusParsed',
  [PaperPipelineProcessingStatus.Analyzed]: 'paperTasksStatusAnalyzed',
  [PaperPipelineProcessingStatus.Categorized]: 'paperTasksStatusCategorized',
  [PaperPipelineProcessingStatus.PdfReady]: 'paperTasksStatusPdfReady',
  [PaperPipelineProcessingStatus.Completed]: 'paperTasksStatusCompleted',
  [PaperPipelineProcessingStatus.Failed]: 'paperTasksStatusFailed',
};

interface PaperTaskStatusChipProps {
  status: Status;
}

/**
 * Colored chip for one of the seven paper-pipeline states. Mirrors the
 * shape of `scheduledTasks/TaskStatusChip.tsx` but inlines the color map
 * because there is no shared status badge in this repo.
 */
const PaperTaskStatusChip: React.FC<PaperTaskStatusChipProps> = ({ status }) => {
  const tone = STATUS_TONE[status];
  const label = i18nService.t(STATUS_LABEL_KEY[status]);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
};

export default PaperTaskStatusChip;