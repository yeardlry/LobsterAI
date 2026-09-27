/**
 * Pure helpers for parsing display metadata out of an agent-generated
 * WeChat draft Markdown. Extracted from `wechatArticleService.ts` so it
 * can be unit-tested without importing the hidden-session / store chain
 * (which pulls Electron-only modules into Vitest).
 */

/**
 * Pull a display title + summary out of a generated draft: the first
 * heading becomes the title, and the first body paragraph (skipping
 * headings, blockquotes, and images) becomes the summary.
 */
export function extractDraftMeta(markdown: string): {
  title: string | null;
  summary: string | null;
} {
  const lines = markdown.split(/\r?\n/);
  let title: string | null = null;
  const summaryParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (summaryParts.length > 0) break; // paragraph complete
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      if (!title) title = heading[1].trim();
      continue;
    }
    if (trimmed.startsWith('>') || trimmed.startsWith('![')) continue;
    if (title) summaryParts.push(trimmed);
    if (summaryParts.join('').length >= 80) break;
  }

  return {
    title,
    summary: summaryParts.length > 0 ? truncate(summaryParts.join(' '), 300) : null,
  };
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
