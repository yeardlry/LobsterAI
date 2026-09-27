import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import type {
  CoworkMessage,
  CoworkStore,
} from '../../coworkStore';
import type {
  CoworkRuntime,
  PermissionRequest,
} from './types';

/**
 * Phase 7 — `hiddenCoworkSession` lifecycle tests.
 *
 * These verify the small but real surface that the orchestrator relies on:
 *   - the session row is created up front,
 *   - the runtime gets `startSession(sessionId, prompt, options)`,
 *   - permission requests are auto-approved,
 *   - terminal events (complete / error / timeout) settle the result,
 *   - listeners are removed and `stopSession` is called.
 *
 * The runtime is a hand-rolled EventEmitter stub — the only methods the
 * module touches are `on`, `off`, `startSession`, `respondToPermission`,
 * and `stopSession`.
 */

interface FakeRuntime extends CoworkRuntime {
  emit: (event: string, ...args: unknown[]) => boolean;
}

interface FakeRuntimeHarness {
  runtime: FakeRuntime;
  emit: (event: string, ...args: unknown[]) => boolean;
  startSessionCalls: Array<{
    sessionId: string;
    prompt: string;
    options?: unknown;
  }>;
  continueSessionCalls: Array<{
    sessionId: string;
    prompt: string;
    options?: unknown;
  }>;
  respondToPermissionCalls: Array<{ requestId: string; result: unknown }>;
  stopSessionCalls: string[];
}

