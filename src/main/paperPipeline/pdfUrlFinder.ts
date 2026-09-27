import { net } from 'electron';

import { DEFAULT_PDF_URL_SUGGEST_MODEL } from '../../shared/paperPipeline/constants';
import type { CoworkStore } from '../coworkStore';
import { type HiddenCoworkSessionDeps } from '../libs/agentEngine/hiddenCoworkSession';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { getOpenClawTokenProxyPort } from '../libs/openclawTokenProxy';
import { runTaskHiddenSession } from './taskHiddenSession';

/**
 * Phase 6 + 7 LLM-assisted PDF acquisition.
 *
 * When the deterministic EuropePMC / PMC chains fail, LobsterAI falls back
 * to the same LLM models the user already uses in chat:
 *
 * Strategy priority:
 *   1. {@link findPdfUrl} — direct chat completion against OpenClaw's
 *      local token-proxy port. Lightweight (no agent orchestration) but
 *      tool-less: it can only suggest URLs, which `downloadPdf` then
 *      fetches itself. Returns every URL found in the reply so the
 *      caller can try them in order.
 *   2. {@link downloadPdfViaHiddenCoworkSession} (Phase 7) — spin up an
 *      isolated Cowork session from the main process via
 *      `hiddenCoworkSession.runHiddenCoworkSession(...)` and have the
 *      agent **download the PDF itself** to a given local path using CLI
 *      tools only (curl / wget with a browser User-Agent). The prompt
 *      forbids browser / GUI tools — the agent keeps walking OA mirrors
 *      until a URL answers a direct download (observed 2026-09-16: 8.9 MB
 *      Nature Communications PDF in 32s). Auto-approved permission
 *      requests keep the run unattended.
 *
 * If everything fails the orchestrator catches the error and asks the
 * backend to mark the task `failed`. The user can `Reset` it once a
 * workaround is available.
 */

