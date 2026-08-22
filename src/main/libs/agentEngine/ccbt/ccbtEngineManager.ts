import { type ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { AcpClient } from './AcpClient';
import type {
  AcpInitializeResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPromptBlock,
  AcpPromptResult,
  AcpSessionUpdate,
} from './acpProtocol';

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcess;

export type CcbtSessionState = 'starting' | 'ready' | 'prompting' | 'idle' | 'dead';

export interface CcbtSpawnOptions {
  cwd: string;
  /** Extra env layered over process.env (CLAUDE_CONFIG_DIR, provider vars, ...). */
  env?: Record<string, string>;
}

export interface CcbtSessionEntry {
  sessionId: string;
  proc: ChildProcess;
  client: AcpClient;
  acpSessionId: string | null;
  state: CcbtSessionState;
  lastActivityAt: number;
  logStream: fs.WriteStream | null;
  /** Captured by killEntry before flipping state to 'dead', so the exit event can distinguish recycle vs crash. */
  stateAtExit?: CcbtSessionState;
}

export interface CcbtEngineManagerEvents {
  update: (sessionId: string, update: AcpSessionUpdate) => void;
  serverRequest: (
    sessionId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    respond: (result: Record<string, unknown>) => void,
    respondError: (code: number, message: string) => void,
  ) => void;
  sessionExit: (sessionId: string, code: number | null, signal: NodeJS.Signals | null, stateAtExit: CcbtSessionState) => void;
  engineUnavailable: (reason: string) => void;
}

export interface CcbtEngineManagerOptions {
  /** Resolves the assembled runtime root (contains bun + dist/cli.js). Null = not installed. */
  runtimeRoot: () => string | null;
  /** Per-user data dir; engine stderr lands in <userData>/ccbt/logs/<sessionId>.log. */
  userDataPath: () => string;
  spawnFn?: SpawnFn;
  maxConcurrentSessions?: number;
  idleRecycleMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_CONCURRENT_SESSIONS = 4;
const DEFAULT_IDLE_RECYCLE_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const MAX_CONSECUTIVE_START_FAILURES = 3;
/** session/prompt can run for minutes - no request timeout, liveness via events. */
const PROMPT_TIMEOUT_MS = 0;
const CLOSE_TIMEOUT_MS = 5_000;
const INITIALIZE_TIMEOUT_MS = 120_000;

/**
 * Process pool for ccbt engine sessions: one `bun dist/cli.js --acp` child per
 * cowork session (ccbt keeps sessions in process memory; process exit loses
 * them). Owns spawn/teardown, the ACP handshake, stderr logging, idle
 * recycling, and crash backoff. Event mapping to CoworkRuntime happens in the
 * adapter, not here.
 */
export class CcbtEngineManager extends EventEmitter {
  private readonly sessions = new Map<string, CcbtSessionEntry>();
  private readonly spawnFn: SpawnFn;
  private readonly maxConcurrent: number;
  private readonly idleRecycleMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private consecutiveStartFailures = 0;
  private unavailableReason: string | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CcbtEngineManagerOptions) {
    super();
    this.spawnFn = options.spawnFn ?? spawn;
    this.maxConcurrent = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.idleRecycleMs = options.idleRecycleMs ?? DEFAULT_IDLE_RECYCLE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  on<U extends keyof CcbtEngineManagerEvents>(event: U, listener: CcbtEngineManagerEvents[U]): this {
    return super.on(event, listener);
  }

  isEngineAvailable(): boolean {
    return this.unavailableReason === null;
  }

  getUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  getSession(sessionId: string): CcbtSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionState(sessionId: string): CcbtSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null;
  }

  isSessionActive(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    return !!entry && entry.state !== 'dead';
  }

  activeSessionCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.state !== 'dead') count++;
    }
    return count;
  }

  /**
   * Spawn an engine process for the session and complete the ACP
   * `initialize` handshake. Resolves with the entry (acpSessionId still null
   * until createAcpSession/loadAcpSession runs).
   */
  async spawnSession(sessionId: string, options: CcbtSpawnOptions): Promise<CcbtSessionEntry> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.state !== 'dead') {
      throw new Error(`ccbt engine session already active: ${sessionId}`);
    }
    if (this.unavailableReason) {
      throw new Error(`ccbt engine unavailable: ${this.unavailableReason}`);
    }
    if (this.activeSessionCount() >= this.maxConcurrent) {
      throw new Error(`ccbt engine session limit reached (${this.maxConcurrent})`);
    }

    const runtimeRoot = this.options.runtimeRoot();
    if (!runtimeRoot) {
      throw new Error('ccbt runtime is not installed (vendor/ccbt-runtime/current missing)');
    }
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const bunPath = path.join(runtimeRoot, bunName);
    const cliPath = path.join(runtimeRoot, 'dist', 'cli.js');
    if (!fs.existsSync(bunPath) || !fs.existsSync(cliPath)) {
      throw new Error(`ccbt runtime layout is incomplete at ${runtimeRoot}`);
    }

    try {
      const proc = this.spawnFn(bunPath, [cliPath, '--acp'], {
        cwd: options.cwd,
        env: {
          ...process.env,
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...options.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const entry = await this.attachClient(sessionId, proc);
      // Only a fully initialized session counts as a successful start.
      this.consecutiveStartFailures = 0;
      return entry;
    } catch (error) {
      this.recordStartFailure(error);
      throw error;
    }
  }

  /** `session/new` - always passes mcpServers (required by the ACP schema). */
  async createAcpSession(
    sessionId: string,
    params: Omit<AcpNewSessionParams, 'mcpServers'> & { mcpServers?: AcpNewSessionParams['mcpServers'] },
  ): Promise<AcpNewSessionResult> {
    const entry = this.requireSession(sessionId);
    const result = await entry.client.request<AcpNewSessionResult>(
      'session/new',
      { mcpServers: [], ...params } as Record<string, unknown>,
      this.requestTimeoutMs,
    );
    entry.acpSessionId = result.sessionId;
    entry.lastActivityAt = this.now();
    return result;
  }

  /** `session/load` - restore a previous session into a freshly spawned process. */
  async loadAcpSession(sessionId: string, acpSessionId: string): Promise<unknown> {
    const entry = this.requireSession(sessionId);
    const result = await entry.client.request(
      'session/load',
      { sessionId: acpSessionId },
      this.requestTimeoutMs,
    );
    entry.acpSessionId = acpSessionId;
    entry.lastActivityAt = this.now();
    return result;
  }

  /**
   * `session/prompt` - no timeout (long turns); the entry flips prompting ->
   * idle when the turn settles. Update events stream during the turn.
   */
  async prompt(sessionId: string, prompt: AcpPromptBlock[]): Promise<AcpPromptResult> {
    const entry = this.requireSession(sessionId);
    if (!entry.acpSessionId) {
      throw new Error(`ccbt engine session ${sessionId} has no ACP session yet`);
    }
    entry.state = 'prompting';
    try {
      const result = await entry.client.request<AcpPromptResult>(
        'session/prompt',
        { sessionId: entry.acpSessionId, prompt: prompt as unknown as Record<string, unknown>[] },
        PROMPT_TIMEOUT_MS,
      );
      return result;
    } finally {
      entry.state = entry.state === 'prompting' ? 'idle' : entry.state;
      entry.lastActivityAt = this.now();
    }
  }

  /** Generic request passthrough (session/set_model, session/cancel, ...). */
  request<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const entry = this.requireSession(sessionId);
    return entry.client.request<T>(method, params, timeoutMs ?? this.requestTimeoutMs);
  }

  markActivity(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastActivityAt = this.now();
  }

  /** Try `session/cancel` for the current turn; best effort. */
  async cancelTurn(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.state === 'dead' || !entry.acpSessionId) return;
    try {
      await entry.client.request('session/cancel', { sessionId: entry.acpSessionId }, 10_000);
      entry.lastActivityAt = this.now();
    } catch {
      // Engine may be mid-crash or already cancelled; recycle handles the rest.
    }
  }

  /**
   * Graceful teardown for one session: session/close (bounded), then kill.
   * Safe to call multiple times.
   */
  async recycleSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.state !== 'dead' && entry.acpSessionId) {
      try {
        await entry.client.request('session/close', { sessionId: entry.acpSessionId }, CLOSE_TIMEOUT_MS);
      } catch {
        // Fall through to kill.
      }
    }
    this.killEntry(entry, 'recycle');
  }

  stopAllSessions(): void {
    for (const entry of this.sessions.values()) {
      this.killEntry(entry, 'stopAll');
    }
    this.stopSweepTimer();
  }

  dispose(): void {
    this.stopAllSessions();
  }

  /**
   * Sweep idle sessions. Called on an interval once any session exists;
   * exported visibility is for tests.
   */
  sweepIdleSessions(): number {
    let recycled = 0;
    const now = this.now();
    for (const entry of [...this.sessions.values()]) {
      if (entry.state !== 'idle') continue;
      if (now - entry.lastActivityAt >= this.idleRecycleMs) {
        void this.recycleSession(entry.sessionId);
        recycled++;
      }
    }
    return recycled;
  }

  private async attachClient(sessionId: string, proc: ChildProcess): Promise<CcbtSessionEntry> {
    const logStream = this.openLogStream(sessionId);
    const client = new AcpClient({
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    client.on('stderr', (chunk) => {
      if (!logStream.destroyed) logStream.write(chunk);
    });
    const entry: CcbtSessionEntry = {
      sessionId,
      proc,
      client,
      acpSessionId: null,
      state: 'starting',
      lastActivityAt: this.now(),
      logStream,
    };
    this.sessions.set(sessionId, entry);

    client.on('update', (update) => {
      entry.lastActivityAt = this.now();
      this.emit('update', sessionId, update);
    });
    // Route every server-initiated request (request_permission etc.) to the
    // adapter via a wildcard handler so new ACP methods surface automatically.
    client.onServerRequest('*', (method, params, respond, respondError) => {
      this.emit('serverRequest', sessionId, method, params, respond, respondError);
    });
    proc.on('exit', (code, signal) => {
      const stateAtExit = entry.stateAtExit ?? entry.state;
      entry.state = 'dead';
      client.close();
      if (logStream && !logStream.destroyed) logStream.end();
      this.emit('sessionExit', sessionId, code, signal, stateAtExit);
      this.sessions.delete(sessionId);
      if (this.sessions.size === 0) this.stopSweepTimer();
    });

    try {
      await client.request<AcpInitializeResult>(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
        INITIALIZE_TIMEOUT_MS,
      );
      entry.state = 'ready';
      entry.lastActivityAt = this.now();
      this.startSweepTimerIfNeeded();
      return entry;
    } catch (error) {
      this.killEntry(entry, 'initialize-failed');
      throw error;
    }
  }

  private openLogStream(sessionId: string): fs.WriteStream | null {
    try {
      const logsDir = path.join(this.options.userDataPath(), 'ccbt', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const stream = fs.createWriteStream(path.join(logsDir, `${sessionId}.log`), { flags: 'a' });
      // A broken log sink (disk full, dir removed) must never take the engine down.
      stream.on('error', () => undefined);
      return stream;
    } catch {
      return null;
    }
  }

  private killEntry(entry: CcbtSessionEntry, _reason: string): void {
    if (entry.state === 'dead') return;
    entry.stateAtExit = entry.state;
    entry.state = 'dead';
    entry.client.close();
    if (entry.logStream && !entry.logStream.destroyed) entry.logStream.end();
    if (!entry.proc.killed) entry.proc.kill();
    this.sessions.delete(entry.sessionId);
    if (this.sessions.size === 0) this.stopSweepTimer();
  }

  private recordStartFailure(error: unknown): void {
    this.consecutiveStartFailures++;
    if (this.consecutiveStartFailures >= MAX_CONSECUTIVE_START_FAILURES) {
      const detail = error instanceof Error ? error.message : String(error);
      this.unavailableReason = `${this.consecutiveStartFailures} consecutive start failures (last: ${detail})`;
      this.emit('engineUnavailable', this.unavailableReason);
    }
  }

  private requireSession(sessionId: string): CcbtSessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.state === 'dead') {
      throw new Error(`ccbt engine session not running: ${sessionId}`);
    }
    return entry;
  }

  private startSweepTimerIfNeeded(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdleSessions(), 60_000);
    this.sweepTimer.unref?.();
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
