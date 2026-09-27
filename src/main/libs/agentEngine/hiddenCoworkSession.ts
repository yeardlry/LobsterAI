import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import type {
  CoworkMessage,
  CoworkStore,
} from '../../coworkStore';
import type {
  CoworkRuntime,
  PermissionRequest,
} from './types';

/**
 * Phase 7 — one-shot "hidden" Cowork session runner.
 *
 * Spins up an isolated Cowork session from the main process (no UI
 * involvement), drives it through one assistant turn, captures the final
 * text, then tears the session down. The runtime reports `complete` as
 * `(sessionId, runId)` only — final assistant text is reconstructed from
 * the persisted `cowork_messages` rows (filtered to `type === 'assistant'`)
 * after the terminal event fires.
 *
 * Use cases:
 *   - {@link pdfUrlFinder.findPdfUrl} priority-2 fallback: ask a Cowork
 *     agent (with shell / web tools) to actually `curl` the article site
 *     and return a PDF URL when the token-proxy-only path fails.
 *   - Any future "ask the agent X, get text back" main-process need.
 *
 * Why a module and not a `CoworkRuntime` method:
 *   `CoworkRuntime.startSession` only kicks off the turn — it does NOT
 *   await the `complete` / `error` events. The runtime is renderer-stream
 *   oriented. Adding a `runOneShot` method would touch the 12k-line
 *   `OpenClawRuntimeAdapter`. Keeping the lifecycle local here avoids
 *   that blast radius and lets us stub the runtime/store in tests.
 *
 * Permissions:
 *   The runtime has no unattended mode. We auto-approve every
 *   `permissionRequest` so a PDF URL lookup that needs `curl` or `fetch`
 *   tools won't hang. This module is only used by trusted main-process
 *   code paths (paper pipeline, future IM-internal helpers). Do NOT
 *   expose it to user-supplied prompts.
 */
export interface HiddenCoworkSessionDeps {
  /** The Cowork runtime — typically `CoworkEngineRouter` from `main.ts`. */
  runtime: CoworkRuntime;
  /** SQLite-backed store. Must expose `createSession` + `getSession`. */
  store: CoworkStore;
  /**
   * Resolves the default working directory for an agent when the caller
   * does not provide one. Mirrors `resolveAgentDefaultWorkingDirectory`
   * in `src/main/main.ts:2194`. Injected so we don't import `main.ts`.
   */
  resolveAgentCwd: (agentId: string) => string;
  /**
   * Hard ceiling for how long we wait for the turn to terminate.
   * Default: 5 minutes. PDF URL lookups should finish in seconds.
   */
  timeoutMs?: number;
  /** Logger sink; defaults to console. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface HiddenCoworkSessionInput {
  prompt: string;
  /**
   * Continue an existing session instead of creating a fresh one. When the
   * store no longer knows this id (database cleared, different machine) a
   * new session is created transparently. Used by the paper pipeline to
   * keep one session per task across multiple steps (PDF download →
   * article draft → word export) so the agent keeps its context.
   */
  sessionId?: string;
  /** Agent ID to drive. Defaults to `'main'`. */
  agentId?: string;
  /**
   * Session-level model override (provider-qualified ref, e.g.
   * `'deepseek/deepseek-v4-flash'`). `undefined` leaves the session row's
   * override untouched (legacy callers); a string — including `''` —
   * enforces that value, where `''` clears the override so the agent's own
   * binding wins again. The runtime resolves `session.modelOverride ||
   * agent.model` on every turn (openclawRuntimeAdapter.ts:5362).
   */
  modelOverride?: string;
  /**
   * Full title for the created session row (visible in session lists /
   * logs). Defaults to `[hidden] <8-char uuid>`. Callers that know what
   * the session is FOR should pass something identifiable, e.g. the paper
   * pipeline uses `[hidden] PMID {pmid}` so hidden sessions can be told
   * apart in the store. Ignored when continuing an existing session.
   */
  sessionTitle?: string;
  /** Override the agent's default working directory. */
  cwd?: string;
  /** Optional system-prompt injection. */
  systemPrompt?: string;
  /** Skill IDs to load for this session. */
  skillIds?: string[];
  /**
   * Cap on the response time. Overrides the dep-level `timeoutMs`.
   */
  timeoutMs?: number;
}

