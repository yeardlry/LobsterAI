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
  respondToPermissionCalls: Array<{ requestId: string; result: unknown }>;
  stopSessionCalls: string[];
}

function buildFakeRuntime(): FakeRuntimeHarness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const startSessionCalls: Array<{ sessionId: string; prompt: string; options?: unknown }> = [];
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
    continueSession: async () => undefined,
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
    id: string;
  }>;
  messageBySession: Map<string, CoworkMessage[]>;
}

function buildFakeStore(): FakeStoreHarness {
  const created: FakeStoreHarness['created'] = [];
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
        id,
      });
      messageBySession.set(id, []);
      return { id };
    },
    getSession: (sessionId: string) => ({
      messages: messageBySession.get(sessionId) ?? [],
    }),
  } as unknown as CoworkStore;
  return { store, created, messageBySession };
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
});