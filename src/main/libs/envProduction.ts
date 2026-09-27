import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Loader for `.env.production` — the single source of prod-only overrides.
 *
 * - Packaged builds: `Resources/.env.production` (bundled via
 *   electron-builder.json extraResources).
 * - Forced-prod dev runs (`LOBSTERAI_FORCE_PROD=1`, npm run
 *   electron:dev:prod): the file is read from the project root instead of
 *   Resources, so prod behavior can be debugged without packaging.
 * - Plain dev runs never read this file.
 *
 * Only the variables in {@link EnvProductionConstants.AppliedEnvVars} are
 * propagated into `process.env` (and never override values that are already
 * set) so a stray line in the file cannot leak into the gateway or skills.
 */

export const EnvProductionConstants = {
  /**
   * Set to `1` (npm run electron:dev:prod) to make an unpackaged dev build
   * resolve prod-only configuration the way a packaged build would.
   */
  ForceProdEnvVar: 'LOBSTERAI_FORCE_PROD',
  AppliedEnvVars: ['LIT_SERVER_BASE_URL'],
} as const;

/**
 * Parse KEY=VALUE lines from an env file. Skips blank lines and `#`
 * comments; strips matching quotes around values. Deliberately minimal —
 * no dotenv dependency for a couple of variables.
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

/** True for packaged builds and forced-prod dev runs. */
export function isProdLikeBuild(): boolean {
  return app.isPackaged || process.env[EnvProductionConstants.ForceProdEnvVar] === '1';
}

let cachedEnv: Record<string, string> | null = null;

function getEnvProductionPath(): string {
  // Packaged builds read Resources/.env.production; a forced-prod dev run
  // reads the file from the project root (app.getAppPath() === repo root).
  return app.isPackaged
    ? path.join(process.resourcesPath, '.env.production')
    : path.join(app.getAppPath(), '.env.production');
}

/**
 * Read and parse `.env.production` once (cached). Returns `{}` with a warn
 * when the file is missing or unreadable — a broken bundle must never brick
 * startup; callers fall back to their dev defaults.
 */
export function loadEnvProduction(): Record<string, string> {
  if (cachedEnv) return cachedEnv;
  const envPath = getEnvProductionPath();
  try {
    cachedEnv = parseEnvFileContent(fs.readFileSync(envPath, 'utf8'));
  } catch {
    console.warn(`[EnvProduction] ${envPath} not found or unreadable; prod env overrides are disabled`);
    cachedEnv = {};
  }
  return cachedEnv;
}

/** Test hook — the cache must not leak between test cases. */
export function resetEnvProductionCacheForTest(): void {
  cachedEnv = null;
}

/**
 * Copy the allowlisted prod overrides into `process.env` for code that reads
 * env vars directly (e.g. `getLitServerBaseUrl`). No-op in plain dev runs;
 * existing values always win so real process env stays authoritative.
 */
export function applyEnvProductionVars(): void {
  if (!isProdLikeBuild()) return;
  const env = loadEnvProduction();
  for (const key of EnvProductionConstants.AppliedEnvVars) {
    const value = env[key]?.trim();
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