export interface HiddenCoworkSessionResult {
  sessionId: string;
  finalText: string;
  /** Total assistant messages concatenated (debug aid). */
  segmentCount: number;
}

/**
 * Run a one-shot Cowork session and return its final assistant text.
 * Throws on timeout, error event, or `startSession` failure.
 */
export async function runHiddenCoworkSession(
  input: HiddenCoworkSessionInput,
  deps: HiddenCoworkSessionDeps,
): Promise<HiddenCoworkSessionResult> {
  const log = deps.log ?? defaultLog;
  const timeoutMs = input.timeoutMs ?? deps.timeoutMs ?? 5 * 60 * 1000;
  const agentId = (input.agentId ?? 'main').trim() || 'main';
  const cwd = (input.cwd ?? deps.resolveAgentCwd(agentId)).trim();

  if (!cwd) {
    throw new Error(
      `hiddenCoworkSession: cannot resolve working directory for agent "${agentId}"`,
    );
  }
  // Mirror the IM handler's directory sanity check (imCoworkHandler.ts:342-344).
  // Use sync fs.stat so we don't yield control to the event loop before
  // listeners are registered — otherwise a fast `setImmediate` in tests
  // (and a fast-emit real gateway in production) would race past us.
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
  } catch (err) {
    throw new Error(
      `hiddenCoworkSession: working directory not accessible (${cwd}): ${
        err instanceof Error ? err.message : 'unknown'
      }`,
    );
  }

  // 1) Resolve the session. When the caller passes a live `sessionId` we
  //    continue it (the agent keeps its conversation history); otherwise
  //    pre-create the SQLite row — the runtime throws if the row is
  //    missing (openclawRuntimeAdapter.ts:5270).
  let sessionId = input.sessionId?.trim() ?? '';
  let reused = false;
  let priorMessageCount = 0;
  if (sessionId) {
    const existing = deps.store.getSession(sessionId);
    if (existing) {
      reused = true;
      priorMessageCount = existing.messages?.length ?? 0;
      log(
        'info',
        `hiddenCoworkSession: continuing session ${sessionId} (${priorMessageCount} prior message(s))`,
      );
      // Pooled sessions persist across steps, so a config change made
      // between steps must re-apply here — the runtime re-reads the
      // override every turn, and `updateSession` whitelists the field.
      if (
        input.modelOverride !== undefined
        && existing.modelOverride !== input.modelOverride
      ) {
        deps.store.updateSession(sessionId, { modelOverride: input.modelOverride });
        log(
          'info',
          `hiddenCoworkSession: session ${sessionId} model override updated to "${input.modelOverride || '(cleared)'}"`,
        );
      }
    } else {
      // Stale id — the store no longer knows this session. Fall through
      // to creating a fresh one rather than failing the whole step.
      log('warn', `hiddenCoworkSession: session ${sessionId} not found in store, creating a new one`);
      sessionId = '';
    }
  }
  if (!reused) {
    const title = (input.sessionTitle ?? '').trim() || `[hidden] ${randomUUID().slice(0, 8)}`;
    const session = deps.store.createSession(
      title,
      cwd,
      input.systemPrompt ?? '',
      'local',
      input.skillIds ?? [],
      agentId,
      input.modelOverride ?? '',
    );
    sessionId = session.id;
    log('info', `hiddenCoworkSession: created session ${sessionId} (${title})`);
  }

  // 2) Drive one turn. Prefer the persisted message rows (sliced to this
  //    turn) for the final text; fall back to streaming capture when the
  //    store slice comes up empty — which it does for CONTINUED sessions
  //    (observed in production 2026-09-17: every continued turn reports
  //    0 new segments because the adapter's history sync rewrites the row).
  //
  //    Streaming capture must listen to BOTH `message` and `messageUpdate`:
  //    the adapter creates the assistant row with its first chunk
  //    (`message`) and finalizes the content via `messageUpdate`. Listening
  //    to `message` alone captured only that first chunk — observed as 3-8
  //    char fragments ("CAT" for a `CATEGORIES: …` reply, an 8-char slice
  //    of a download report) that broke the callers' DONE / DOWNLOADED
  //    detection.
  const turnPromise = new Promise<HiddenCoworkSessionResult>((resolve, reject) => {
    let lastAssistantMessageId: string | null = null;
    let lastAssistantText = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        deps.runtime.off('message', onMessage);
        deps.runtime.off('messageUpdate', onMessageUpdate);
        deps.runtime.off('complete', onComplete);
        deps.runtime.off('error', onError);
        deps.runtime.off('permissionRequest', onPermission);
      } catch {
        /* runtime may have been disposed — best effort */
      }
      fn();
    };

    const onMessage = (_id: string, message: CoworkMessage) => {
      if (message.type === 'assistant') {
        lastAssistantMessageId = message.id;
        lastAssistantText = message.content;
      }
    };
    const onMessageUpdate = (_id: string, messageId: string, content: string) => {
      if (messageId && messageId === lastAssistantMessageId) {
        lastAssistantText = content;
      }
    };
    const onComplete = () => {
      const sessionRow = deps.store.getSession(sessionId);
      // For a continued session, only the messages appended by THIS turn
      // count — prior turns were already returned by their own runs.
      const segments = (sessionRow?.messages ?? [])
        .slice(priorMessageCount)
        .filter(m => m.type === 'assistant')
        .map(m => m.content);
      const finalText = segments.join('\n\n').trim() || lastAssistantText.trim();
      settle(() =>
        resolve({
          sessionId,
          finalText,
          segmentCount: segments.length,
        }),
      );
    };
    const onError = (_id: string, err: string) => {
      settle(() => reject(new Error(`hiddenCoworkSession failed: ${err}`)));
    };
    const onPermission = (_id: string, req: PermissionRequest) => {
      // Auto-approve so curl / fetch tools don't block. Only safe because
      // the prompt here is constructed by trusted LobsterAI code, not by
      // user input. See module-level doc for the threat model.
      deps.runtime.respondToPermission(req.requestId, { behavior: 'allow' });
    };

    deps.runtime.on('message', onMessage);
    deps.runtime.on('messageUpdate', onMessageUpdate);
    deps.runtime.on('complete', onComplete);
    deps.runtime.on('error', onError);
    deps.runtime.on('permissionRequest', onPermission);

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `hiddenCoworkSession timed out after ${timeoutMs}ms (sessionId=${sessionId})`,
          ),
        ),
      );
    }, timeoutMs);

    const start = reused
      ? deps.runtime.continueSession(sessionId, input.prompt, {
        systemPrompt: input.systemPrompt,
        skillIds: input.skillIds,
      })
      : deps.runtime.startSession(sessionId, input.prompt, {
        agentId,
        confirmationMode: 'text',
        systemPrompt: input.systemPrompt,
        skillIds: input.skillIds,
      });
    start.catch(err => {
      settle(() =>
        reject(
          err instanceof Error
            ? err
            : new Error(`hiddenCoworkSession ${reused ? 'continueSession' : 'startSession'} rejected: ${String(err)}`),
        ),
      );
    });
  });

  // 3) Stop the session. Safe to call after `complete`/`error` — it
  //    becomes a near no-op but still flips status to 'idle' and clears
  //    pending approvals (openclawRuntimeAdapter.ts:4992-5025).
  //
  // Wrap in try/finally so a timeout / error still tears the in-memory
  // session down. Without this an unfinished ActiveTurn would linger
  // until the next gateway restart.
  let result: HiddenCoworkSessionResult;
  try {
    result = await turnPromise;
  } finally {
    try {
      deps.runtime.stopSession(sessionId);
    } catch (err) {
      log(
        'warn',
        `hiddenCoworkSession: stopSession threw for ${sessionId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  log(
    'info',
    `hiddenCoworkSession: session ${sessionId} produced ${result.segmentCount} assistant segment(s), ${result.finalText.length} chars`,
  );
  return result;
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  // Module-tagged so it joins the existing log convention in `paperPipelineService`.
  const tag = `[HiddenCoworkSession] ${message}`;
  if (level === 'error') console.error(tag);
  else if (level === 'warn') console.warn(tag);
  else console.log(tag);
}