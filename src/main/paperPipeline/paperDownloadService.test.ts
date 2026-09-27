import * as fsp from 'node:fs/promises';

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Strategy 5 (hidden Cowork agent download) verification tests.
 *
 * The production bug (2026-09-17): the agent did the work but answered in
 * prose without the literal DOWNLOADED token, the caller required the
 * claim, and the whole first auto-run failed even though a valid PDF sat
 * at the target path. The fix: verify the file (size + PDF magic) whether
 * or not the agent claims success.
 *
 * `electron` is mocked because this module imports `net` (strategy 1-3
 * fetches) and, via `./storage`, `app`. net.fetch rejects so the
 * deterministic strategies return null and the run reaches strategy 5.
 *
 * The mocked userData root is a DEDICATED directory: test files run in
 * parallel workers, and sharing /tmp/paperPipeline with
 * paperPipelineService.test.ts (whose beforeEach also rm -rf's it) races
 * this file's ensurePaperPipelineDirs against that file's mid-flight
 * writes (observed as intermittent ENOENT on /tmp/paperPipeline/xml).
 */
const TEST_ROOT = '/tmp/lobsterai-paper-dl-test';

const netFetch = vi.fn();

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
  app: { getPath: () => TEST_ROOT },
}));

// Import after vi.mock so the mock is wired up before module init.
const { downloadPdf, PaperPdfDownloadError } = await import('./paperDownloadService');
const { getPaperPipelineHtmlPath, getPaperPipelinePdfPath } = await import('./storage');

const PMID = '39363784';

function buildValidPdfBytes(): Buffer {
  // %PDF- magic + padding past the 1KB floor.
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(2048, 0x61),
  ]);
}

describe('downloadPdf strategy 5 (agent download)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    netFetch.mockRejectedValue(new Error('offline'));
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  });

  test('accepts the file when the agent did not claim DOWNLOADED', async () => {
    // The agent downloads to the target path but replies in prose.
    const agentDownload = vi.fn(async (args: { localPath: string }) => {
      await fsp.writeFile(args.localPath, buildValidPdfBytes());
      return false;
    });

    const result = await downloadPdf({
      pmid: PMID,
      downloadViaAgent: agentDownload,
    });

    const expectedPath = getPaperPipelinePdfPath(PMID);
    expect(result.localPath).toBe(expectedPath);
    expect(result.bytes).toBe(buildValidPdfBytes().length);
  });

  test('rejects when the agent claims DOWNLOADED but left no valid file', async () => {
    const agentDownload = vi.fn(async () => true);

    await expect(
      downloadPdf({ pmid: PMID, downloadViaAgent: agentDownload }),
    ).rejects.toThrow(/agent claimed DOWNLOADED but the file at the target path is not a valid PDF/);
  });

  test('rejects when the agent neither claims nor leaves a file', async () => {
    const agentDownload = vi.fn(async () => false);

    await expect(
      downloadPdf({ pmid: PMID, downloadViaAgent: agentDownload }),
    ).rejects.toThrow(/All PDF strategies exhausted/);
  });

  test('rejects an agent-written file that is not a PDF (HTML interstitial)', async () => {
    const agentDownload = vi.fn(async (args: { localPath: string }) => {
      const html = Buffer.from('<html>verify you are human</html>');
      await fsp.writeFile(args.localPath, Buffer.concat([html, Buffer.alloc(2048, 0x61)]));
      return true;
    });

    await expect(
      downloadPdf({ pmid: PMID, downloadViaAgent: agentDownload }),
    ).rejects.toThrow(/All PDF strategies exhausted/);
  });

  test('accepts the file even when the agent turn timed out after downloading', async () => {
    // Observed 2026-09-18 (PMID 35688311): the 240s turn timer fired while
    // the agent was finishing up, the timeout propagated as a rejection,
    // and the catch path skipped the file verification — a valid PDF at
    // the target path was thrown away and the task marked failed. The
    // catch path must verify the file too.
    const agentDownload = vi.fn(async (args: { localPath: string }) => {
      await fsp.writeFile(args.localPath, buildValidPdfBytes());
      throw new Error('hiddenCoworkSession timed out after 300000ms');
    });

    const result = await downloadPdf({
      pmid: PMID,
      downloadViaAgent: agentDownload,
    });

    expect(result.localPath).toBe(getPaperPipelinePdfPath(PMID));
    expect(result.bytes).toBe(buildValidPdfBytes().length);
  });

  test('rejects on agent timeout when no file was written', async () => {
    const agentDownload = vi.fn(async () => {
      throw new Error('hiddenCoworkSession timed out after 300000ms');
    });

    await expect(
      downloadPdf({ pmid: PMID, downloadViaAgent: agentDownload }),
    ).rejects.toThrow(/All PDF strategies exhausted.*timed out/);
  });
});

