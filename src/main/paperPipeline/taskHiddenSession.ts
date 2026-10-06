import type { Agent, CoworkStore } from '../coworkStore';
import {
  type HiddenCoworkSessionDeps,
  type HiddenCoworkSessionInput,
  type HiddenCoworkSessionResult,
  runHiddenCoworkSession,
} from '../libs/agentEngine/hiddenCoworkSession';
import type { CoworkRuntime } from '../libs/agentEngine/types';

/**
 * Optional Cowork-session deps shared by the LLM-driven pipeline steps
 * (analysis, categorization, PDF download, WeChat draft). Structurally
 * satisfied by `PdfUrlFinderDeps` and `WechatDraftDeps`, so the orchestrator
 * can pass one bundle everywhere.
 */
export interface TaskSessionDeps {
  coworkRuntime?: CoworkRuntime | null;
  coworkStore?: CoworkStore | null;
  resolveAgentCwd?: ((agentId: string) => string) | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Resolve the optional trio into concrete hidden-session deps. Returns null
 * when any piece is missing — callers treat that as "LLM path unavailable"
 * and run their deterministic fallback instead.
 */
export function resolveTaskSessionDeps(
  deps: TaskSessionDeps | null | undefined,
): HiddenCoworkSessionDeps | null {
  const { coworkRuntime, coworkStore, resolveAgentCwd } = deps ?? {};
  if (!coworkRuntime || !coworkStore || !resolveAgentCwd) return null;
  return { runtime: coworkRuntime, store: coworkStore, resolveAgentCwd, log: deps?.log };
}

/**
 * Per-task hidden-session pool (keyed by pmid).
 *
 * A paper task drives several hidden sessions in sequence — PDF download,
 * article generation, word export — and re-running a step (or resetting a
 * failed task) drives more. Without pooling every step starts from zero:
 * the agent re-reads the PDF, re-resolves the PMC id, re-discovers the
 * article. Pooling keeps ONE session per pmid so each step continues with
 * the previous steps' context, exactly like a user following up in the
 * same chat.
 *
 * Failure policy: when a pooled session turns out to be dead (gateway
 * restarted and lost it, store cleared, ...), the mapping is dropped and
 * the step is retried once on a fresh session — except on timeouts, where
 * a retry would only duplicate the wait.
 *
 * The pool is in-memory main-process state: an app restart starts fresh
 * sessions, which is fine (the agent re-primes from the local PDF/XML
 * cache, and stale ids are handled by the retry above).
 */
const taskSessionIds = new Map<string, string>();

/** Run one hidden-session turn, continuing the task's pooled session. */
export async function runTaskHiddenSession(
  pmid: string,
  input: HiddenCoworkSessionInput,
  deps: HiddenCoworkSessionDeps,
): Promise<HiddenCoworkSessionResult> {
  const existing = taskSessionIds.get(pmid);
  if (existing) {
    try {
      const result = await runHiddenCoworkSession({ ...input, sessionId: existing }, deps);
      taskSessionIds.set(pmid, result.sessionId);
      return result;
    } catch (err) {
      taskSessionIds.delete(pmid);
      if (err instanceof Error && err.message.includes('timed out')) {
        // Timeout means the agent was working but too slowly — a fresh
        // session would redo the same work. Let the caller's fallback run.
        throw err;
      }
      // Anything else (dead session, gateway hiccup) — retry once fresh.
    }
  }
  // Identify the hidden session by its paper task — `[hidden] <uuid>` rows
  // are indistinguishable in the store; the pmid title makes debugging
  // "which paper was this session driving" trivial.
  const result = await runHiddenCoworkSession(
    { ...input, sessionTitle: input.sessionTitle ?? `[hidden] PMID ${pmid}` },
    deps,
  );
  taskSessionIds.set(pmid, result.sessionId);
  return result;
}

/** Drop the pooled session for a task (e.g. after the task is completed). */
export function clearTaskHiddenSession(pmid: string): void {
  taskSessionIds.delete(pmid);
}

/** Stop the active pooled session for a task, if one exists. */
export function stopTaskHiddenSession(pmid: string, runtime: CoworkRuntime): boolean {
  const sessionId = taskSessionIds.get(pmid);
  if (!sessionId) return false;
  taskSessionIds.delete(pmid);
  try {
    runtime.stopSession(sessionId);
  } catch {
    // The runner's finally block also performs best-effort cleanup.
  }
  return true;
}

/**
 * Pipeline-wide expert agent aliases. Matched case-insensitively against an
 * Agent's `name`. Keep this list short — only products the user has
 * explicitly opted into by installing under 专家套件 → 已安装.
 *
 * The default paper-pipeline LLM driver is the global `main` agent; when a
 * matched expert is installed we let it own every hidden-session turn so
 * its system prompt / skills (e.g. biology tools, web-search filters) shape
 * the categorisation, analysis, download, conversion, and WeChat draft.
 *
 * We do NOT add a corresponding preset in `presetAgents.ts`: this is a
 * matcher for whatever the user has chosen to install, not a product the
 * app actively distributes.
 */
export const PIPELINE_EXPERT_AGENT_ALIASES: readonly string[] = [
  '生物研究',
  'Biological Research',
];

/**
 * Look up an installed expert agent for the paper pipeline. Returns the
 * agent id or null when nothing matches.
 *
 * - Only considers `enabled` agents (a user who disabled the expert has
 *   opted out — silently ignoring that would be surprising).
 * - Case-insensitive exact-name match against
 *   {@link PIPELINE_EXPERT_AGENT_ALIASES} (after trim). Deliberately NOT
 *   fuzzy: a user whose agent name merely overlaps (e.g. an agent
 *   literally called "生物研究助手") would otherwise be hijacked without
 *   a visible signal.
 * - Missing store ⇒ null (the orchestrator treats that as "fall back to
 *   `main`"); never throws.
 */
export function findPipelineExpertAgentId(
  store: CoworkStore | null | undefined,
): string | null {
  if (!store) return null;
  const aliases = new Set(
    PIPELINE_EXPERT_AGENT_ALIASES.map(alias => alias.trim().toLowerCase()),
  );
  const agents: Agent[] =
    typeof (store as { listAgents?: () => unknown }).listAgents === 'function'
      ? ((store as { listAgents: () => Agent[] }).listAgents())
      : [];
  for (const agent of agents) {
    if (!agent.enabled) continue;
    if (aliases.has(agent.name.trim().toLowerCase())) return agent.id;
  }
  return null;
}
