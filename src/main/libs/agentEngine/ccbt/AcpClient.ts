import { EventEmitter } from 'events';
import type { Writable } from 'stream';

import type {
  AcpSessionUpdate,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcServerRequest,
} from './acpProtocol';

/** Streams the client operates on. Injectable so tests can use PassThrough. */
export interface AcpClientStreams {
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
}

export interface AcpPendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeout: NodeJS.Timeout | null;
}

export type AcpServerRequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  respond: (result: Record<string, unknown>) => void,
  respondError: (code: number, message: string) => void,
) => void;

export interface AcpClientEvents {
  /** Agent -> client notification (`session/update` and friends). */
  notification: (notification: JsonRpcNotification) => void;
  /** Convenience subscription for `session/update` params only. */
  update: (update: AcpSessionUpdate) => void;
  /** Engine process wrote to stderr. */
  stderr: (chunk: string) => void;
  /** Engine process exited. */
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

const JSON_RPC_ERROR_CODE_PREFIX = 'JSON-RPC error';

/**
 * NDJSON JSON-RPC 2.0 client for an ACP agent subprocess (ccbt `--acp`).
 *
 * stdout carries protocol frames only; stderr is surfaced as an event so the
 * owner can pipe it into a per-session log file. Requests are correlated by
 * auto-incremented id with optional timeouts; server-initiated requests (e.g.
 * `session/request_permission`) are dispatched to registered handlers whose
 * `respond` callback keeps the agent's pending Promise alive.
 */
export class AcpClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, AcpPendingRequest>();
  private readonly serverRequestHandlers = new Map<string, AcpServerRequestHandler>();
  private stdoutBuffer = '';
  private closed = false;

  constructor(private readonly streams: AcpClientStreams) {
    super();
    streams.stdout.setEncoding?.('utf8');
    streams.stdout.on('data', this.handleStdoutChunk);
    streams.stderr?.setEncoding?.('utf8');
    streams.stderr?.on('data', (chunk: string | Buffer) => {
      this.emit('stderr', chunk.toString());
    });
  }

  on<U extends keyof AcpClientEvents>(event: U, listener: AcpClientEvents[U]): this {
    return super.on(event, listener);
  }

  /**
   * Send a JSON-RPC request and resolve with the agent's `result`.
   * `timeoutMs` of 0 disables the timeout (for session/prompt, which can run
   * for minutes); the default applies a bounded timeout.
   */
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = 90_000,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`AcpClient closed; cannot send ${method}`));
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      message.params = params;
    }
    return new Promise<T>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`AcpClient request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timeout,
      });
      this.writeLine(JSON.stringify(message));
    });
  }

  /** Register a handler for a server-initiated request method ('*' = fallback). */
  onServerRequest(method: string, handler: AcpServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    const message: JsonRpcNotification = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      message.params = params;
    }
    this.writeLine(JSON.stringify(message));
  }

  /** Respond to a server-initiated request that was deferred by a handler. */
  respondToServer(id: number, result: Record<string, unknown>): void {
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  respondToServerError(id: number, code: number, message: string): void {
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  /**
   * Tear down: fail all pending requests. Does not kill the process - process
   * ownership belongs to the engine manager.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error(`AcpClient closed while ${pending.method} was pending`));
    }
    this.pending.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private handleStdoutChunk = (chunk: string | Buffer): void => {
    this.stdoutBuffer += chunk.toString();
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  };

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-protocol noise on stdout; ignore rather than kill the session.
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        this.dispatchServerRequest(message as unknown as JsonRpcServerRequest);
      } else {
        const notification = message as unknown as JsonRpcNotification;
        this.emit('notification', notification);
        if (notification.method === 'session/update') {
          const update = (notification.params?.update ?? {}) as AcpSessionUpdate;
          this.emit('update', update);
        }
      }
      return;
    }
    if (typeof message.id === 'number') {
      this.settleResponse(message as unknown as JsonRpcResponse);
    }
  }

  private dispatchServerRequest(message: JsonRpcServerRequest): void {
    const handler =
      this.serverRequestHandlers.get(message.method) ?? this.serverRequestHandlers.get('*');
    const id = message.id;
    if (!handler) {
      this.respondToServerError(id, -32601, `Method not found: ${message.method}`);
      return;
    }
    handler(
      message.method,
      message.params,
      (result) => this.respondToServer(id, result),
      (code, errorMessage) => this.respondToServerError(id, code, errorMessage),
    );
  }

  private settleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (response.error) {
      const detail = response.error.data ? ` ${JSON.stringify(response.error.data)}` : '';
      pending.reject(
        new Error(`${JSON_RPC_ERROR_CODE_PREFIX} ${response.error.code} (${response.error.message})${detail}`),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private writeLine(line: string): void {
    this.streams.stdin.write(`${line}\n`);
  }
}