describe('downloadPdf closed-access HTML fallback', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: offline for every URL, including the landing-page sources.
    netFetch.mockRejectedValue(new Error('offline'));
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  });

  function htmlResponse(body: string): Response {
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response;
  }

  test('saves the PubMed landing page when every PDF strategy fails', async () => {
    // Observed 2026-09-19 (PMIDs 38342193, 41564652): genuinely closed
    // access — no PMC ID, paywalled publisher, no OA copy via unpaywall /
    // OpenAlex. No PDF exists to download, but the public landing page
    // should still land at html/<pmid>.html and the error should say so.
    const page = `<!DOCTYPE html><html><head><title>${PMID} - PubMed</title></head>` +
      `<body><h1>Closed access article abstract</h1>${'<p>abstract text</p>'.repeat(80)}</body></html>`;
    netFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://pubmed.ncbi.nlm.nih.gov/')) {
        return htmlResponse(page);
      }
      throw new Error('offline');
    });
    const agentDownload = vi.fn(async () => false);

    const error = await downloadPdf({ pmid: PMID, downloadViaAgent: agentDownload })
      .catch((err: Error) => err);

    // The structured htmlPath is what the orchestrator's closed-access
    // continuation reads; the message text alone is for logs.
    expect(error).toBeInstanceOf(PaperPdfDownloadError);
    expect((error as PaperPdfDownloadError).htmlPath).toBe(getPaperPipelineHtmlPath(PMID));
    expect(error.message).toMatch(/All PDF strategies exhausted.*landing page saved to/);

    const htmlPath = getPaperPipelineHtmlPath(PMID);
    const saved = await fsp.readFile(htmlPath, 'utf-8');
    expect(saved).toContain('Closed access article abstract');
  });

  test('saves the Europe PMC page when PubMed is unreachable', async () => {
    const page = `<html><body>${'<p>europepmc record</p>'.repeat(100)}</body></html>`;
    netFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://europepmc.org/')) {
        return htmlResponse(page);
      }
      throw new Error('offline');
    });

    const error = await downloadPdf({ pmid: PMID, downloadViaAgent: vi.fn(async () => false) })
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(PaperPdfDownloadError);
    expect((error as PaperPdfDownloadError).htmlPath).toBe(getPaperPipelineHtmlPath(PMID));

    await expect(fsp.readFile(getPaperPipelineHtmlPath(PMID), 'utf-8')).resolves.toContain('europepmc record');
  });

  test('saves nothing when the landing-page body is an interstitial, not HTML', async () => {
    // A CAPTCHA / "verify you are human" answer: small body, no <html>
    // document — must not be cached as the paper's landing page.
    netFetch.mockImplementation(async () =>
      htmlResponse('<html>verify you are human</html>'),
    );

    const error = await downloadPdf({
      pmid: PMID,
      downloadViaAgent: vi.fn(async () => false),
    }).catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/All PDF strategies exhausted/);
    expect(error.message).not.toContain('landing page saved');
    expect(error.message).toContain('Reset the task once a strategy is available');
    expect((error as PaperPdfDownloadError).htmlPath).toBeNull();
    await expect(fsp.stat(getPaperPipelineHtmlPath(PMID))).rejects.toThrow();
  });
});
