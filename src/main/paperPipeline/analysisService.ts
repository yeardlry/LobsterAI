import { promises as fs } from 'node:fs';

import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import {
  resolveTaskSessionDeps,
  runTaskHiddenSession,
  type TaskSessionDeps,
} from './taskHiddenSession';
import { extractAbstract, extractTitle, parseAuthors } from './xmlParser';

/**
 * Phase 2 extSummary generator — LLM-first with a heuristic fallback.
 *
 * Primary path: the task's pooled hidden Cowork session (same agent /
 * tools as a normal chat) reads the cached full-text XML and writes a
 * structured, data-citing Chinese summary. The session is shared with the
 * later steps (categorize / PDF download / WeChat draft), so the analysis
 * turn also primes the article context for them.
 *
 * Fallback path (used when the session deps are not wired, the XML cache is
 * missing, or the agent fails / produces an unusable reply): a deterministic
 * offline template so the state machine never breaks on this step. The
 * template re-parses the cached XML for title + abstract and marks the
 * result as heuristic-generated.
 */
export async function generateAnalysis(input: {
  pmid: string;
  xml: string;
  authors: PaperTaskAuthor[];
  /**
   * Absolute path of the cached full-text XML. The LLM path points the
   * agent at this file; when it is missing the heuristic runs instead
   * (it works from the in-memory `xml` / `authors`).
   */
  xmlPath?: string;
  /**
   * Absolute path of the local full-text Markdown converted from the
   * downloaded PDF / HTML landing page (`fulltext/{pmid}.md`). When
   * present the LLM reads it FIRST — the body-level data 【关键发现】
   * must cite lives there, not in the XML's abstract.
   */
  fulltextMdPath?: string;
  /** Hidden-session deps; when wired the LLM writes the summary first. */
  deps?: TaskSessionDeps;
  /**
   * Override agent id for the hidden session. Falls back to the global
   * `main` agent when omitted (the pre-existing per-step behaviour);
   * the auto-advance orchestrator threads an installed-expert id through
   * here so the analysis turn can use biology-tuned skills.
   */
  agentId?: string;
  /**
   * Session-level model override (provider-qualified ref) threaded from
   * `PaperPipelineModelConfig.pipelineModel`. `undefined` keeps the agent's
   * own binding.
   */
  modelOverride?: string;
}): Promise<string> {
  const llmSummary = await tryGenerateWithAgent(input);
  if (llmSummary) return llmSummary;

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
    `【来源】 本摘要由 LobsterAI 启发式模板生成（PMID ${input.pmid}），LLM 分析不可用时的兜底结果。`,
  ].join('\n');
}

/** Agent-written summaries must beat this length or we treat them as failures. */
const MIN_LLM_SUMMARY_CHARS = 100;

/**
 * Drive the task's hidden session to write the summary. Returns the summary
 * text iff the agent produced a plausible reply (the claim alone is not
 * evidence — same trust-but-verify policy as the agent-downloaded PDF).
 * Errors are logged and swallowed: the caller falls back to the template.
 */
