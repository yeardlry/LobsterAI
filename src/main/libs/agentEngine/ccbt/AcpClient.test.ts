import { PassThrough } from 'stream';
import { describe, expect, test, vi } from 'vitest';

import { AcpClient } from './AcpClient';

interface FakeWire {
  client: AcpClient;
  /** Server side of the wire: what the agent process would read. */
  agentStdin: PassThrough;
  /** Server side of the wire: what the agent process would write. */
  agentStdout: PassThrough;
  agentStderr: PassThrough;
}

function createClient(): FakeWire {
  const agentStdin = new PassThrough();
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();
  // The client reads the agent's stdout and writes to the agent's stdin.
  const client = new AcpClient({ stdin: agentStdin, stdout: agentStdout, stderr: agentStderr });
  return { client, agentStdin, agentStdout, agentStderr };
}

interface WireReader {
  lines: string[];
  waiters: Array<(line: string) => void>;
}

const wireReaders = new WeakMap<PassThrough, WireReader>();

function getWireReader(stream: PassThrough): WireReader {
  let reader = wireReaders.get(stream);
  if (!reader) {
    reader = { lines: [], waiters: [] };
    wireReaders.set(stream, reader);
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const waiter = reader?.waiters.shift();
          if (waiter) waiter(line);
          else reader?.lines.push(line);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  }
  return reader;
}

/** Reads the next NDJSON frame the agent wrote to the stream. */
function readJson(stream: PassThrough): Promise<Record<string, unknown>> {
  const reader = getWireReader(stream);
  const line = reader.lines.shift();
  if (line !== undefined) {
    return Promise.resolve(JSON.parse(line) as Record<string, unknown>);
  }
  return new Promise((resolve, reject) => {
    reader.waiters.push((received) => {
      try {
        resolve(JSON.parse(received) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}


describe('AcpClient', () => {
  test('sends initialize request as NDJSON and resolves with result', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    const pending = client.request('initialize', { protocolVersion: 1 });

    const sent = await readJson(agentStdin);
    expect(sent.method).toBe('initialize');
    expect(sent.jsonrpc).toBe('2.0');
    expect(typeof sent.id).toBe('number');

    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { protocolVersion: 1 } })}\n`);
    await expect(pending).resolves.toEqual({ protocolVersion: 1 });
  });

  test('increments request ids and correlates responses', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    const first = client.request('session/new', { cwd: '/tmp', mcpServers: [] });
    const second = client.request('session/new', { cwd: '/other', mcpServers: [] });

    const id1 = (await readJson(agentStdin)).id as number;
    const id2 = (await readJson(agentStdin)).id as number;
    expect(id2).toBe(id1 + 1);

    // Answer out of order.
    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id2, result: { sessionId: 'second' } })}\n`);
    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id1, result: { sessionId: 'first' } })}\n`);

    await expect(first).resolves.toEqual({ sessionId: 'first' });
    await expect(second).resolves.toEqual({ sessionId: 'second' });
  });

  test('rejects on JSON-RPC error response and includes code and data', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    const pending = client.request('session/new', { cwd: '/tmp' });
    const id = (await readJson(agentStdin)).id as number;

    agentStdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params', data: { mcpServers: {} } },
      })}\n`,
    );

    await expect(pending).rejects.toThrow(/-32602.*Invalid params.*mcpServers/);
  });

  test('times out requests when no response arrives', async () => {
    const { client } = createClient();
    vi.useFakeTimers();
    const pending = client.request('session/new', { cwd: '/tmp' }, 1_000);
    const assertion = expect(pending).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    vi.useRealTimers();
  });

  test('timeout of 0 disables the request timeout', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    vi.useFakeTimers();
    const pending = client.request('session/prompt', { sessionId: 's1' }, 0);
    await vi.advanceTimersByTimeAsync(600_000);
    const id = (await readJson(agentStdin)).id as number;
    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`);
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
    vi.useRealTimers();
  });

  test('emits update events for session/update notifications', () => {
    const { client, agentStdout } = createClient();
    const updates: unknown[] = [];
    client.on('update', (update) => updates.push(update));

    agentStdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
      })}\n`,
    );

    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    ]);
  });

  test('handles frames split across chunk boundaries', () => {
    const { client, agentStdout } = createClient();
    const updates: unknown[] = [];
    client.on('update', (update) => updates.push(update));

    const frame = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', plan: [] } },
    })}\n`;
    agentStdout.write(frame.slice(0, 10));
    agentStdout.write(frame.slice(10));

    expect(updates).toEqual([{ sessionUpdate: 'plan', plan: [] }]);
  });

  test('dispatches server requests to handlers with respond callbacks', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    const seen: Array<{ method: string; params: unknown }> = [];
    client.onServerRequest('session/request_permission', (method, params, respond) => {
      seen.push({ method, params });
      respond({ outcome: { outcome: 'cancelled' } });
    });

    agentStdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'session/request_permission',
        params: { toolCallId: 'tc-1', options: [] },
      })}\n`,
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([
      { method: 'session/request_permission', params: { toolCallId: 'tc-1', options: [] } },
    ]);
    const response = await readJson(agentStdin);
    expect(response).toEqual({ jsonrpc: '2.0', id: 41, result: { outcome: { outcome: 'cancelled' } } });
  });

  test('wildcard handler receives unmatched server request methods', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    const methods: string[] = [];
    client.onServerRequest('*', (method, _params, respond) => {
      methods.push(method);
      respond({});
    });

    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/some_new_method' })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(methods).toEqual(['session/some_new_method']);
    const response = await readJson(agentStdin);
    expect(response.id).toBe(7);
  });

  test('answers -32601 for unmatched server requests without handlers', async () => {
    const { client, agentStdin, agentStdout } = createClient();
    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'session/unknown' })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    const response = await readJson(agentStdin);
    expect(response.error).toMatchObject({ code: -32601 });
  });

  test('forwards stderr chunks as events', () => {
    const { client, agentStderr } = createClient();
    const seen: string[] = [];
    client.on('stderr', (chunk) => seen.push(chunk));
    agentStderr.write('engine log line\n');
    expect(seen).toEqual(['engine log line\n']);
  });

  test('close rejects pending requests and refuses new ones', async () => {
    const { client } = createClient();
    const pending = client.request('session/prompt', { sessionId: 's1' }, 0);
    client.close();
    await expect(pending).rejects.toThrow(/closed while session\/prompt was pending/);
    await expect(client.request('session/new', {})).rejects.toThrow(/AcpClient closed/);
  });

  test('ignores non-JSON lines on stdout', () => {
    const { client, agentStdout } = createClient();
    const listener = vi.fn();
    client.on('notification', listener);
    agentStdout.write('this is not json\n');
    expect(listener).not.toHaveBeenCalled();
  });
});
