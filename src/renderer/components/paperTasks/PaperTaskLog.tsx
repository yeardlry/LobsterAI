import React, { useEffect, useRef } from 'react';

import type { PaperTaskLogEntry } from '../../../shared/paperPipeline/types';

interface PaperTaskLogProps {
  entries: PaperTaskLogEntry[];
}

/**
 * Renders the most-recent execution log lines for one task. Used inside the
 * detail drawer; auto-scrolls to the bottom on new entries.
 */
const PaperTaskLog: React.FC<PaperTaskLogProps> = ({ entries }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="rounded-lg bg-surface-inset px-3 py-4 text-center text-xs text-muted">
        No log entries yet.
      </div>
    );
  }

  const toneFor = (level: PaperTaskLogEntry['level']): string => {
    switch (level) {
      case 'error':
        return 'text-red-600 dark:text-red-300';
      case 'warn':
        return 'text-amber-600 dark:text-amber-300';
      case 'debug':
        return 'text-muted';
      case 'info':
      default:
        return 'text-secondary';
    }
  };

  return (
    <div
      ref={containerRef}
      className="max-h-64 overflow-y-auto rounded-lg bg-surface-inset px-3 py-2 font-mono text-[11px] leading-relaxed"
    >
      {entries.map((entry, idx) => (
        <div key={idx} className={`flex gap-2 ${toneFor(entry.level)}`}>
          <span className="shrink-0 text-muted">
            {new Date(entry.at).toLocaleTimeString()}
          </span>
          <span className="shrink-0 uppercase">{entry.level}</span>
          <span className="min-w-0 flex-1 break-words">{entry.message}</span>
        </div>
      ))}
    </div>
  );
};

export default PaperTaskLog;