async function tryGenerateWithAgent(input: {
  pmid: string;
  xml: string;
  authors: PaperTaskAuthor[];
  xmlPath?: string;
  fulltextMdPath?: string;
  deps?: TaskSessionDeps;
  agentId?: string;
  modelOverride?: string;
}): Promise<string | null> {
  const sessionDeps = resolveTaskSessionDeps(input.deps);
  const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
    input.deps?.log ?? ((level, message) => console[level](message));
  if (!sessionDeps || (!input.xmlPath && !input.fulltextMdPath)) return null;

  // The agent reads the sources from disk — no cached file, nothing to
  // read. The full-text md is the preferred source; the XML supplements
  // it (authors, journal metadata) or stands alone when no md exists.
  const [hasXml, hasMd] = await Promise.all([
    input.xmlPath
      ? fs.access(input.xmlPath).then(() => true, (): false => false)
      : Promise.resolve(false),
    input.fulltextMdPath
      ? fs.access(input.fulltextMdPath).then(() => true, (): false => false)
      : Promise.resolve(false),
  ]);
  if (!hasXml && !hasMd) {
    logSink('warn', `[Analysis] no cached full text (XML/md) for PMID ${input.pmid}, using heuristic fallback`);
    return null;
  }

  try {
    const result = await runTaskHiddenSession(
      input.pmid,
      {
        prompt: buildAnalysisPrompt({
          pmid: input.pmid,
          xmlPath: hasXml ? input.xmlPath! : null,
          fulltextMdPath: hasMd ? input.fulltextMdPath! : null,
          title: extractTitle(input.xml) || null,
          abstract: extractAbstract(input.xml) || null,
        }),
        agentId: input.agentId ?? 'main',
        modelOverride: input.modelOverride,
        // Reading a full-length XML + writing the summary is a moderate
        // agent turn — well under the article-draft budget.
        timeoutMs: 180 * 1000,
      },
      sessionDeps,
    );
    const text = result.finalText.trim();
    if (text.includes('FAILED') || text.length < MIN_LLM_SUMMARY_CHARS) {
      logSink(
        'warn',
        `[Analysis] LLM summary unusable for PMID ${input.pmid} (${text.length} chars), using heuristic fallback`,
      );
      return null;
    }
    logSink('info', `[Analysis] LLM generated extSummary (${text.length} chars) for PMID ${input.pmid}`);
    return text;
  } catch (err) {
    logSink(
      'warn',
      `[Analysis] hidden session failed for PMID ${input.pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    return null;
  }
}

function buildAnalysisPrompt(input: {
  pmid: string;
  xmlPath: string | null;
  fulltextMdPath: string | null;
  title: string | null;
  abstract: string | null;
}): string {
  const parts: string[] = [
    '请阅读一篇生物医学文献的全文，写一段结构化的中文分析摘要（extSummary），直接在回复里输出摘要正文。',
    '',
    `文献 PMID：${input.pmid}`,
  ];
  if (input.title) parts.push(`标题：${input.title}`);
  if (input.abstract) parts.push(`摘要：${truncate(input.abstract, 600)}`);
  // With a converted full-text md the body-level data (sample sizes,
  // effect sizes, p values) is there and the XML is a metadata
  // supplement; without it the XML (title/abstract) is all there is.
  // The no-md wording stays byte-identical to the original prompt.
  if (input.fulltextMdPath) {
    parts.push(
      `全文 Markdown（由 PDF/HTML 全文转换而来，本地文件，UTF-8）：${input.fulltextMdPath} —— 优先阅读，【关键发现】所需的具体数据主要在这里；`,
    );
  }
  if (input.xmlPath) {
    parts.push(input.fulltextMdPath
      ? `全文 XML（本地文件，UTF-8，题录与结构化摘要）：${input.xmlPath} —— 作为补充（作者列表、期刊信息等）。`
      : `全文 XML（本地文件，UTF-8）：${input.xmlPath}`);
  }
  parts.push(
    '',
    '写作要求：',
    '1. 结构：【标题】【作者】【研究背景】【方法】【关键发现】【意义】各一段，每段 1-3 句；',
    input.fulltextMdPath
      ? '2. 【关键发现】必须引用原文正文的具体数据（样本量、效应量、p 值等，优先取自全文 Markdown 的结果部分），不要泛泛而谈；'
      : '2. 【关键发现】必须引用原文的具体数据（样本量、效应量、p 值等），不要泛泛而谈；',
    input.fulltextMdPath
      ? '3. 科学准确，不编造数据；读不到全文时回复一行 FAILED: 原因；'
      : '3. 科学准确，不编造数据；读不到 XML 时回复一行 FAILED: 原因；',
    '4. 回复只包含摘要正文，不要任何额外说明、寒暄或前后缀。',
  );
  return parts.join('\n');
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
