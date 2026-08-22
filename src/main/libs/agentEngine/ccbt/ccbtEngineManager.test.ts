import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ChildProcess } from 'child_process';

import type { SpawnFn } from './ccbtEngineManager';
import { CcbtEngineManager } from './ccbtEngineManager';

class FakeEngineProcess extends EventEmitter implements Partial<ChildProcess> {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    // Emulate real process exit asynchronously.
    setImmediate(() => this.emit('exit', null, this.killSignal));
    return true;
  }
}

interface FakeEngine {
  proc: FakeEngineProcess;
  /** Helper: reply to the next JSON-RPC request the client sent with `result`. */
  replyNext(result: unknown): Promise<void>;
  /** Request frames the client has sent to the engine, in order. */
  sentFrames(): string[];
}

function createFakeSpawn(): { spawnFn: SpawnFn; engines: FakeEngine[] } {
  const engines: FakeEngine[] = [];
  const spawnFn: SpawnFn = (_command, _args, _options) => {
    const proc = new FakeEngineProcess();
    // The client writes requests to proc.stdin; the engine replies on stdout.
    const reader = createFrameReader(proc.stdin);
    const engine: FakeEngine = {
      proc,
      replyNext: async (result) => {
        const line = await reader.next();
        const message = JSON.parse(line) as { id: number };
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      },
      sentFrames: () => reader.seen,
    };
    engines.push(engine);
    return proc as unknown as ChildProcess;
  };
  return { spawnFn, engines };
}

function createFrameReader(stream: PassThrough): { next: () => Promise<string>; seen: string[] } {
  const seen: string[] = [];
  const pending: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        seen.push(line);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else pending.push(line);
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    next: () =>
      pending.length > 0
        ? Promise.resolve(pending.shift() as string)
        : new Promise((resolve) => waiters.push(resolve)),
    seen,
  };
}