function buildFakeRuntime(): FakeRuntimeHarness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const startSessionCalls: Array<{ sessionId: string; prompt: string; options?: unknown }> = [];
  const continueSessionCalls: Array<{ sessionId: string; prompt: string; options?: unknown }> = [];
  const respondToPermissionCalls: Array<{ requestId: string; result: unknown }> = [];
  const stopSessionCalls: string[] = [];

  const on = (event: string, listener: (...args: unknown[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
    return runtime;
  };
  const off = (event: string, listener: (...args: unknown[]) => void) => {
    listeners.get(event)?.delete(listener);
    return runtime;
  };
  const startSession = async (
    sessionId: string,
    prompt: string,
    options?: unknown,
  ) => {
    startSessionCalls.push({ sessionId, prompt, options });
  };
  const continueSession = async (
    sessionId: string,
    prompt: string,
    options?: unknown,
  ) => {
    continueSessionCalls.push({ sessionId, prompt, options });
  };
  const respondToPermission = (requestId: string, result: unknown) => {
    respondToPermissionCalls.push({ requestId, result });
  };
  const stopSession = (sessionId: string) => {
    stopSessionCalls.push(sessionId);
  };
  const emit = (event: string, ...args: unknown[]) => {
    const set = listeners.get(event);
    if (!set) return false;
    for (const listener of set) {
      listener(...args);
    }
    return true;
  };
  const runtime: FakeRuntime = {
    on,
    off,
    startSession,
    continueSession,
    stopSession,
    stopAllSessions: () => undefined,
    respondToPermission,
    isSessionActive: () => true,
    getSessionConfirmationMode: () => 'text',
    onSessionDeleted: () => undefined,
    emit,
  };
  return {
    runtime,
    emit,
    startSessionCalls,
    continueSessionCalls,
    respondToPermissionCalls,
    stopSessionCalls,
  };
}

interface FakeStoreHarness {
  store: CoworkStore;
  created: Array<{
    title: string;
    cwd: string;
    systemPrompt: string;
    executionMode: string;
    activeSkillIds: string[];
    agentId: string;
    /** 7th `createSession` arg — the enforced session model override. */
    modelOverride: string;
    id: string;
  }>;
  /** Live per-session `modelOverride` value, as `updateSession` mutates it. */
  modelOverrideBySession: Map<string, string>;
  updated: Array<{ sessionId: string; patch: Record<string, unknown> }>;
  messageBySession: Map<string, CoworkMessage[]>;
}

function buildFakeStore(): FakeStoreHarness {
  const created: FakeStoreHarness['created'] = [];
  const modelOverrideBySession = new Map<string, string>();
  const updated: FakeStoreHarness['updated'] = [];
  const messageBySession = new Map<string, CoworkMessage[]>();
  let nextId = 0;
  const store = {
    createSession: (
      title: string,
      cwd: string,
      systemPrompt: string,
      executionMode: string,
      activeSkillIds: string[],
      agentId: string,
      modelOverride?: string,
    ) => {
      nextId += 1;
      const id = `sess-${nextId}`;
      created.push({
        title,
        cwd,
        systemPrompt,
        executionMode,
        activeSkillIds,
        agentId,
        modelOverride: modelOverride ?? '',
        id,
      });
      modelOverrideBySession.set(id, modelOverride ?? '');
      messageBySession.set(id, []);
      return { id };
    },
    // Unknown ids return null so a stale `sessionId` falls back to
    // creating a fresh session (mirrors the real store).
    getSession: (sessionId: string) => (
      messageBySession.has(sessionId)
        ? {
            messages: messageBySession.get(sessionId)!,
            modelOverride: modelOverrideBySession.get(sessionId) ?? '',
          }
        : null
    ),
    updateSession: (sessionId: string, patch: Record<string, unknown>) => {
      updated.push({ sessionId, patch });
      if (patch && typeof patch.modelOverride === 'string') {
        modelOverrideBySession.set(sessionId, patch.modelOverride);
      }
    },
  } as unknown as CoworkStore;
  return { store, created, modelOverrideBySession, updated, messageBySession };
}

describe('runHiddenCoworkSession', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hidden-cowork-'));
  });

  test('creates a session row, drives one turn, returns captured text', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      fake.messageBySession.set('sess-1', [
        {
          id: 'm1',
          type: 'assistant',
          content: 'Looking at EuropePMC...',
          timestamp: 1,
        },
        {
          id: 'm2',
          type: 'assistant',
          content: 'PDF: https://example.com/article.pdf',
          timestamp: 2,
          metadata: { isFinal: true },
        },
      ]);
      runtime.emit('message', 'sess-1', fake.messageBySession.get('sess-1')![1], undefined);
      runtime.emit('complete', 'sess-1', 'run-uuid');
    });

    const result = await runHiddenCoworkSession(
      { prompt: 'find a PDF' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(result.finalText).toBe(
      'Looking at EuropePMC...\n\nPDF: https://example.com/article.pdf',
    );
    expect(result.segmentCount).toBe(2);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].cwd).toBe(tmpDir);
    expect(fake.created[0].agentId).toBe('main');
    expect(runtime.startSessionCalls).toHaveLength(1);
    expect(runtime.startSessionCalls[0].sessionId).toBe('sess-1');
    expect(runtime.startSessionCalls[0].prompt).toBe('find a PDF');
    expect(runtime.stopSessionCalls).toEqual(['sess-1']);
  });

  test('uses sessionTitle when provided, uuid fallback otherwise', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      runtime.emit('complete', 'sess-1', 'run-uuid');
    });
    await runHiddenCoworkSession(
      { prompt: 'p', sessionTitle: '[hidden] PMID 39106599' },
      { runtime: runtime.runtime, store: fake.store, resolveAgentCwd: () => tmpDir },
    );
    expect(fake.created[0].title).toBe('[hidden] PMID 39106599');

    // No sessionTitle → legacy `[hidden] <8-hex>` shape.
    const runtime2 = buildFakeRuntime();
    const fake2 = buildFakeStore();
    setImmediate(() => {
      runtime2.emit('complete', 'sess-1', 'run-uuid');
    });
    await runHiddenCoworkSession(
      { prompt: 'p' },
      { runtime: runtime2.runtime, store: fake2.store, resolveAgentCwd: () => tmpDir },
    );
    expect(fake2.created[0].title).toMatch(/^\[hidden\] [0-9a-f]{8}$/);
  });

  test('auto-approves permissionRequest so curl-style tools do not block', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      const req = {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'curl https://example.com/article.pdf' },
      } as PermissionRequest;
      runtime.emit('permissionRequest', 'sess-1', req);
      runtime.emit('complete', 'sess-1', 'run-uuid');
    });

    const result = await runHiddenCoworkSession(
      { prompt: 'p' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(result.finalText).toBe('');
    expect(runtime.respondToPermissionCalls).toEqual([
      { requestId: 'req-1', result: { behavior: 'allow' } },
    ]);
  });

  test('rejects on `error` event with the runtime message', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      runtime.emit('error', 'sess-1', 'gateway died');
    });

    await expect(
      runHiddenCoworkSession(
        { prompt: 'p' },
        {
          runtime: runtime.runtime,
          store: fake.store,
          resolveAgentCwd: () => tmpDir,
        },
      ),
    ).rejects.toThrow(/gateway died/);
  });

  test('rejects on timeout and stops the session', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    await expect(
      runHiddenCoworkSession(
        { prompt: 'p', timeoutMs: 50 },
        {
          runtime: runtime.runtime,
          store: fake.store,
          resolveAgentCwd: () => tmpDir,
        },
      ),
    ).rejects.toThrow(/timed out/);

    expect(runtime.stopSessionCalls).toContain('sess-1');
  });

  test('refuses to start when the agent working directory is missing', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    await expect(
      runHiddenCoworkSession(
        { prompt: 'p' },
        {
          runtime: runtime.runtime,
          store: fake.store,
          resolveAgentCwd: () => '/nonexistent-cwd-please',
        },
      ),
    ).rejects.toThrow(/working directory not accessible/);
    expect(runtime.startSessionCalls).toHaveLength(0);
  });

  test('continues an existing session: no createSession, only this turn\'s text', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    // A pooled session from a previous step, already holding the prior
    // turn's assistant messages.
    fake.messageBySession.set('task-1', [
      { id: 'm1', type: 'user', content: 'download the pdf', timestamp: 1 },
      { id: 'm2', type: 'assistant', content: 'DOWNLOADED', timestamp: 2 },
    ]);

    setImmediate(() => {
      fake.messageBySession.get('task-1')!.push(
        { id: 'm3', type: 'user', content: 'write the article', timestamp: 3 },
        { id: 'm4', type: 'assistant', content: 'DONE', timestamp: 4 },
      );
      runtime.emit('complete', 'task-1', 'run-uuid');
    });

    const result = await runHiddenCoworkSession(
      { prompt: 'write the article', sessionId: 'task-1' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(result.sessionId).toBe('task-1');
    // Only THIS turn's assistant text — the prior 'DOWNLOADED' segment
    // belongs to the earlier run and must not leak into finalText.
    expect(result.finalText).toBe('DONE');
    expect(result.segmentCount).toBe(1);
    expect(fake.created).toHaveLength(0);
    expect(runtime.startSessionCalls).toHaveLength(0);
    expect(runtime.continueSessionCalls).toHaveLength(1);
    expect(runtime.continueSessionCalls[0]).toMatchObject({
      sessionId: 'task-1',
      prompt: 'write the article',
    });
    expect(runtime.stopSessionCalls).toEqual(['task-1']);
  });

  test('falls back to a fresh session when the passed sessionId is unknown', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      fake.messageBySession.set('sess-1', [
        { id: 'm1', type: 'assistant', content: 'fresh start', timestamp: 1 },
      ]);
      runtime.emit('complete', 'sess-1', 'run-uuid');
    });

    const result = await runHiddenCoworkSession(
      { prompt: 'p', sessionId: 'gone-with-the-gateway' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(result.sessionId).toBe('sess-1');
    expect(result.finalText).toBe('fresh start');
    expect(fake.created).toHaveLength(1);
    expect(runtime.startSessionCalls).toHaveLength(1);
    expect(runtime.continueSessionCalls).toHaveLength(0);
  });

  test('streamed replies are finalized via messageUpdate, not just the first chunk', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    // Continued-session shape (observed in production 2026-09-17): the
    // store row does not grow during the turn, so finalText must come from
    // the streaming capture. The adapter emits the assistant row with its
    // FIRST chunk via `message` and the full text via `messageUpdate` —
    // listening to `message` alone captured 'CAT' for a CATEGORIES reply.
    fake.messageBySession.set('task-1', [
      { id: 'm1', type: 'user', content: 'pick categories', timestamp: 1 },
      { id: 'm2', type: 'assistant', content: 'prior turn', timestamp: 2 },
    ]);

    setImmediate(() => {
      runtime.emit('message', 'task-1', {
        id: 'm-stream',
        type: 'assistant',
        content: 'CAT',
        timestamp: 3,
      });
      runtime.emit(
        'messageUpdate',
        'task-1',
        'm-stream',
        'CATEGORIES: 1, 2\nTAGS: 10',
      );
      runtime.emit('complete', 'task-1', 'run-uuid');
    });

    const result = await runHiddenCoworkSession(
      { prompt: 'pick categories', sessionId: 'task-1' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(result.finalText).toBe('CATEGORIES: 1, 2\nTAGS: 10');
  });

  test('passes modelOverride as the 7th createSession arg on the create path', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      runtime.emit('complete', 'sess-1', 'run-uuid');
    });

    await runHiddenCoworkSession(
      { prompt: 'p', modelOverride: 'deepseek/deepseek-v4-flash' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].modelOverride).toBe('deepseek/deepseek-v4-flash');
    expect(fake.modelOverrideBySession.get('sess-1')).toBe('deepseek/deepseek-v4-flash');
  });

  test('omitting modelOverride stores an empty override (agent binding wins)', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    setImmediate(() => {
      runtime.emit('complete', 'sess-1', 'run-uuid');
    });

    await runHiddenCoworkSession(
      { prompt: 'p' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    // `undefined` on the create path still passes `''` (enforce-nothing),
    // so the runtime resolves `session.modelOverride || agent.model`.
    expect(fake.created[0].modelOverride).toBe('');
  });

  test('re-applies a changed modelOverride on a continued pooled session', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    fake.messageBySession.set('task-1', []);
    fake.modelOverrideBySession.set('task-1', 'deepseek/deepseek-reasoner');

    setImmediate(() => {
      runtime.emit('complete', 'task-1', 'run-uuid');
    });

    await runHiddenCoworkSession(
      { prompt: 'p', sessionId: 'task-1', modelOverride: 'deepseek/deepseek-v4-flash' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(fake.created).toHaveLength(0);
    expect(fake.updated).toEqual([
      { sessionId: 'task-1', patch: { modelOverride: 'deepseek/deepseek-v4-flash' } },
    ]);
    expect(fake.modelOverrideBySession.get('task-1')).toBe('deepseek/deepseek-v4-flash');
  });

  test("an empty-string modelOverride clears a pooled session's stale override", async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    fake.messageBySession.set('task-1', []);
    fake.modelOverrideBySession.set('task-1', 'deepseek/deepseek-reasoner');

    setImmediate(() => {
      runtime.emit('complete', 'task-1', 'run-uuid');
    });

    await runHiddenCoworkSession(
      { prompt: 'p', sessionId: 'task-1', modelOverride: '' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(fake.updated).toEqual([
      { sessionId: 'task-1', patch: { modelOverride: '' } },
    ]);
    expect(fake.modelOverrideBySession.get('task-1')).toBe('');
  });

  test('undefined modelOverride never touches a continued session (legacy callers)', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    // A session with a pre-existing override from an earlier configured run.
    fake.messageBySession.set('task-1', []);
    fake.modelOverrideBySession.set('task-1', 'deepseek/deepseek-v4-flash');

    setImmediate(() => {
      runtime.emit('complete', 'task-1', 'run-uuid');
    });

    await runHiddenCoworkSession(
      { prompt: 'p', sessionId: 'task-1' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(fake.updated).toHaveLength(0);
    expect(fake.modelOverrideBySession.get('task-1')).toBe('deepseek/deepseek-v4-flash');
  });

  test('a matching modelOverride on a continued session skips updateSession', async () => {
    const { runHiddenCoworkSession } = await import('./hiddenCoworkSession');
    const runtime = buildFakeRuntime();
    const fake = buildFakeStore();

    fake.messageBySession.set('task-1', []);
    fake.modelOverrideBySession.set('task-1', 'deepseek/deepseek-v4-flash');

    setImmediate(() => {
      runtime.emit('complete', 'task-1', 'run-uuid');
    });

    await runHiddenCoworkSession(
      { prompt: 'p', sessionId: 'task-1', modelOverride: 'deepseek/deepseek-v4-flash' },
      {
        runtime: runtime.runtime,
        store: fake.store,
        resolveAgentCwd: () => tmpDir,
      },
    );

    expect(fake.updated).toHaveLength(0);
  });
});