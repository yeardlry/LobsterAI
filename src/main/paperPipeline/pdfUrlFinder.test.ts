import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
const { findPdfUrl } = await import('./pdfUrlFinder');

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

  test('extracts first https URL from token-proxy reply when proxy is up', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: 'https://example.com/foo.pdf' } },
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

    expect(url).toBe('https://example.com/foo.pdf');
    expect(netFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = netFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('http://127.0.0.1:18888/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.model).toContain('deepseek');
    expect(body.messages[0].content).toContain('12345');
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('falls back to hidden Cowork session when token-proxy throws', async () => {
    netFetch.mockRejectedValue(new Error('proxy down'));
    runHiddenCoworkSessionSpy.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'Use this PDF: https://example.org/x.pdf thanks',
      segmentCount: 1,
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: { on: vi.fn(), off: vi.fn() } as unknown as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: { createSession: vi.fn(), getSession: vi.fn() } as unknown as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/agent-cwd',
    };

    const url = await findPdfUrl({ pmid: '99999', deps });

    expect(url).toBe('https://example.org/x.pdf');
    expect(runHiddenCoworkSessionSpy).toHaveBeenCalledTimes(1);
    const callArgs = runHiddenCoworkSessionSpy.mock.calls[0];
    expect(callArgs[0].prompt).toContain('99999');
    expect(callArgs[0].agentId).toBe('main');
  });

  test('returns null when proxy is down AND no hidden-session deps are wired', async () => {
    netFetch.mockRejectedValue(new Error('proxy down'));
    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => null,
      // No coworkRuntime/store/resolveAgentCwd — priority-2 disabled.
    };
    const url = await findPdfUrl({ pmid: '1', deps });
    expect(url).toBeNull();
    expect(runHiddenCoworkSessionSpy).not.toHaveBeenCalled();
  });

  test('returns null when both strategies return NO_PDF', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'NO_PDF' } }] }),
    });
    runHiddenCoworkSessionSpy.mockResolvedValue({
      sessionId: 's',
      finalText: 'NO_PDF',
      segmentCount: 0,
    });

    const deps: PdfUrlFinderDeps = {
      getTokenProxyPort: () => 18888,
      coworkRuntime: {} as PdfUrlFinderDeps['coworkRuntime'],
      coworkStore: {} as PdfUrlFinderDeps['coworkStore'],
      resolveAgentCwd: () => '/tmp/cwd',
    };
    const url = await findPdfUrl({ pmid: '1', deps });
    expect(url).toBeNull();
    // Token-proxy already returned NO_PDF, but the priority-2 branch is
    // still attempted. Confirms both strategies ran.
    expect(runHiddenCoworkSessionSpy).toHaveBeenCalledTimes(1);
  });
});