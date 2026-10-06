import { net } from 'electron';

import { DEFAULT_PDF_URL_SUGGEST_MODEL } from '../../shared/paperPipeline/constants';
import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import type { CoworkStore } from '../coworkStore';
import { type HiddenCoworkSessionDeps } from '../libs/agentEngine/hiddenCoworkSession';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { getOpenClawTokenProxyPort } from '../libs/openclawTokenProxy';
import { runTaskHiddenSession } from './taskHiddenSession';

/**
 * Phase 6 + 7 LLM-assisted PDF acquisition.
 *
 * When the deterministic EuropePMC / PMC chains fail, LobsterAI can use
 * the same LLM models the user already uses in chat:
 *
 * Strategy priority:
 *   1. {@link findPdfUrl} — compatibility URL suggestion through OpenClaw's
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
  doi?: string | null;
  authors?: PaperTaskAuthor[];
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
  doi?: string | null;
  authors?: PaperTaskAuthor[];
}): string {
  const title = input.title?.trim();
  const abstract = input.abstractText?.trim();
  const parts: string[] = [
    `帮我找一个可直接下载的 PDF URL，文献 PMID 是 ${input.pmid}。`,
  ];
  if (title) parts.push(`标题：${title}`);
  if (abstract) parts.push(`摘要：${abstract}`);
  if (input.doi?.trim()) parts.push(`DOI：${input.doi.trim()}`);
  const authors = (input.authors ?? []).map(author => author.fullName.trim()).filter(Boolean);
  if (authors.length > 0) parts.push(`作者：${authors.slice(0, 3).join('；')}`);
  parts.push(
    '请先自行判断候选地址是否真的对应目标论文，再返回有效的 PDF 直链（https:// 开头，单独一行）；' +
      '如有多个候选，按推荐顺序每行一个；' +
      '不要把期刊落地页、HTML、登录页或搜索结果页当作 PDF 直链；' +
      '如果没有任何可用的公开 PDF，请返回 NO_PDF。程序还会下载文件并核对 PDF 内容与标题、DOI、PMID、作者是否匹配。',
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
  doi?: string | null;
  authors?: PaperTaskAuthor[];
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
  doi?: string | null;
  authors?: PaperTaskAuthor[];
}): string {
  const title = input.title?.trim();
  const abstract = input.abstractText?.trim();
  return [
    '你负责为指定 PMID 查找并下载对应的开放获取 PDF。',
    '',
    `目标 PMID：${input.pmid}（仅作标识，不要根据 PMID 猜测文章内容）`,
    title ? `目标标题：${title}` : '',
    abstract ? `目标摘要：${abstract}` : '',
    input.doi?.trim() ? `目标 DOI：${input.doi.trim()}` : '',
    (input.authors ?? []).length > 0
      ? `目标作者：${input.authors?.slice(0, 3).map(author => author.fullName).join('；')}`
      : '',
    '',
    `最终文件必须保存到：${input.localPath}`,
    '',
    '工作目标：',
    '1. 你必须自己搜索来源、判断候选地址、下载文件，不要只返回 URL。',
    '2. 优先使用 Europe PMC、PMC、Unpaywall、DOI 元数据和期刊提供的公开 PDF 直链。',
    '3. 只能使用静态 HTTP/API 请求和 curl、wget 等 CLI 工具；禁止打开浏览器或任何图形界面。',
    '4. “浏览器 User-Agent”只表示 curl/wget 的 HTTP 请求头，不表示打开浏览器。',
    '5. 遇到登录页、验证码页、HTML 拦截页或需要人工操作的页面，放弃该来源并尝试下一个。',
    '',
    '候选文件验证：',
    '1. HTTP 请求成功，且响应不是 HTML、登录页、验证码页或拦截页。',
    '2. 文件头是 %PDF-，文件大小合理，并且文件可以被 PDF 工具读取。',
    '3. 从 PDF 文本中尽量核对目标标题、PMID、DOI 或作者；无法确认属于目标论文时，不得保存为最终文件。',
    '4. 不要因为 URL 名称包含 pdf、文章标题或 PMID 就认定它是正确文件。',
    '',
    '文件操作：',
    '1. 先下载到临时文件，不要直接覆盖最终文件。',
    '2. 验证通过后，再移动到指定的最终路径。',
    '3. 下载完成后再次检查最终文件确实存在且是有效 PDF。',
    '4. 最多尝试有限数量的公开来源；全部失败后返回 NO_PDF，不要猜测或伪造成功。',
    '',
    '成功后只回复一行 DOWNLOADED；所有来源都无法获得可验证的公开 PDF 时只回复一行 NO_PDF。',
    '不要输出正文，不要修改其他文件。',
  ].filter(Boolean).join('\n');
}
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
