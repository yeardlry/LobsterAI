import { promises as fs } from 'node:fs';

import {
  buildFulltextConversionPrompt,
  type FulltextSourceKind,
} from './fulltextConversionPrompt';
import { getPaperPipelineFulltextMdPath } from './storage';
import {
  resolveTaskSessionDeps,
  runTaskHiddenSession,
  type TaskSessionDeps,
} from './taskHiddenSession';

/**
 * Full-text Markdown conversion (local-only).
 *
 * The one-click advance needs the article's full text BEFORE the analysis
 * step runs, so that 【关键发现】 can cite body-level data instead of the
 * abstract. This module converts the downloaded PDF (or the closed-access
 * HTML landing page) into `fulltext/{pmid}.md` via the task's pooled hidden
 * Cowork session — same trust-but-verify policy as the agent-downloaded
 * PDF: the DONE claim alone is not evidence, the file on disk is.
 *
 * Never throws: every failure path returns null and the caller falls back
 * to XML-based analysis, so the pipeline state machine never breaks here.
 * The output is local analysis input only — it is never uploaded (the OSS
 * `md/{pmid}.md` key belongs to the WeChat draft).
 */

/** Converted full-text must beat this length or we treat it as unusable. */
const MIN_FULLTEXT_MD_CHARS = 300;

/**
 * Return the cached full-text Markdown path when a plausible conversion
 * already exists on disk, else null.
 */
export async function getExistingFulltextMdPath(
  pmid: string,
  title?: string | null,
): Promise<string | null> {
  const mdPath = getPaperPipelineFulltextMdPath(pmid);
  const text = await fs.readFile(mdPath, 'utf-8').catch((): null => null);
  if (text === null || text.trim().length < MIN_FULLTEXT_MD_CHARS) return null;
  if (/^(FAILED|ERROR)\s*:/im.test(text.trim())) return null;
  const normalizedTitle = title?.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalizedTitle) {
    const normalizedText = text.toLowerCase().replace(/\s+/g, ' ');
    const titleTokens = normalizedTitle.split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 3);
    const matches = titleTokens.filter(token => normalizedText.includes(token)).length;
    if (titleTokens.length > 0 && matches / titleTokens.length < 0.5) return null;
  }
  return mdPath;
}

export async function convertFulltextToMarkdown(input: {
  pmid: string;
  sourcePath: string;
  sourceKind: FulltextSourceKind;
  title?: string | null;
  /** Hidden-session deps; when unwired the conversion is skipped. */
  deps?: TaskSessionDeps;
  /**
   * Override agent id for the hidden session. Falls back to the global
   * `main` agent when omitted; the auto-advance orchestrator threads an
   * installed-expert id through here so the conversion agent picks the
   * best extractor for the source (biology-tuned agents often know
   * pdf-to-markdown tricks main does not).
   */
  agentId?: string;
  /**
   * Session-level model override (provider-qualified ref) threaded from
   * `PaperPipelineModelConfig.pipelineModel`. `undefined` keeps the agent's
   * own binding.
   */
  modelOverride?: string;
}): Promise<string | null> {
  try {
    return await tryConvert(input);
  } catch (err) {
    const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
      input.deps?.log ?? ((level, message) => console[level](message));
    logSink(
      'warn',
      `[FulltextMd] conversion session failed for PMID ${input.pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    // The session may have timed out AFTER the file landed (the PDF
    // download learned this the hard way) — check the disk once before
    // giving up. Never throws: even the re-check must not break the
    // caller's run.
    return getExistingFulltextMdPath(input.pmid, input.title).catch((): null => null);
  }
}

async function tryConvert(input: {
  pmid: string;
  sourcePath: string;
  sourceKind: FulltextSourceKind;
  title?: string | null;
  deps?: TaskSessionDeps;
  agentId?: string;
  modelOverride?: string;
}): Promise<string | null> {
  const sessionDeps = resolveTaskSessionDeps(input.deps);
  const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
    input.deps?.log ?? ((level, message) => console[level](message));
  if (!sessionDeps) {
    logSink('warn', `[FulltextMd] hidden-session deps not wired, skipping conversion for PMID ${input.pmid}`);
    return null;
  }

  // A previous conversion may already exist — reuse it without a session
  // turn (re-running a step after a later-step failure is common).
  const cached = await getExistingFulltextMdPath(input.pmid, input.title);
  if (cached) return cached;

  const hasSource = await fs.access(input.sourcePath).then(() => true, (): false => false);
  if (!hasSource) {
    logSink('warn', `[FulltextMd] source file missing for PMID ${input.pmid}: ${input.sourcePath}`);
    return null;
  }

  const mdPath = getPaperPipelineFulltextMdPath(input.pmid);
  const result = await runTaskHiddenSession(
    input.pmid,
    {
      prompt: buildFulltextConversionPrompt({
        pmid: input.pmid,
        sourcePath: input.sourcePath,
        sourceKind: input.sourceKind,
        mdPath,
        title: input.title ?? null,
      }),
      agentId: input.agentId ?? 'main',
      modelOverride: input.modelOverride,
      // Extraction from a large PDF can involve probing for / installing
      // CLI tools first — same budget as the analysis and word-export
      // turns.
      timeoutMs: 180 * 1000,
    },
    sessionDeps,
  );

  const md = await fs.readFile(mdPath, 'utf-8').catch(() => '');
  if (
    !result.finalText.includes('DONE') ||
    md.trim().length < MIN_FULLTEXT_MD_CHARS
  ) {
    logSink(
      'warn',
      `[FulltextMd] conversion unusable for PMID ${input.pmid} (reply ${result.finalText.slice(0, 120)}, file ${md.length} chars)`,
    );
    return null;
  }
  logSink('info', `[FulltextMd] full-text markdown ready for PMID ${input.pmid} (${md.length} chars)`);
  return mdPath;
}
