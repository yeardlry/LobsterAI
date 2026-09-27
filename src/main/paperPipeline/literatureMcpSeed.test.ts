import { describe, expect, test, vi } from 'vitest';

// The module imports `electron` for the seed entry point; the pure helpers
// tested here never touch it, but the import still resolves at load time.
vi.mock('electron', () => ({ app: { isPackaged: false } }));

import {
  LiteratureMcpSeedConstants,
  type LiteratureMcpSeedServerView,
  parseEnvFileContent,
  planLiteratureMcpSeed,
  resolveLiteratureMcpTargetUrl,
} from './literatureMcpSeed';

const PROD_URL = 'https://ailiteraturemanager.yeardlry.cn:3000/mcp';

function serverView(overrides: Partial<LiteratureMcpSeedServerView>): LiteratureMcpSeedServerView {
  return {
    id: 'srv-1',
    name: 'literature-manager',
    transportType: 'streamable-http',
    useAuthToken: true,
    locked: true,
    ...overrides,
  };
}

describe('parseEnvFileContent', () => {
  test('parses KEY=VALUE lines and skips comments/blank lines', () => {
    const env = parseEnvFileContent(
      [
        '# comment',
        '',
        'LITERATURE_MCP_URL=' + PROD_URL,
        '  OTHER=x  ',
        'novalue',
        '=missing-key',
      ].join('\n'),
    );
    expect(env).toEqual({
      LITERATURE_MCP_URL: PROD_URL,
      OTHER: 'x',
    });
  });

  test('strips matching quotes around values', () => {
    const env = parseEnvFileContent(`A="quoted"\nB='single'`);
    expect(env).toEqual({ A: 'quoted', B: 'single' });
  });

  test('handles CRLF line endings', () => {
    const env = parseEnvFileContent(`LITERATURE_MCP_URL=${PROD_URL}\r\nOTHER=y\r\n`);
    expect(env.LITERATURE_MCP_URL).toBe(PROD_URL);
    expect(env.OTHER).toBe('y');
  });
});

describe('resolveLiteratureMcpTargetUrl', () => {
  test('uses the env value when present and http(s)', () => {
    expect(resolveLiteratureMcpTargetUrl({ LITERATURE_MCP_URL: PROD_URL })).toEqual({
      url: PROD_URL,
      source: 'env',
    });
  });

  test('falls back to the dev URL when missing, blank, or non-http', () => {
    for (const env of [{}, { LITERATURE_MCP_URL: '' }, { LITERATURE_MCP_URL: '  ' }, { LITERATURE_MCP_URL: 'ftp://example.com' }]) {
      expect(resolveLiteratureMcpTargetUrl(env)).toEqual({
        url: LiteratureMcpSeedConstants.DevUrl,
        source: 'fallback',
      });
    }
  });
});

describe('planLiteratureMcpSeed', () => {
  test('creates when no stored server matches either URL', () => {
    const servers = [serverView({ id: 'a', url: 'https://unrelated.example.com/mcp' })];
    expect(planLiteratureMcpSeed(servers, PROD_URL)).toEqual({
      action: 'create',
      url: PROD_URL,
    });
  });

  test('creates when there are no servers at all', () => {
    expect(planLiteratureMcpSeed([], LiteratureMcpSeedConstants.DevUrl)).toEqual({
      action: 'create',
      url: LiteratureMcpSeedConstants.DevUrl,
    });
  });

  test('updates a dev-URL record to the prod target URL', () => {
    const servers = [
      serverView({ id: 'a', url: LiteratureMcpSeedConstants.DevUrl }),
      serverView({ id: 'b', url: 'https://unrelated.example.com/mcp' }),
    ];
    expect(planLiteratureMcpSeed(servers, PROD_URL)).toEqual({
      action: 'update',
      serverId: 'a',
      url: PROD_URL,
    });
  });

  test('is a no-op when the target-URL record is already correct', () => {
    const servers = [serverView({ id: 'a', url: PROD_URL })];
    expect(planLiteratureMcpSeed(servers, PROD_URL)).toEqual({ action: 'none' });
  });

  test('corrects transportType and useAuthToken on a URL match', () => {
    const servers = [
      serverView({ id: 'a', url: PROD_URL, transportType: 'http', useAuthToken: undefined }),
    ];
    expect(planLiteratureMcpSeed(servers, PROD_URL)).toEqual({
      action: 'update',
      serverId: 'a',
      url: PROD_URL,
    });
  });

  test('locks an unlocked URL-matched record (delete protection)', () => {
    const servers = [serverView({ id: 'a', url: PROD_URL, locked: undefined })];
    expect(planLiteratureMcpSeed(servers, PROD_URL)).toEqual({
      action: 'update',
      serverId: 'a',
      url: PROD_URL,
    });
  });

  test('ignores stdio servers without a URL', () => {
    const servers = [serverView({ id: 'a', url: undefined, transportType: 'stdio' })];
    expect(planLiteratureMcpSeed(servers, PROD_URL)).toEqual({
      action: 'create',
      url: PROD_URL,
    });
  });
});
