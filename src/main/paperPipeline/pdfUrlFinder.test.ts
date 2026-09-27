import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_PDF_URL_SUGGEST_MODEL } from '../../shared/paperPipeline/constants';
import * as hiddenCoworkModule from '../libs/agentEngine/hiddenCoworkSession';
import type { PdfUrlFinderDeps } from './pdfUrlFinder';

/**
 * Phase 6 + 7 — LLM-driven PDF URL finder priority chain.
 *
 * The real implementation uses Electron's `net.fetch` (for the token
 * proxy) and a real `CoworkRuntime` / `CoworkStore` (for Phase 7 hidden
 * sessions). We mock `electron` here so the token-proxy test runs in
 * plain Node, and we stub `runHiddenCoworkSession` via a spy so the
 * hidden-session tests don't need to spin up a real Cowork runtime.
 */
const netFetch = vi.fn();

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
}));

// Import after vi.mock so the mock is wired up before module init.
const { downloadPdfViaHiddenCoworkSession, findPdfUrl } = await import('./pdfUrlFinder');

describe('pdfUrlFinder', () => {
  let runHiddenCoworkSessionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    netFetch.mockReset();
    runHiddenCoworkSessionSpy = vi
      .spyOn(hiddenCoworkModule, 'runHiddenCoworkSession')
      // Default: throw so a stray call shows up loudly in test output.
      .mockRejectedValue(new Error('hidden session not stubbed in this test'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('extracts https URLs from token-proxy reply when proxy is up', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              // Models routinely ignore the "one line" instruction and
              // return prose with several candidates — dead first, good
              // last. All distinct URLs should come back, in order.
              content:
                'PMC 链接是 https://pmc.example.org/articles/PMC1/pdf/，' +
                '不过这个更好：https://example.com/foo.pdf',
            },
          },
        ],
      }),
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
    };

    const url = await findPdfUrl({
      pmid: '12345',
      title: 'Some title',
      abstractText: 'Some abstract',
      deps,
    });

    expect(url).toEqual([
      'https://pmc.example.org/articles/PMC1/pdf/',
      'https://example.com/foo.pdf',
    ]);
    expect(netFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = netFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('http://127.0.0.1:18888/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.model).toContain('deepseek');
    expect(body.messages[0].content).toContain('12345');
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('token-proxy POST body uses the configured suggestModel verbatim', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'https://example.com/a.pdf' } }] }),
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
    };

    const url = await findPdfUrl({
      pmid: '1',
      deps,
      suggestModel: 'zhipu/glm-4.7',
    });

    expect(url).toEqual(['https://example.com/a.pdf']);
    const [, init] = netFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe('zhipu/glm-4.7');
  });

  test('token-proxy POST body falls back to the shared default model when suggestModel is unset', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'https://example.com/a.pdf' } }] }),
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
    };

    await findPdfUrl({ pmid: '1', deps });

    const [, init] = netFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe(DEFAULT_PDF_URL_SUGGEST_MODEL);
  });

  test('returns empty list when token-proxy throws — URL finding has no session fallback', async () => {
    netFetch.mockRejectedValue(new Error('proxy down'));

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: { on: vi.fn(), off: vi.fn() } as unknown as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: { createSession: vi.fn(), getSession: vi.fn() } as unknown as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/agent-cwd',
    };

    // The hidden session is download-capable and supersedes URL finding;
    // it must NOT be driven from findPdfUrl.
    const url = await findPdfUrl({ pmid: '99999', deps });

    expect(url).toEqual([]);
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('returns empty list when proxy is down AND no hidden-session deps are wired', async () => {
    netFetch.mockRejectedValue(new Error('proxy down'));
    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => null,
      // No coworkRuntime/store/resolveAgentCwd — agent download disabled.
    };
    const url = await findPdfUrl({ pmid: '1', deps });
    expect(url).toEqual([]);
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('returns empty list when the model replies NO_PDF', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'NO_PDF' } }] }),
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
    };
    const url = await findPdfUrl({ pmid: '1', deps });
    expect(url).toEqual([]);
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('agent download: returns true and passes localPath when the agent replies DOWNLOADED', async () => {
    runHiddenCoworkSessionSpy.mockResolvedValue({
      sessionId: 'sess-dl',
      finalText: 'DOWNLOADED',
      segmentCount: 1,
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: {} as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: {} as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/cwd',
    };
    const ok = await downloadPdfViaHiddenCoworkSession({
      pmid: '40672218',
      localPath: '/tmp/pipeline/40672218.pdf',
      title: 'Some title',
      abstractText: 'Some abstract',
      deps,
    });

    expect(ok).toBe(true);
    expect(runHiddenCoworkSessionSpy).toHaveBeenCalledTimes(1);
    const callArgs = runHiddenCoworkSessionSpy.mock.calls[0];
    expect(callArgs[0].agentId).toBe('main');
    // The prompt must carry the exact target path and identifying context.
    expect(callArgs[0].prompt).toContain('/tmp/pipeline/40672218.pdf');
    expect(callArgs[0].prompt).toContain('40672218');
    // Headless policy: the agent must never open a browser for the download —
    // CLI tools only, walking sources until one answers a direct download.
    expect(callArgs[0].prompt).toContain('禁止打开浏览器');
    expect(callArgs[0].prompt).toContain('curl');
  });

  test('agent download: forwards modelOverride into the hidden session', async () => {
    runHiddenCoworkSessionSpy.mockResolvedValue({
      sessionId: 'sess-dl',
      finalText: 'DOWNLOADED',
      segmentCount: 1,
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: {} as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: {} as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/cwd',
    };
    const ok = await downloadPdfViaHiddenCoworkSession({
      pmid: '1',
      localPath: '/tmp/pipeline/1.pdf',
      deps,
      modelOverride: 'deepseek/deepseek-v4-flash',
    });

    expect(ok).toBe(true);
    expect(runHiddenCoworkSessionSpy.mock.calls[0][0].modelOverride).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });

  test('agent download: returns false when the agent replies NO_PDF', async () => {
    runHiddenCoworkSessionSpy.mockResolvedValue({
      sessionId: 'sess-dl',
      finalText: 'NO_PDF',
      segmentCount: 1,
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: {} as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: {} as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/cwd',
    };
    const ok = await downloadPdfViaHiddenCoworkSession({
      pmid: '1',
      localPath: '/tmp/pipeline/1.pdf',
      deps,
    });
    expect(ok).toBe(false);
  });

  test('agent download: returns false when session deps are not wired', async () => {
    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      // No coworkRuntime/store/resolveAgentCwd.
    };
    const ok = await downloadPdfViaHiddenCoworkSession({
      pmid: '1',
      localPath: '/tmp/pipeline/1.pdf',
      deps,
    });
    expect(ok).toBe(false);
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('agent download: session failures (e.g. timeout) propagate as rejections', async () => {
    runHiddenCoworkSessionSpy.mockRejectedValue(
      new Error('hiddenCoworkSession timed out after 240000ms'),
    );

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: {} as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: {} as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/cwd',
    };
    await expect(
      downloadPdfViaHiddenCoworkSession({
        pmid: '1',
        localPath: '/tmp/pipeline/1.pdf',
        deps,
      }),
    ).rejects.toThrow('timed out');
  });
});