export interface PdfUrlFinderDeps {
  /**
   * Resolve the OpenClaw token-proxy port at call time. Injected so tests
   * can stub it; in production this should return the result of
   * `getOpenClawTokenProxyPort()` from `libs/openclawTokenProxy.ts`.
   */
  getTokenProxyPort: () => number | null;
  /**
   * Phase 7 — Cowork runtime + store for the hidden-session fallback.
   * When provided AND the token-proxy path returns null / throws, the
   * finder drives a one-shot session through `runHiddenCoworkSession`.
   * Optional: when omitted, the priority-2 branch is skipped entirely.
   */
  coworkRuntime?: CoworkRuntime;
  coworkStore?: CoworkStore;
  resolveAgentCwd?: (agentId: string) => string;
  /** Optional logger; defaults to console. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export async function findPdfUrl(input: {
  pmid: string;
  title?: string | null;
  abstractText?: string | null;
  deps: PdfUrlFinderDeps;
  /**
   * Provider-qualified model ref for the token-proxy completion (per-run
   * config from `PaperPipelineModelConfig.pdfUrlSuggestModel`). Empty or
   * omitted falls back to `DEFAULT_PDF_URL_SUGGEST_MODEL`.
   */
  suggestModel?: string;
}): Promise<string[]> {
  const log = input.deps.log ?? defaultLog;
  const prompt = buildPrompt(input);

  // Token-proxy LLM — the only URL-suggesting strategy. The hidden-session
  // branch below supersedes URL suggestions with a real agent download, so
  // it is not part of this function.
  try {
    return await findPdfUrlViaTokenProxy(prompt, input.deps, input.suggestModel);
  } catch (err) {
    log(
      'warn',
      `token-proxy strategy failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  return [];
}

function buildPrompt(input: {
  pmid: string;
  title?: string | null;
  abstractText?: string | null;
}): string {
  const title = input.title?.trim();
  const abstract = input.abstractText?.trim();
  const parts: string[] = [
    `帮我找一个可直接下载的 PDF URL，文献 PMID 是 ${input.pmid}。`,
  ];
  if (title) parts.push(`标题：${title}`);
  if (abstract) parts.push(`摘要：${abstract}`);
  parts.push(
    '请返回一个有效的 PDF 直链（https:// 开头，单独一行）；' +
      '如有多个候选，按推荐顺序每行一个；' +
      '如果没有任何可用的公开 PDF，请返回 NO_PDF。',
  );
  return parts.join('\n');
}

/**
 * Token-proxy fallback — calls OpenClaw's local chat completion endpoint
 * with a one-shot prompt and parses every URL out of the response.
 */
async function findPdfUrlViaTokenProxy(
  prompt: string,
  deps: PdfUrlFinderDeps,
  suggestModel?: string,
): Promise<string[]> {
  const port = deps.getTokenProxyPort();
  if (port === null) {
    throw new Error('token proxy is not running');
  }
  const model = (suggestModel ?? '').trim() || DEFAULT_PDF_URL_SUGGEST_MODEL;
  const response = await net.fetch(
    `http://127.0.0.1:${port}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`chat completion HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? '';
  return extractHttpUrls(content);
}

/**
 * Phase 7 — drive a hidden Cowork session and have the agent download the
 * PDF itself to `localPath` using CLI tools only (the prompt explicitly
 * forbids browsers / GUI tools; the agent searches OA sources until a
 * direct URL answers curl). Re-uses the lifecycle helpers in
 * `hiddenCoworkSession.ts` so permission auto-approval, listener cleanup,
 * and timeout handling are uniform across the paper pipeline.
 *
 * Returns true iff the agent's final reply claims the file was saved
 * (`DOWNLOADED`). The caller independently verifies the file (size + PDF
 * magic bytes) before trusting it — the agent's claim alone is not
 * evidence. Returns false when the session deps are not wired or the
 * agent reported `NO_PDF`; session errors (timeouts, crashes) propagate
 * as rejections so the caller can log the reason.
 */
export async function downloadPdfViaHiddenCoworkSession(input: {
  pmid: string;
  /** Absolute path the agent must save the PDF to. */
  localPath: string;
  title?: string | null;
  abstractText?: string | null;
  deps: PdfUrlFinderDeps;
  /**
   * Override agent id for the hidden session. Falls back to the global
   * `main` agent when omitted; the auto-advance orchestrator threads an
   * installed-expert id through here so the agent doing the eutils
   * walk + curl is the biology-tuned one when available.
   */
  agentId?: string;
  /**
   * Session-level model override (provider-qualified ref) threaded from
   * `PaperPipelineModelConfig.pipelineModel`. `undefined` keeps the agent's
   * own binding.
   */
  modelOverride?: string;
}): Promise<boolean> {
  const {
    coworkRuntime: runtime,
    coworkStore: store,
    resolveAgentCwd,
  } = input.deps;
  if (!runtime || !store || !resolveAgentCwd) {
    return false;
  }

  const hiddenDeps: HiddenCoworkSessionDeps = {
    runtime,
    store,
    resolveAgentCwd,
    log: input.deps.log,
    // Agents doing real research (eutils elink/esummary → publisher
    // sites) routinely need more than 90s — observed 2026-09-16: a
    // lookup was killed mid-flight at 90s with the URL one step away.
    // The prompt forbids browser tools (headless direct-URL download
    // only), so the agent may need to walk several OA mirrors before a
    // link answers curl — allow the module's full 5-minute cap.
    timeoutMs: 300 * 1000,
  };
  const result = await runTaskHiddenSession(
    input.pmid,
    {
      prompt: buildDownloadPrompt(input),
      agentId: input.agentId ?? 'main',
      modelOverride: input.modelOverride,
    },
    hiddenDeps,
  );
  return result.finalText.includes('DOWNLOADED');
}

function buildDownloadPrompt(input: {
  pmid: string;
  localPath: string;
  title?: string | null;
  abstractText?: string | null;
}): string {
  const title = input.title?.trim();
  const abstract = input.abstractText?.trim();
  const parts: string[] = [
    `请下载 PMID ${input.pmid} 这篇文献的开放获取（open access）PDF 全文，保存到这个绝对路径：`,
    input.localPath,
  ];
  if (title) parts.push(`标题：${title}`);
  if (abstract) parts.push(`摘要：${abstract}`);
  parts.push(
    '重要约束：全程禁止打开浏览器或任何图形界面工具（不要用 computer-use / playwright / 打开窗口）。' +
      '只允许用 curl / wget 等 CLI 工具直接下载 PDF 直链（务必带浏览器 User-Agent，很多站点会拦截非浏览器请求）。',
    '建议步骤：先用 eutils elink（https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=<PMID>&retmode=json）解析 PMC ID，' +
      '再从 pmc.ncbi.nlm.nih.gov / europepmc.org / 期刊官网 / biorxiv / unpaywall（https://api.unpaywall.org/v2/<DOI>?email=test@example.com）等来源找 PDF 直链。',
    '第一个来源找不到可直链下载的 PDF 时不要放弃：按上述来源逐个尝试，直到找到能用 curl 直接下载成功的 PDF 直链为止；' +
      '每个候选 URL 下载后都要验证文件头是 %PDF-（HTML 验证页/拦截页不算成功，换下一个来源）。',
    '注意：',
    `1. 动手前先检查目标路径 ${input.localPath} 是否已有合法 PDF（之前的尝试可能已下载），有就直接回复 DOWNLOADED；`,
    '2. 下载到临时位置（如 /tmp）后必须把文件复制/移动到上面的目标绝对路径，不要留在临时目录；',
    '3. 用 file 命令或文件头（%PDF-）确认下载的是 PDF 而不是 HTML 验证页。',
    '下载完成后只回复一行 DOWNLOADED；所有来源都试过后仍无法公开下载时才回复一行 NO_PDF。不要改动或总结文件内容。',
  );
  return parts.join('\n');
}

/**
 * Extract every distinct http(s) URL from a model reply, in order of
 * appearance. The prompt asks for a single URL, but models routinely
 * answer with prose containing several candidates — sometimes a dead
 * link first and the working one later — so the caller tries them in
 * order until one downloads. Chinese full-width punctuation (，。；：etc.)
 * and trailing sentence punctuation are treated as delimiters — the
 * regex would otherwise swallow the rest of the sentence. Capped so a
 * rambling reply cannot turn into dozens of download attempts.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>，。；：！？、（）【】《》「」『』“”‘’]+/g;

function extractHttpUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;:!?'’]+$/, '');
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls.slice(0, 5);
}

/**
 * Default dependency bundle used by the orchestrator. Reads the token-
 * proxy port lazily and points the hidden-session deps at the production
 * singletons when they are passed in via the service manager. When the
 * main process has not yet wired those (older callers / tests) the
 * hidden-session branch stays disabled.
 */
export function buildDefaultPdfUrlFinderDeps(
  extra?: Pick<PdfUrlFinderDeps, 'coworkRuntime' | 'coworkStore' | 'resolveAgentCwd'>,
): PdfUrlFinderDeps {
  return {
    getTokenProxyPort: () => getOpenClawTokenProxyPort(),
    coworkRuntime: extra?.coworkRuntime,
    coworkStore: extra?.coworkStore,
    resolveAgentCwd: extra?.resolveAgentCwd,
  };
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  const tag = `[PdfUrlFinder] ${message}`;
  if (level === 'error') console.error(tag);
  else if (level === 'warn') console.warn(tag);
  else console.log(tag);
}