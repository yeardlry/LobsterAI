'use strict';

// ACP round-trip smoke test against an assembled ccbt runtime dir.
// Usage: node scripts/verify-ccbt-runtime.cjs [runtimeDir]
//   runtimeDir defaults to vendor/ccbt-runtime/current and must contain
//   bun (or bun.exe) + dist/cli.js.
//
// Verifies: initialize handshake -> session/new (mcpServers: []) ->
// session/prompt -> streamed agent_message_chunk -> stopReason end_turn.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = path.resolve(rootDir, process.argv[2] || path.join('vendor', 'ccbt-runtime', 'current'));
const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
const bunPath = path.join(runtimeDir, bunName);
const cliPath = path.join(runtimeDir, 'dist', 'cli.js');

function fail(message) {
  console.error(`[verify-ccbt-runtime] FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(bunPath)) fail(`missing ${bunPath}`);
if (!fs.existsSync(cliPath)) fail(`missing ${cliPath}`);

const promptText = process.env.CCBT_VERIFY_PROMPT_TEXT || 'Reply with exactly: LOBSTER_OK';
const timeoutMs = Number(process.env.CCBT_VERIFY_TIMEOUT_MS || 120000);

const child = spawn(bunPath, [cliPath, '--acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: os.tmpdir(),
});

let stdoutBuf = '';
let streamed = '';
const pending = new Map();
let settled = false;

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'session/update') {
      const update = msg.params && msg.params.update;
      if (update && update.sessionUpdate === 'agent_message_chunk') {
        streamed += (update.content && update.content.text) || '';
      }
    }
  }
});

let stderrTail = '';
child.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk.toString()).slice(-2000);
});

const timeout = setTimeout(() => {
  if (!settled) fail(`timed out after ${timeoutMs}ms. stderr tail:\n${stderrTail}`);
}, timeoutMs);

function request(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  console.log(`[verify-ccbt-runtime] runtime: ${runtimeDir}`);

  const init = await request(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
  console.log('[verify-ccbt-runtime] initialize ok');

  // mcpServers is REQUIRED by the ACP schema - always send an array.
  const newSession = await request(2, 'session/new', {
    cwd: os.tmpdir(),
    mcpServers: [],
    _meta: { permissionMode: 'bypassPermissions' },
  });
  if (newSession.error) fail(`session/new failed: ${JSON.stringify(newSession.error)}`);
  console.log(`[verify-ccbt-runtime] session/new ok: ${newSession.result.sessionId}`);

  const prompt = await request(3, 'session/prompt', {
    sessionId: newSession.result.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  if (prompt.error) fail(`session/prompt failed: ${JSON.stringify(prompt.error)}`);
  const stopReason = prompt.result && prompt.result.stopReason;
  console.log(`[verify-ccbt-runtime] stopReason: ${stopReason}`);
  console.log(`[verify-ccbt-runtime] streamed reply: ${JSON.stringify(streamed.slice(0, 200))}`);
  if (stopReason !== 'end_turn') fail(`unexpected stopReason: ${stopReason}`);
  if (!streamed.trim()) fail('no agent_message_chunk streamed');

  settled = true;
  clearTimeout(timeout);
  child.kill();
  console.log('[verify-ccbt-runtime] PASS');
  process.exit(0);
})().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
