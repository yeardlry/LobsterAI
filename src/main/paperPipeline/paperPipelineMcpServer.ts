import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { resolvePackageRoot } from '../computerUse/computerUseMcpServer';
import type { ResolvedMcpServer } from '../libs/openclawConfigSync';
import { findSystemNodePath } from '../libs/resolveStdioCommand';

/**
 * Built-in `lobsterai-paper` MCP server — exposes the paper-pipeline
 * autopilot to OpenClaw agent sessions (chat AND scheduled tasks).
 *
 * Scheduled tasks are agent prompts in isolated sessions; without these
 * tools the agent has no way to refresh the lit todo list (the token only
 * exists in the main process) or trigger the one-click advance. The server
 * is a small .mjs shim (written to userData, mirroring the computer-use
 * pattern) whose tools POST back to the `McpBridgeServer` localhost
 * endpoints with the shared bridge secret.
 *
 * Tools (all names prefixed by OpenClaw with the server name):
 *   - paper_pipeline_autopilot        — start a refresh+advance batch
 *   - paper_pipeline_autopilot_status — poll batch progress / summary
 *   - paper_list_pending_tasks        — refresh + list the todo tasks
 */

export const PaperPipelineMcpServerName = {
  BuiltIn: 'lobsterai-paper',
} as const;
export type PaperPipelineMcpServerName =
  typeof PaperPipelineMcpServerName[keyof typeof PaperPipelineMcpServerName];

const SERVER_SCRIPT_NAME = 'paper-pipeline-mcp-server.mjs';

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function ensurePaperPipelineMcpServerScript(): string {
  const scriptDir = path.join(app.getPath('userData'), 'mcp-bridge', 'bin');
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, SERVER_SCRIPT_NAME);
  const existing = isFile(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  if (existing !== PAPER_PIPELINE_MCP_SERVER_SCRIPT) {
    fs.writeFileSync(scriptPath, PAPER_PIPELINE_MCP_SERVER_SCRIPT, 'utf8');
  }
  return scriptPath;
}

export function resolvePaperPipelineMcpServer(options: {
  bridgeBaseUrl: string | null;
  bridgeSecret: string;
  electronNodePath: string;
}): ResolvedMcpServer | null {
  if (!options.bridgeBaseUrl) {
    console.warn('[PaperPipelineMCP] skipped built-in server because the bridge server is unavailable');
    return null;
  }

  const sdkRoot = resolvePackageRoot('@modelcontextprotocol/sdk');
  const zodRoot = resolvePackageRoot('zod');
  if (!sdkRoot || !zodRoot) {
    console.warn('[PaperPipelineMCP] skipped built-in server because MCP SDK or zod was not found');
    return null;
  }

  const systemNodePath = app.isPackaged ? null : findSystemNodePath();
  const command = systemNodePath || options.electronNodePath;
  const env: Record<string, string> = {
    LOBSTER_PAPER_BRIDGE_URL: options.bridgeBaseUrl,
    LOBSTER_MCP_BRIDGE_SECRET: options.bridgeSecret,
    LOBSTER_PAPER_MCP_SDK_ROOT: sdkRoot,
    LOBSTER_PAPER_ZOD_ROOT: zodRoot,
  };
  if (!systemNodePath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  return {
    name: PaperPipelineMcpServerName.BuiltIn,
    transportType: 'stdio',
    command,
    args: [ensurePaperPipelineMcpServerScript()],
    env,
  };
}

const PAPER_PIPELINE_MCP_SERVER_SCRIPT = String.raw`import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const env = process.env;

function requireEnv(name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(name + ' is required');
  }
  return value;
}

function moduleUrl(...parts) {
  return pathToFileURL(path.join(...parts)).href;
}

const sdkRoot = requireEnv('LOBSTER_PAPER_MCP_SDK_ROOT');
const zodRoot = requireEnv('LOBSTER_PAPER_ZOD_ROOT');
const bridgeBaseUrl = requireEnv('LOBSTER_PAPER_BRIDGE_URL').replace(/\/+$/, '');
const bridgeSecret = requireEnv('LOBSTER_MCP_BRIDGE_SECRET');

const { McpServer } = await import(moduleUrl(sdkRoot, 'dist', 'esm', 'server', 'mcp.js'));
const { StdioServerTransport } = await import(moduleUrl(sdkRoot, 'dist', 'esm', 'server', 'stdio.js'));
const { z } = await import(moduleUrl(zodRoot, 'index.js'));

const server = new McpServer({
  name: 'lobsterai-paper',
  version: '1.0.0',
});

async function callBridge(route, body) {
  const response = await fetch(bridgeBaseUrl + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mcp-bridge-secret': bridgeSecret,
    },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null);
  if (payload && Array.isArray(payload.content)) {
    // Bridge tool-result shape — forward verbatim.
    return payload;
  }
  const text = 'Bridge HTTP ' + response.status + (payload && payload.error ? ': ' + payload.error : '');
  return { content: [{ type: 'text', text }], isError: true };
}

function registerTool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
}

registerTool(
  'paper_pipeline_autopilot',
  '启动文献流水线自动推进批次：刷新 lit 待办任务列表，并对每个可推进的任务执行一键推进（下载 PDF → 分析 → 分类 → 生成公众号文章 → 上传 word），停止节点为 word 上传完成（用户需自行粘贴公众号 docUrl）。立即返回批次信息，用 paper_pipeline_autopilot_status 轮询进度。',
  {},
  async () => callBridge('/paper/pipeline/autopilot/start'),
);

registerTool(
  'paper_pipeline_autopilot_status',
  '查询文献流水线自动推进批次的进度。返回 running、已处理任务的结果（成功/失败/待粘贴 docUrl）和中文 summary。jobId 可省略（默认查当前或最近一次批次）。',
  { jobId: z.string().optional() },
  async (args) => callBridge('/paper/pipeline/autopilot/status', { jobId: args.jobId }),
);

registerTool(
  'paper_list_pending_tasks',
  '刷新并返回 lit 后端的文献待办任务列表（pmid、标题、processingStatus）。',
  {},
  async () => callBridge('/paper/pipeline/pending-tasks'),
);

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));

await server.connect(new StdioServerTransport());
`;
