import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import type { McpStore } from '../mcp/mcpStore';

/**
 * Literature-manager MCP seed — keeps exactly one remote MCP server pointing
 * at the literature backend, derived from the build environment:
 *
 * - Dev (`app.isPackaged === false`): fixed `http://localhost:3000/mcp`.
 * - Packaged: `LITERATURE_MCP_URL` from `Resources/.env.production`
 *   (see electron-builder.json extraResources); falls back to the dev URL
 *   when the file/var is missing so a broken bundle never bricks startup.
 * - Local prod debugging: `LOBSTERAI_LIT_MCP_FORCE_PROD=1` (npm run
 *   electron:dev:prod) makes an unpackaged dev build behave like packaged —
 *   reads `.env.production` from the project root instead of Resources.
 *
 * Seeding runs once per startup in `main.ts` before the first OpenClaw
 * config sync, mirroring `installDefaultPresets`. The strategy is
 * match-by-URL: a stored server whose URL is the dev URL or the current
 * target URL is adopted (and corrected); otherwise a new server is created.
 * User-created servers with unrelated URLs are never touched.
 */

export const LiteratureMcpSeedConstants = {
  EnvVarUrl: 'LITERATURE_MCP_URL',
  /**
   * Set to `1` (npm run electron:dev:prod) to make an unpackaged dev build
   * resolve the URL the way a packaged build would — via `.env.production`
   * from the project root.
   */
  ForceProdEnvVar: 'LOBSTERAI_LIT_MCP_FORCE_PROD',
  ServerName: 'literature-manager',
  ServerDescription: 'Literature manager MCP (auto-seeded at startup)',
  DevUrl: 'http://localhost:3000/mcp',
  Transport: 'streamable-http',
} as const;

/** Minimal structural view of McpServerRecord so tests need no sqlite. */
export interface LiteratureMcpSeedServerView {
  id: string;
  name: string;
  url?: string;
  transportType: string;
  useAuthToken?: boolean;
}

export type LiteratureMcpSeedPlan =
  | { action: 'create'; url: string }
  | { action: 'update'; serverId: string; url: string }
  | { action: 'none' };

/**
 * Parse KEY=VALUE lines from an env file. Skips blank lines and `#`
 * comments; strips matching quotes around values. Deliberately minimal —
 * no dotenv dependency for exactly one variable.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Resolve the target URL from parsed env vars. A missing/blank/invalid
 * `LITERATURE_MCP_URL` falls back to the dev URL rather than disabling the
 * server.
 */
export function resolveLiteratureMcpTargetUrl(
  env: Record<string, string>,
): { url: string; source: 'env' | 'fallback' } {
  const value = env[LiteratureMcpSeedConstants.EnvVarUrl]?.trim() ?? '';
  if (value && isHttpUrl(value)) {
    return { url: value, source: 'env' };
  }
  return { url: LiteratureMcpSeedConstants.DevUrl, source: 'fallback' };
}

/**
 * Decide the seed action for the current target URL. A stored server is
 * matched when its URL equals the dev URL or the target URL (so flipping
 * between dev/prod builds reuses one record instead of piling up new ones).
 */
export function planLiteratureMcpSeed(
  servers: readonly LiteratureMcpSeedServerView[],
  targetUrl: string,
): LiteratureMcpSeedPlan {
  const matchUrls = new Set([LiteratureMcpSeedConstants.DevUrl, targetUrl]);
  const matched = servers.find((server) => !!server.url && matchUrls.has(server.url));
  if (!matched) {
    return { action: 'create', url: targetUrl };
  }
  const needsUpdate = matched.url !== targetUrl
    || matched.transportType !== LiteratureMcpSeedConstants.Transport
    || matched.useAuthToken !== true;
  if (!needsUpdate) {
    return { action: 'none' };
  }
  return { action: 'update', serverId: matched.id, url: targetUrl };
}

function readEnvProductionFile(envPath: string): string | null {
  try {
    return fs.readFileSync(envPath, 'utf8');
  } catch {
    console.warn(`[LiteratureMCP] ${envPath} not found or unreadable; falling back to ${LiteratureMcpSeedConstants.DevUrl}`);
    return null;
  }
}

/**
 * Seed the literature-manager MCP server into the local store. Runs before
 * the startup OpenClaw config sync so a freshly created server lands in
 * openclaw.json on the first sync. Idempotent: nothing is written when the
 * stored server already matches.
 */
export function seedLiteratureMcpServer(store: McpStore): void {
  const forceProd = process.env[LiteratureMcpSeedConstants.ForceProdEnvVar] === '1';
  const isProd = app.isPackaged || forceProd;
  let env: Record<string, string> = {};
  if (isProd) {
    // Packaged builds read Resources/.env.production; a forced-prod dev run
    // reads the file from the project root (app.getAppPath() === repo root).
    const envPath = app.isPackaged
      ? path.join(process.resourcesPath, '.env.production')
      : path.join(app.getAppPath(), '.env.production');
    const content = readEnvProductionFile(envPath);
    if (content !== null) {
      env = parseEnvFileContent(content);
    }
  }
  const { url, source } = resolveLiteratureMcpTargetUrl(env);
  if (isProd && source === 'fallback' && Object.keys(env).length > 0) {
    console.warn(
      `[LiteratureMCP] ${LiteratureMcpSeedConstants.EnvVarUrl} is missing or invalid in Resources/.env.production; falling back to ${LiteratureMcpSeedConstants.DevUrl}`,
    );
  }

  const plan = planLiteratureMcpSeed(store.listServers(), url);
  if (plan.action === 'none') return;

  if (plan.action === 'create') {
    store.createServer({
      name: LiteratureMcpSeedConstants.ServerName,
      description: LiteratureMcpSeedConstants.ServerDescription,
      transportType: LiteratureMcpSeedConstants.Transport,
      url,
      useAuthToken: true,
    });
    console.log(`[LiteratureMCP] created server "${LiteratureMcpSeedConstants.ServerName}" -> ${url} (${source})`);
    return;
  }

  store.updateServer(plan.serverId, {
    url,
    transportType: LiteratureMcpSeedConstants.Transport,
    useAuthToken: true,
  });
  console.log(`[LiteratureMCP] updated existing server ${plan.serverId} -> ${url} (${source})`);
}
