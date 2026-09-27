import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import type { CoworkMessage, CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { runTaskHiddenSession } from './taskHiddenSession';

/**
 * Per-task session pool tests. The harness mirrors the one in
 * `hiddenCoworkSession.test.ts` (EventEmitter-style runtime stub + in-memory
 * store) but drives completion from inside `startSession` / `continueSession`
 * themselves: the listeners are registered before either is called, so a
 * `setImmediate` emit is deterministic without polling.
 *
 * The pool is module-level state keyed by pmid, so each test uses its own
 * pmid to stay isolated.
 */

interface PoolHarness {
  runtime: CoworkRuntime;
  store: CoworkStore;
  emit: (event: string, ...args: unknown[]) => boolean;
  startSessionCalls: string[];
  continueSessionCalls: string[];
  createdSessions: string[];
  /** Titles passed to `createSession`, in creation order. */
  createdTitles: string[];
  /**
   * Replies queued per driven turn (start or continue). Each call shifts the
   * next reply; when a reply is present the fake completes the turn on the
   * next tick, when absent the turn never completes (timeout path).
   */
  replies: string[];
  /** When set, the next `continueSession` call rejects with this error. */
  failNextContinue: Error | null;
}

function buildHarness(): PoolHarness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const startSessionCalls: string[] = [];
  const continueSessionCalls: string[] = [];
  const createdSessions: string[] = [];
  const createdTitles: string[] = [];
  const replies: string[] = [];
  const harness = {} as PoolHarness;

  const on = (event: string, listener: (...args: unknown[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
    return runtime;
  };
  const off = (event: string, listener: (...args: unknown[]) => void) => {
    listeners.get(event)?.delete(listener);
    return runtime;
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
    return true;
  };

  /** Complete one turn: persist an assistant segment, then emit `complete`. */
  const scheduleCompletion = (sessionId: string, text: string) => {
    setImmediate(() => {
      messagesBySession.get(sessionId)!.push({
        id: `m-${createdSessions.length}-${replies.length}`,
        type: 'assistant',
        content: text,
        timestamp: Date.now(),
      });
      emit('complete', sessionId);
    });
  };

  const messagesBySession = new Map<string, CoworkMessage[]>();
  const store = {
    createSession: (title: string) => {
      const id = `sess-${createdSessions.length + 1}`;
      createdSessions.push(id);
      createdTitles.push(title);
      messagesBySession.set(id, []);
      return { id };
    },
    getSession: (sessionId: string) => (
      messagesBySession.has(sessionId)
        ? { messages: messagesBySession.get(sessionId)! }
        : null
    ),
  } as unknown as CoworkStore;

  const runtime = {
    on,
    off,
    startSession: async (sessionId: string) => {
      startSessionCalls.push(sessionId);
      const reply = replies.shift();
      if (reply !== undefined) scheduleCompletion(sessionId, reply);
    },
    continueSession: async (sessionId: string) => {
      continueSessionCalls.push(sessionId);
      if (harness.failNextContinue) {
        const err = harness.failNextContinue;
        harness.failNextContinue = null;
        throw err;
      }
      const reply = replies.shift();
      if (reply !== undefined) scheduleCompletion(sessionId, reply);
    },
    stopSession: () => undefined,
    stopAllSessions: () => undefined,
    respondToPermission: () => undefined,
    isSessionActive: () => true,
    getSessionConfirmationMode: () => 'text',
    onSessionDeleted: () => undefined,
  } as unknown as CoworkRuntime;

  harness.runtime = runtime;
  harness.store = store;
  harness.emit = emit;
  harness.startSessionCalls = startSessionCalls;
  harness.continueSessionCalls = continueSessionCalls;
  harness.createdSessions = createdSessions;
  harness.createdTitles = createdTitles;
  harness.replies = replies;
  harness.failNextContinue = null;
  return harness;
}

describe('runTaskHiddenSession', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'task-session-'));
  });

  test('reuses one session across steps of the same task', async () => {
    const harness = buildHarness();
    const deps = { runtime: harness.runtime, store: harness.store, resolveAgentCwd: () => tmpDir };

    // Step 1 (e.g. PDF download) creates and pools the session.
    harness.replies.push('DOWNLOADED');
    const first = await runTaskHiddenSession('12345', { prompt: 'download' }, deps);
    expect(first.finalText).toBe('DOWNLOADED');
    expect(harness.createdSessions).toHaveLength(1);
    expect(harness.startSessionCalls).toEqual([first.sessionId]);

    // Step 2 (e.g. article draft) continues the SAME session.
    harness.replies.push('DONE');
    const second = await runTaskHiddenSession('12345', { prompt: 'write' }, deps);
    expect(second.sessionId).toBe(first.sessionId);
    // Only THIS turn's text — the prior 'DOWNLOADED' segment belongs to
    // the earlier run and must not leak into finalText.
    expect(second.finalText).toBe('DONE');
    expect(harness.continueSessionCalls).toEqual([first.sessionId]);
    expect(harness.startSessionCalls).toEqual([first.sessionId]);
    expect(harness.createdSessions).toHaveLength(1); // no second session
  });

  test('titles fresh sessions with the pmid so hidden rows are identifiable', async () => {
    // `[hidden] <uuid>` rows are indistinguishable in the store; the pmid
    // title answers "which paper was this session driving" at a glance.
    const harness = buildHarness();
    const deps = { runtime: harness.runtime, store: harness.store, resolveAgentCwd: () => tmpDir };

    harness.replies.push('DOWNLOADED');
    await runTaskHiddenSession('39106599', { prompt: 'download' }, deps);
    expect(harness.createdTitles).toEqual(['[hidden] PMID 39106599']);
  });

  test('retries once on a fresh session when the pooled session is dead', async () => {
    const harness = buildHarness();
    const deps = { runtime: harness.runtime, store: harness.store, resolveAgentCwd: () => tmpDir };

    // Prime the pool with a first successful step.
    harness.replies.push('ok');
    const first = await runTaskHiddenSession('777', { prompt: 'a' }, deps);

    // Gateway restarted: the pooled session rejects on continue.
    harness.failNextContinue = new Error('session not found on gateway');
    harness.replies.push('recovered');
    const second = await runTaskHiddenSession('777', { prompt: 'b' }, deps);

    expect(second.finalText).toBe('recovered');
    expect(harness.continueSessionCalls).toEqual([first.sessionId]);
    expect(harness.startSessionCalls).toEqual([first.sessionId, second.sessionId]);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(harness.createdSessions).toHaveLength(2);

    // The pool now tracks the fresh session: the next step continues it.
    harness.replies.push('next');
    const third = await runTaskHiddenSession('777', { prompt: 'c' }, deps);
    expect(third.sessionId).toBe(second.sessionId);
  });

  test('does not retry after a timeout', async () => {
    const harness = buildHarness();
    const deps = { runtime: harness.runtime, store: harness.store, resolveAgentCwd: () => tmpDir };

    // Prime the pool.
    harness.replies.push('ok');
    const first = await runTaskHiddenSession('999', { prompt: 'a' }, deps);

    // Second step times out: the continue turn never completes.
    await expect(
      runTaskHiddenSession('999', { prompt: 'b', timeoutMs: 30 }, deps),
    ).rejects.toThrow(/timed out/);

    // No fresh retry: still exactly one session, one startSession.
    expect(harness.startSessionCalls).toEqual([first.sessionId]);
    expect(harness.continueSessionCalls).toEqual([first.sessionId]);
    expect(harness.createdSessions).toHaveLength(1);
  });
});

