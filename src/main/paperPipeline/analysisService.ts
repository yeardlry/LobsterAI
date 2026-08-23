import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import { extractAbstract, extractTitle, parseAuthors } from './xmlParser';

/**
 * Phase 2 extSummary generator — heuristic template, no LLM call.
 *
 * Why a template? The LobsterAI ↔ lit integration is being rolled out in
 * a sandbox where OpenClaw/LLM access is not guaranteed to be online
 * during the first integration tests. We still need a deterministic,
 * fast, and offline `extSummary` so the rest of the state machine can be
 * exercised end-to-end. The template:
 *
 *   1. Re-parses the cached XML (via xmlParser helpers) to pull the
 *      article title and abstract.
 *   2. Falls back to the author list passed in by the orchestrator if
 *      the XML is missing/unparseable.
 *   3. Produces a structured, server-storable summary that includes the
 *      title (as a one-line overview), a trimmed abstract excerpt, the
 *      author count, and an explicit marker that this came from the
 *      heuristic path.
 *
 * Phase 5 will replace this body with an LLM-driven summary once the
 * OpenClaw token proxy is wired through the orchestrator. The signature
 * stays the same so the call site in paperPipelineService.ts does not
 * change.
 */
export async function generateAnalysis(input: {
  pmid: string;
  xml: string;
  authors: PaperTaskAuthor[];
}): Promise<string> {
  const title = extractTitle(input.xml);
  const abstract = extractAbstract(input.xml);
  const authors = input.authors.length > 0 ? input.authors : parseAuthors(input.xml);

  const overview = title || `(PMID ${input.pmid})`;
  const abstractExcerpt = abstract
    ? truncate(abstract, 1200)
    : '摘要原文缺失或无法解析。';

  const authorLabel = describeAuthors(authors);

  return [
    `【标题】 ${overview}`,
    `【作者】 ${authorLabel}`,
    `【摘要】 ${abstractExcerpt}`,
    `【来源】 本摘要由 LobsterAI 启发式模板生成（PMID ${input.pmid}），Phase 5 将切换为 LLM 分析。`,
  ].join('\n');
}

function describeAuthors(authors: PaperTaskAuthor[]): string {
  if (authors.length === 0) return '无作者信息';
  const lead = authors[0]?.fullName ?? 'Unknown';
  const rest = Math.max(0, authors.length - 1);
  if (rest === 0) return lead;
  if (rest === 1) return `${lead} 等 1 人`;
  return `${lead} 等 ${rest} 人`;
}

function truncate(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}…`;
}