describe('CcbtEngineManager', () => {
  let tempDir: string;
  let runtimeRoot: string;
  let userDataDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbt-manager-test-'));
    runtimeRoot = path.join(tempDir, 'ccbt-runtime');
    userDataDir = path.join(tempDir, 'userData');
    fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'bun'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(runtimeRoot, 'dist', 'cli.js'), '// stub\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const createManager = (
    overrides: Partial<ConstructorParameters<typeof CcbtEngineManager>[0]> = {},
    spawn?: { spawnFn: SpawnFn; engines: FakeEngine[] },
  ) => {
    const fake = spawn ?? createFakeSpawn();
    const manager = new CcbtEngineManager({
      runtimeRoot: () => runtimeRoot,
      userDataPath: () => userDataDir,
      spawnFn: fake.spawnFn,
      now: () => 1_000_000,
      ...overrides,
    });
    return { manager, engines: fake.engines };
  };

  test('spawnSession completes initialize handshake and reaches ready state', async () => {
    const { manager, engines } = createManager();
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    // Answer initialize.
    await engines[0].replyNext({ protocolVersion: 1 });
    const entry = await spawnPromise;

    expect(entry.state).toBe('ready');
    expect(manager.isSessionActive('session-1')).toBe(true);
    // initialize frame carried the client capabilities.
    const initFrame = JSON.parse(engines[0].sentFrames()[0]) as { method: string };
    expect(initFrame.method).toBe('initialize');
    manager.stopAllSessions();
  });

  test('spawnSession rejects duplicate active session', async () => {
    const { manager, engines } = createManager();
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;
    await expect(manager.spawnSession('session-1', { cwd: tempDir })).rejects.toThrow(
      /already active/,
    );
    manager.stopAllSessions();
  });

  test('spawnSession enforces the concurrency limit', async () => {
    const { manager, engines } = createManager({ maxConcurrentSessions: 1 });
    const first = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await first;
    await expect(manager.spawnSession('session-2', { cwd: tempDir })).rejects.toThrow(
      /session limit reached/,
    );
    manager.stopAllSessions();
  });

  test('spawnSession rejects when runtime root is missing', async () => {
    const { manager } = createManager({ runtimeRoot: () => null });
    await expect(manager.spawnSession('session-1', { cwd: tempDir })).rejects.toThrow(
      /not installed/,
    );
  });

  test('createAcpSession always sends mcpServers array and stores acpSessionId', async () => {
    const { manager, engines } = createManager();
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;

    const newPromise = manager.createAcpSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ sessionId: 'acp-1' });
    await newPromise;

    const frames = engines[0].sentFrames().map((line) => JSON.parse(line) as Record<string, unknown>);
    const newFrame = frames.find((frame) => frame.method === 'session/new') as { params: { mcpServers: unknown } };
    expect(Array.isArray(newFrame.params.mcpServers)).toBe(true);
    expect(manager.getSession('session-1')?.acpSessionId).toBe('acp-1');
    manager.stopAllSessions();
  });

  test('prompt flips state prompting -> idle and resolves with stopReason', async () => {
    const { manager, engines } = createManager();
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;
    const newPromise = manager.createAcpSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ sessionId: 'acp-1' });
    await newPromise;

    const promptPromise = manager.prompt('session-1', [{ type: 'text', text: 'hello' }]);
    expect(manager.getSessionState('session-1')).toBe('prompting');
    await engines[0].replyNext({ stopReason: 'end_turn' });
    const result = await promptPromise;

    expect(result.stopReason).toBe('end_turn');
    expect(manager.getSessionState('session-1')).toBe('idle');
    manager.stopAllSessions();
  });

  test('update events are re-emitted with the cowork session id', async () => {
    const { manager, engines } = createManager();
    const updates: unknown[] = [];
    manager.on('update', (sessionId, update) => {
      if (sessionId === 'session-1') updates.push(update);
    });
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;

    engines[0].proc.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk' } },
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates).toEqual([{ sessionUpdate: 'agent_message_chunk' }]);
    manager.stopAllSessions();
  });

  test('server requests are routed through the serverRequest event', async () => {
    const { manager, engines } = createManager();
    const seen: Array<{ sessionId: string; method: string }> = [];
    manager.on('serverRequest', (sessionId, method, _params, respond) => {
      seen.push({ sessionId, method });
      respond({ outcome: { outcome: 'cancelled' } });
    });
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;

    engines[0].proc.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'session/request_permission',
        params: { options: [] },
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([{ sessionId: 'session-1', method: 'session/request_permission' }]);
    // The response was written back to the engine.
    const responseFrame = engines[0]
      .sentFrames()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((frame) => frame.id === 77);
    expect(responseFrame?.result).toEqual({ outcome: { outcome: 'cancelled' } });
    manager.stopAllSessions();
  });

  test('engine crash emits sessionExit with the pre-crash state and clears the entry', async () => {
    const { manager, engines } = createManager();
    const exits: Array<{ code: number | null; state: string }> = [];
    manager.on('sessionExit', (_sessionId, code, _signal, stateAtExit) => {
      exits.push({ code, state: stateAtExit });
    });
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;
    const newPromise = manager.createAcpSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ sessionId: 'acp-1' });
    await newPromise;
    const promptPromise = manager.prompt('session-1', [{ type: 'text', text: 'x' }]);

    engines[0].proc.emit('exit', 1, null);
    await expect(promptPromise).rejects.toThrow(/closed while session\/prompt was pending/);

    expect(exits).toEqual([{ code: 1, state: 'prompting' }]);
    expect(manager.isSessionActive('session-1')).toBe(false);
  });

  test('recycleSession reports the recycled state, not dead', async () => {
    const { manager, engines } = createManager();
    const exits: string[] = [];
    manager.on('sessionExit', (_s, _c, _sig, stateAtExit) => exits.push(stateAtExit));
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;

    await manager.recycleSession('session-1');
    // FakeEngineProcess.kill() emits exit asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toEqual(['ready']);
    expect(engines[0].proc.killed).toBe(true);
  });

  test('three consecutive start failures mark the engine unavailable', async () => {
    const unavailable: string[] = [];
    const { manager, engines } = createManager();
    manager.on('engineUnavailable', (reason) => unavailable.push(reason));

    for (let i = 0; i < 3; i++) {
      const spawnPromise = manager.spawnSession(`session-${i}`, { cwd: tempDir });
      // Engine exits before answering initialize -> start failure.
      setImmediate(() => engines[i].proc.emit('exit', 1, null));
      await expect(spawnPromise).rejects.toThrow();
    }

    expect(manager.isEngineAvailable()).toBe(false);
    expect(unavailable).toHaveLength(1);
    await expect(manager.spawnSession('session-x', { cwd: tempDir })).rejects.toThrow(
      /unavailable/,
    );
  });

  test('successful spawn resets the failure counter', async () => {
    const { manager, engines } = createManager();
    for (let i = 0; i < 2; i++) {
      const spawnPromise = manager.spawnSession(`fail-${i}`, { cwd: tempDir });
      setImmediate(() => engines[i].proc.emit('exit', 1, null));
      await expect(spawnPromise).rejects.toThrow();
    }
    // A success resets the counter...
    const spawnPromise = manager.spawnSession('ok-1', { cwd: tempDir });
    await engines[2].replyNext({ protocolVersion: 1 });
    await spawnPromise;
    manager.stopAllSessions();
    // ...so two more failures do not trip the limit (which needs 3 consecutive).
    for (let i = 3; i < 5; i++) {
      const failing = manager.spawnSession(`fail-${i}`, { cwd: tempDir });
      setImmediate(() => engines[i].proc.emit('exit', 1, null));
      await expect(failing).rejects.toThrow();
    }
    expect(manager.isEngineAvailable()).toBe(true);
  });

  test('sweepIdleSessions recycles only idle sessions past the threshold', async () => {
    let now = 1_000_000;
    const { manager, engines } = createManager({
      idleRecycleMs: 100,
      now: () => now,
    });
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;
    const newPromise = manager.createAcpSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ sessionId: 'acp-1' });
    await newPromise;

    // Not idle yet (state=ready), even past the threshold.
    now += 200;
    expect(manager.sweepIdleSessions()).toBe(0);

    // Prompt once to bring it to idle, then age past the threshold.
    const promptPromise = manager.prompt('session-1', [{ type: 'text', text: 'x' }]);
    await engines[0].replyNext({ stopReason: 'end_turn' });
    await promptPromise;
    now += 50;
    expect(manager.sweepIdleSessions()).toBe(0);
    now += 60;
    expect(manager.sweepIdleSessions()).toBe(1);
    // The recycle flow sends session/close first; answer it so the kill proceeds.
    await engines[0].replyNext({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.isSessionActive('session-1')).toBe(false);
  });

  test('engine stderr is appended to the per-session log file', async () => {
    const { manager, engines } = createManager();
    const spawnPromise = manager.spawnSession('session-1', { cwd: tempDir });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;

    engines[0].proc.stderr.write('engine noise\n');
    await new Promise((resolve) => setImmediate(resolve));
    manager.stopAllSessions();
    await new Promise((resolve) => setImmediate(resolve));

    const logPath = path.join(userDataDir, 'ccbt', 'logs', 'session-1.log');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('engine noise');
  });

  test('spawn layers env over process env with telemetry disabled', async () => {
    const spawns: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const fake = createFakeSpawn();
    const wrappedSpawn: SpawnFn = (command, args, options) => {
      spawns.push({ command, args, env: options.env, cwd: options.cwd });
      return fake.spawnFn(command, args, options);
    };
    const { manager, engines } = createManager(undefined, { spawnFn: wrappedSpawn, engines: fake.engines });
    const spawnPromise = manager.spawnSession('session-1', {
      cwd: tempDir,
      env: { CLAUDE_CONFIG_DIR: '/cfg/1' },
    });
    await engines[0].replyNext({ protocolVersion: 1 });
    await spawnPromise;

    expect(spawns[0].args).toEqual([path.join(runtimeRoot, 'dist', 'cli.js'), '--acp']);
    expect(spawns[0].cwd).toBe(tempDir);
    expect(spawns[0].env.CLAUDE_CONFIG_DIR).toBe('/cfg/1');
    expect(spawns[0].env.DISABLE_TELEMETRY).toBe('1');
    manager.stopAllSessions();
  });
});