/**
 * Agent-lookup tests for the "生物研究" expert auto-detect (2026-09-19).
 * Each test builds a tiny in-memory CoworkStore-like object exposing just
 * `listAgents()` — the helper never touches any other store API.
 */
describe('findPipelineExpertAgentId', () => {
  function buildStore(agents: Array<{
    id: string;
    name: string;
    enabled?: boolean;
  }>): { listAgents: () => Array<{ id: string; name: string; enabled: boolean }> } {
    return {
      listAgents: () =>
        agents.map(a => ({
          id: a.id,
          name: a.name,
          enabled: a.enabled ?? true,
        })),
    };
  }

  test('returns null when the store is missing', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(findPipelineExpertAgentId(null)).toBeNull();
    expect(findPipelineExpertAgentId(undefined)).toBeNull();
  });

  test('returns null when no agents are installed', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(findPipelineExpertAgentId(buildStore([]))).toBeNull();
  });

  test('matches the Chinese alias "生物研究"', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(buildStore([{ id: 'bio-agent', name: '生物研究' }])),
    ).toBe('bio-agent');
  });

  test('matches the English alias "Biological Research"', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(
        buildStore([{ id: 'bio-en', name: 'Biological Research' }]),
      ),
    ).toBe('bio-en');
  });

  test('ignores leading/trailing whitespace and case differences', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(buildStore([{ id: 'a', name: '  生物研究  ' }])),
    ).toBe('a');
    expect(
      findPipelineExpertAgentId(buildStore([{ id: 'b', name: 'biological research' }])),
    ).toBe('b');
  });

  test('skips disabled expert agents even when the name matches', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(
        buildStore([{ id: 'bio', name: '生物研究', enabled: false }]),
      ),
    ).toBeNull();
  });

  test('returns null when nothing matches but other agents exist', async () => {
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(
        buildStore([
          { id: 'stock', name: '股票助手' },
          { id: 'lesson', name: 'Lesson Planner' },
        ]),
      ),
    ).toBeNull();
  });

  test('does not fuzzy-match overlapping names', async () => {
    // "生物研究助手" is NOT in the alias list — exact (trim/case-insensitive)
    // match only, so it must not be hijacked.
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(
        buildStore([{ id: 'overlap', name: '生物研究助手' }]),
      ),
    ).toBeNull();
  });

  test('returns the first match when the user has the expert installed twice', async () => {
    // Defensive: listAgents order is stable in practice (DB sort_order) but
    // the contract here is "first match wins" — make it explicit so a
    // future reordering does not silently switch the agent the pipeline
    // uses.
    const { findPipelineExpertAgentId } = await import('./taskHiddenSession');
    expect(
      findPipelineExpertAgentId(
        buildStore([
          { id: 'first', name: '生物研究' },
          { id: 'second', name: '生物研究' },
        ]),
      ),
    ).toBe('first');
  });
});
