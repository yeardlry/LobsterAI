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
  /** Agent ID to drive. Defaults to `'main'`. */
  agentId?: string;
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

  // 1) Pre-create the SQLite row. The runtime throws if the row is
  //    missing (openclawRuntimeAdapter.ts:5270).
  const session = deps.store.createSession(
    `[hidden] ${randomUUID().slice(0, 8)}`,
    cwd,
    input.systemPrompt ?? '',
    'local',
    input.skillIds ?? [],
    agentId,
  );
  const sessionId = session.id;
  log('info', `hiddenCoworkSession: created session ${sessionId}`);

  // 2) Drive one turn. Capture last assistant text via the runtime
  //    `message` event; fall back to reading persisted messages after
  //    `complete` so we cover the segment-after-tool-call case too.
  const turnPromise = new Promise<HiddenCoworkSessionResult>((resolve, reject) => {
    let lastAssistant = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        deps.runtime.off('message', onMessage);
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
        lastAssistant = message.content;
      }
    };
    const onComplete = () => {
      const sessionRow = deps.store.getSession(sessionId);
      const segments = (sessionRow?.messages ?? [])
        .filter(m => m.type === 'assistant')
        .map(m => m.content);
      const finalText = segments.join('\n\n').trim() || lastAssistant;
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

    deps.runtime
      .startSession(sessionId, input.prompt, {
        agentId,
        confirmationMode: 'text',
        systemPrompt: input.systemPrompt,
        skillIds: input.skillIds,
      })
      .catch(err => {
        settle(() =>
          reject(
            err instanceof Error
              ? err
              : new Error(`hiddenCoworkSession startSession rejected: ${String(err)}`),
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