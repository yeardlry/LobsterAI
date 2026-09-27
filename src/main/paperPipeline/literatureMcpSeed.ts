import { isProdLikeBuild, loadEnvProduction, parseEnvFileContent } from '../libs/envProduction';
import type { McpStore } from '../mcp/mcpStore';

// Re-exported for the colocated tests (the parser itself now lives in
// envProduction.ts alongside the other `.env.production` machinery).
export { parseEnvFileContent };

/**
 * Literature-manager MCP seed — keeps exactly one remote MCP server pointing
 * at the literature backend, derived from the build environment:
 *
 * - Dev (plain `npm run electron:dev`): fixed `http://localhost:3000/mcp`.
 * - Packaged / forced-prod dev (`npm run electron:dev:prod`):
 *   `LITERATURE_MCP_URL` from `.env.production` (Resources/ for packaged
 *   builds, project root for forced-prod runs — see envProduction.ts); falls
 *   back to the dev URL when the file/var is missing so a broken bundle
 *   never bricks startup.
 *
 * Seeding runs once per startup in `main.ts` before the first OpenClaw
 * config sync, mirroring `installDefaultPresets`. The strategy is
 * match-by-URL: a stored server whose URL is the dev URL or the current
 * target URL is adopted (and corrected); otherwise a new server is created.
 * User-created servers with unrelated URLs are never touched.
 */

export const LiteratureMcpSeedConstants = {
  EnvVarUrl: 'LITERATURE_MCP_URL',
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
  locked?: boolean;
}

export type LiteratureMcpSeedPlan =
  | { action: 'create'; url: string }
  | { action: 'update'; serverId: string; url: string }
  | { action: 'none' };

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
    || matched.useAuthToken !== true
    || matched.locked !== true;
  if (!needsUpdate) {
    return { action: 'none' };
  }
  return { action: 'update', serverId: matched.id, url: targetUrl };
}

/**
 * Seed the literature-manager MCP server into the local store. Runs before
 * the startup OpenClaw config sync so a freshly created server lands in
 * openclaw.json on the first sync. Idempotent: nothing is written when the
 * stored server already matches.
 */
export function seedLiteratureMcpServer(store: McpStore): void {
  const isProd = isProdLikeBuild();
  const env = isProd ? loadEnvProduction() : {};
  const { url, source } = resolveLiteratureMcpTargetUrl(env);
  if (isProd && source === 'fallback' && Object.keys(env).length > 0) {
    console.warn(
      `[LiteratureMCP] ${LiteratureMcpSeedConstants.EnvVarUrl} is missing or invalid in .env.production; falling back to ${LiteratureMcpSeedConstants.DevUrl}`,
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
      locked: true,
    });
    console.log(`[LiteratureMCP] created server "${LiteratureMcpSeedConstants.ServerName}" -> ${url} (${source})`);
    return;
  }

  store.updateServer(plan.serverId, {
    url,
    transportType: LiteratureMcpSeedConstants.Transport,
    useAuthToken: true,
    locked: true,
  });
  console.log(`[LiteratureMCP] updated existing server ${plan.serverId} -> ${url} (${source})`);
}
