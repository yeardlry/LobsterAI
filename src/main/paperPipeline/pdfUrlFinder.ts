import { net } from 'electron';

import type { CoworkStore } from '../coworkStore';
import {
  type HiddenCoworkSessionDeps,
  runHiddenCoworkSession,
} from '../libs/agentEngine/hiddenCoworkSession';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { getOpenClawTokenProxyPort } from '../libs/openclawTokenProxy';

/**
 * Phase 6 + 7 PDF URL finder.
 *
 * When the deterministic EuropePMC / PMC chains fail, LobsterAI falls back
 * to asking the same LLM models the user already uses in chat to locate a
 * public PDF URL. We do **not** download the PDF here — we only ask the
 * model to give us a URL, then the orchestrator's `downloadPdf` step does
 * the actual HTTP fetch (so the same caching / size guards apply).
 *
 * Strategy priority:
 *   1. {@link findPdfUrlViaTokenProxy} — direct chat completion against
 *      OpenClaw's local token-proxy port. Always available when OpenClaw
 *      is running; lightweight, no agent orchestration.
 *   2. {@link findPdfUrlViaHiddenCoworkSession} (Phase 7) — spin up an
 *      isolated Cowork session from the main process via
 *      `hiddenCoworkSession.runHiddenCoworkSession(...)`. The agent can
 *      actually run tools (curl / fetch) to track down the PDF. Auto-
 *      approved permission requests keep the run unattended.
 *
 * If both fail the orchestrator catches the error and asks the backend
 * to mark the task `failed`. The user can `Reset` it once a workaround
 * is available.
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
}): Promise<string | null> {
  const log = input.deps.log ?? defaultLog;
  const prompt = buildPrompt(input);

  // Priority 1: token-proxy LLM.
  try {
    const viaProxy = await findPdfUrlViaTokenProxy(prompt, input.deps);
    if (viaProxy) return viaProxy;
  } catch (err) {
    log(
      'warn',
      `token-proxy strategy failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  // Priority 2: hidden Cowork session (Phase 7).
  if (
    input.deps.coworkRuntime &&
    input.deps.coworkStore &&
    input.deps.resolveAgentCwd
  ) {
    try {
      const viaSession = await findPdfUrlViaHiddenCoworkSession(prompt, input.deps);
      if (viaSession) return viaSession;
    } catch (err) {
      log(
        'warn',
        `hidden-session strategy failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  return null;
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
    '请只返回一行，以 https:// 开头，且是一个有效的 PDF 直链；' +
      '如果没有任何可用的公开 PDF，请返回 NO_PDF。',
  );
  return parts.join('\n');
}

/**
 * Token-proxy fallback — calls OpenClaw's local chat completion endpoint
 * with a one-shot prompt and parses the first URL out of the response.
 */
async function findPdfUrlViaTokenProxy(
  prompt: string,
  deps: PdfUrlFinderDeps,
): Promise<string | null> {
  const port = deps.getTokenProxyPort();
  if (port === null) {
    throw new Error('token proxy is not running');
  }
  const response = await net.fetch(
    `http://127.0.0.1:${port}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'lobsterai-server/deepseek-v4-flash',
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
  return extractFirstUrl(content);
}

/**
 * Phase 7 — drive a hidden Cowork session and parse the first URL out of
 * the final assistant text. Re-uses the lifecycle helpers in
 * `hiddenCoworkSession.ts` so permission auto-approval, listener cleanup,
 * and timeout handling are uniform across the paper pipeline.
 */
async function findPdfUrlViaHiddenCoworkSession(
  prompt: string,
  deps: PdfUrlFinderDeps,
): Promise<string | null> {
  // The runtime/store/cwd resolver are checked at the call site already.
  const runtime = deps.coworkRuntime!;
  const store = deps.coworkStore!;
  const resolveAgentCwd = deps.resolveAgentCwd!;

  const hiddenDeps: HiddenCoworkSessionDeps = {
    runtime,
    store,
    resolveAgentCwd,
    log: deps.log,
    // PDF lookups should finish well under the default 5-minute cap, but
    // we still cap at 90s so a hung agent doesn't park the paper pipeline.
    timeoutMs: 90 * 1000,
  };
  const result = await runHiddenCoworkSession(
    { prompt, agentId: 'main' },
    hiddenDeps,
  );
  return extractFirstUrl(result.finalText);
}

function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/);
  if (!urlMatch) return null;
  return urlMatch[0];
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