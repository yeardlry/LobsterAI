import * as fsp from 'node:fs/promises';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PDF_URL_SUGGEST_MODEL,
  PaperPipelineAdvanceAction,
  PaperPipelineProcessingStatus,
} from '../../shared/paperPipeline/constants';
import type { PaperPipelineModelConfig } from '../../shared/paperPipeline/types';

/**
 * `advanceTaskAuto` loop tests. The heavy step collaborators are mocked so
 * the test drives ONLY the orchestration: which steps run, in what order,
 * and where the run stops. `electron` is mocked because the transitive
 * imports (`paperPipelineClient`, `storage`) touch `net` / `app`.
 */
const netFetch = vi.fn();

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
  app: { getPath: () => '/tmp' },
}));

const downloadPdfMock = vi.fn();
const ensureClosedAccessLandingPageMock = vi.fn();
vi.mock('./paperDownloadService', () => {
  // Mirror the real error class (htmlPath option) so the service's
  // instanceof check and the test's error construction share THIS class —
  // constructing a plain Error would fail the instanceof gate.
  class PaperPdfDownloadError extends Error {
    readonly htmlPath?: string | null;
    constructor(message: string, options: { htmlPath?: string | null } = {}) {
      super(message);
      this.name = 'PaperPdfDownloadError';
      this.htmlPath = options.htmlPath ?? null;
    }
  }
  return {
    downloadPdf: (...args: unknown[]) => downloadPdfMock(...args),
    ensureClosedAccessLandingPage: (...args: unknown[]) => ensureClosedAccessLandingPageMock(...args),
    PaperPdfDownloadError,
  };
});

const uploadFileMock = vi.fn();
vi.mock('./paperFileUpload', () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

const generateAnalysisMock = vi.fn();
vi.mock('./analysisService', () => ({
  generateAnalysis: (...args: unknown[]) => generateAnalysisMock(...args),
}));

const pickCategoriesMock = vi.fn();
vi.mock('./categoryService', () => ({
  pickCategories: (...args: unknown[]) => pickCategoriesMock(...args),
}));

const getExistingFulltextMdPathMock = vi.fn();
const convertFulltextToMarkdownMock = vi.fn();
vi.mock('./fulltextMdService', () => ({
  getExistingFulltextMdPath: (...args: unknown[]) => getExistingFulltextMdPathMock(...args),
  convertFulltextToMarkdown: (...args: unknown[]) => convertFulltextToMarkdownMock(...args),
}));

vi.mock('./pdfUrlFinder', () => ({
  findPdfUrl: vi.fn(),
  downloadPdfViaHiddenCoworkSession: vi.fn(),
  // No Cowork trio wired → the analysis / categorize LLM paths skip and
  // the deterministic fallbacks run, keeping this test offline-stable.
  buildDefaultPdfUrlFinderDeps: () => ({ getTokenProxyPort: () => null }),
}));

const prepareWechatDraftMock = vi.fn();
vi.mock('./wechatArticleService', () => ({
  prepareWechatDraft: (...args: unknown[]) => prepareWechatDraftMock(...args),
}));

// Import after vi.mock so the mocks are wired up before module init.
const { PaperPipelineService } = await import('./paperPipelineService');
// The mocked class above — shared with the service's instanceof check.
const { PaperPdfDownloadError } = await import('./paperDownloadService');

const PMID = '12345';
/** Mirrors the real `downloadPdf` cache location (userData → /tmp). */
const PDF_PATH = `/tmp/paperPipeline/pdfs/${PMID}.pdf`;

const SAMPLE_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <Article>
        <ArticleTitle>LNP delivery of mRNA vaccines</ArticleTitle>
        <Abstract>
          <AbstractText>This paper describes a novel lipid nanoparticle system for mRNA delivery.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><ForeName>Alice</ForeName><LastName>Reiser</LastName></Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

function buildService(overrides?: {
  submitAnalysis?: () => Promise<unknown>;
  /**
   * Optional Cowork-store-like stub wired into the service constructor's
   * `deps.coworkStore` thunk. Used by the expert-agent auto-detect tests
   * (2026-09-19): when the user has installed a "生物研究" expert, the
   * orchestrator looks it up via `store.listAgents()` and threads its id
   * through every LLM-driven step. Default: undefined ⇒ service falls
   * back to the `main` agent (the pre-existing behaviour).
   * `getAgent` is optional: it feeds the model-override resolution (the
   * agent's model binding).
   */
  coworkStore?: {
    listAgents: () => Array<{ id: string; name: string; enabled: boolean }>;
    getAgent?: (id: string) => { model?: string } | null;
  };
  /**
   * Optional pipeline model config wired into the constructor's
   * `getPipelineModelConfig` thunk. Default: undefined ⇒ the service
   * resolves the default config (`pipelineModel: ''` — smart follow).
   */
  modelConfig?: PaperPipelineModelConfig;
}): {
  service: InstanceType<typeof PaperPipelineService>;
  client: Record<string, ReturnType<typeof vi.fn>>;
  emitter: { emitStatusChanged: ReturnType<typeof vi.fn>; emitLog: ReturnType<typeof vi.fn> };
} {
  const client = {
    getDeps: vi.fn(() => ({})),
    getXmlContent: vi.fn(async () => SAMPLE_XML),
    submitParseResult: vi.fn(async () => ({
      pmid: PMID,
      toStatus: PaperPipelineProcessingStatus.Parsed,
    })),
    submitAnalysis: vi.fn(overrides?.submitAnalysis ?? (async () => ({
      pmid: PMID,
      toStatus: PaperPipelineProcessingStatus.Analyzed,
    }))),
    submitCategories: vi.fn(async () => ({
      pmid: PMID,
      toStatus: PaperPipelineProcessingStatus.Categorized,
    })),
    submitFile: vi.fn(async () => ({
      pmid: PMID,
      toStatus: PaperPipelineProcessingStatus.PdfReady,
    })),
    reportTaskFailure: vi.fn(async () => ({
      pmid: PMID,
      toStatus: PaperPipelineProcessingStatus.Failed,
    })),
  };
  const emitter = { emitStatusChanged: vi.fn(), emitLog: vi.fn() };
  const serviceDeps: Record<string, unknown> = {};
  if (overrides?.coworkStore) serviceDeps.coworkStore = overrides.coworkStore;
  if (overrides?.modelConfig !== undefined) {
    serviceDeps.getPipelineModelConfig = () => overrides.modelConfig;
  }
  return {
    service: new PaperPipelineService(
      client as unknown as ConstructorParameters<typeof PaperPipelineService>[0],
      emitter as unknown as ConstructorParameters<typeof PaperPipelineService>[1],
      Object.keys(serviceDeps).length > 0 ? serviceDeps : undefined,
    ),
    client,
    emitter,
  };
}

describe('advanceTaskAuto', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The mocked `app.getPath('userData')` points at /tmp, and the XML
    // cache persists between runs — clear it so `getXmlContent` (and its
    // call-count assertions) is deterministic.
    await fsp.rm('/tmp/paperPipeline', { recursive: true, force: true });
    // The real downloadPdf lands the file in the cache dir — the run's
    // hasFulltextSource gate (graceful-end check) stats it, so the mock
    // must write it too.
    downloadPdfMock.mockImplementation(async () => {
      await fsp.mkdir('/tmp/paperPipeline/pdfs', { recursive: true });
      await fsp.writeFile(PDF_PATH, 'x'.repeat(2048), 'utf-8');
      return { bytes: 2048, localPath: PDF_PATH };
    });
    uploadFileMock.mockResolvedValue({ url: `pdf/${PMID}.pdf`, publicUrl: 'https://oss/pdf/12345.pdf' });
    generateAnalysisMock.mockResolvedValue('【标题】 heuristic extSummary');
    pickCategoriesMock.mockResolvedValue({ categoryIds: ['293'], tagIds: ['88'] });
    getExistingFulltextMdPathMock.mockResolvedValue(null);
    convertFulltextToMarkdownMock.mockResolvedValue(null);
    ensureClosedAccessLandingPageMock.mockResolvedValue(null);
    prepareWechatDraftMock.mockResolvedValue({
      localMarkdownPath: '/tmp/wechat-12345.md',
      markdownUrl: 'https://oss/md/12345.md',
      renderedTitle: 'A draft title',
      renderedSummary: 'A draft summary',
    });
    netFetch.mockRejectedValue(new Error('offline'));
  });

  test('runs every remaining step from xml_ready and stops after the word upload', async () => {
    const { service, client } = buildService();

    const result = await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // Shared AdvanceContext: the title/abstract mined at the ParseXml step
    // must reach the PDF download prompt on the same auto-run (the
    // production bug had title=null because each step got a fresh ctx).
    expect(downloadPdfMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      title: 'LNP delivery of mRNA vaccines',
      abstractText: 'This paper describes a novel lipid nanoparticle system for mRNA delivery.',
    }));
    // The full chain ran exactly once each, in order. `downloadPdf` runs
    // TWICE: once in the full-text acquisition (user-required order:
    // category pick → download → md conversion → analysis) and once in the
    // file step — the real downloadPdf would cache-hit the second call; the
    // mock just resolves again.
    expect(client.getXmlContent).toHaveBeenCalledTimes(1);
    expect(client.submitParseResult).toHaveBeenCalledTimes(1);
    expect(client.submitAnalysis).toHaveBeenCalledTimes(1);
    expect(client.submitCategories).toHaveBeenCalledTimes(1);
    // The pre-picked category/tag ids ride through to the submit.
    expect(client.submitCategories).toHaveBeenCalledWith(PMID, ['293'], ['88'], undefined);
    expect(downloadPdfMock).toHaveBeenCalledTimes(2);
    // User-required work order (2026-09-19): the category pick runs BEFORE
    // the download, and the download BEFORE the analysis is submitted.
    expect(pickCategoriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      downloadPdfMock.mock.invocationCallOrder[0],
    );
    expect(downloadPdfMock.mock.invocationCallOrder[0]).toBeLessThan(
      client.submitAnalysis.mock.invocationCallOrder[0],
    );
    // The pre-pick runs before the analysis exists, so it carries an empty
    // extSummary and works off the title/abstract/XML.
    expect(pickCategoriesMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      extSummary: '',
    }));
    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      fileType: 'pdf',
    }));
    expect(client.submitFile).toHaveBeenCalledWith(
      PMID,
      'pdf',
      `pdf/${PMID}.pdf`,
      undefined,
    );
    // Stop node: the WeChat draft step (md + word export + word upload)
    // ran and the task stays at pdf_ready awaiting the user's docUrl.
    expect(prepareWechatDraftMock).toHaveBeenCalledTimes(1);
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
  });

  test('resumes from a mid-pipeline status without re-running earlier steps', async () => {
    const { service, client } = buildService();

    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.Analyzed,
    );

    expect(client.submitParseResult).not.toHaveBeenCalled();
    expect(client.submitAnalysis).not.toHaveBeenCalled();
    expect(client.submitCategories).toHaveBeenCalledTimes(1);
    expect(client.submitCategories).toHaveBeenCalledWith(PMID, ['293'], ['88'], undefined);
    // The category pre-pick ran BEFORE the download (user-required order).
    expect(pickCategoriesMock).toHaveBeenCalledTimes(1);
    expect(pickCategoriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      downloadPdfMock.mock.invocationCallOrder[0],
    );
    // Acquisition download + the file step's (cache-hit) download.
    expect(downloadPdfMock).toHaveBeenCalledTimes(2);
    // The analysis was already submitted in a previous run — the md
    // conversion (whose only consumer is the extSummary) is skipped.
    expect(convertFulltextToMarkdownMock).not.toHaveBeenCalled();
    expect(prepareWechatDraftMock).toHaveBeenCalledTimes(1);
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('stops at the first failing step and reports it', async () => {
    const { service, client } = buildService({
      submitAnalysis: () => Promise.reject(new Error('analysis rejected by backend')),
    });

    await expect(
      service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady),
    ).rejects.toThrow('analysis rejected by backend');

    // The failure was reported and later steps never ran. The pre-fetch
    // download DID run (it precedes the Analyze step), but nothing was
    // uploaded or submitted.
    expect(client.reportTaskFailure).toHaveBeenCalledTimes(1);
    expect(client.submitCategories).not.toHaveBeenCalled();
    expect(downloadPdfMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(client.submitFile).not.toHaveBeenCalled();
    expect(prepareWechatDraftMock).not.toHaveBeenCalled();
  });

  test('rejects non-runnable statuses instead of spinning', async () => {
    const { service } = buildService();
    await expect(
      service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.Completed),
    ).rejects.toThrow(/Cannot auto-advance/);
  });

  test('each intermediate step emits a status change push', async () => {
    const { service, emitter } = buildService();

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const statuses = emitter.emitStatusChanged.mock.calls.map(
      (call: unknown[]) => (call[0] as { toStatus: string }).toStatus,
    );
    expect(statuses).toEqual([
      PaperPipelineProcessingStatus.Parsed,
      PaperPipelineProcessingStatus.Analyzed,
      PaperPipelineProcessingStatus.Categorized,
      PaperPipelineProcessingStatus.PdfReady,
    ]);
  });

  test('single-step advanceTask still runs exactly one transition', async () => {
    const { service, client } = buildService();

    const result = await service.advanceTask(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
    );

    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.Parsed);
    expect(client.submitAnalysis).not.toHaveBeenCalled();
  });

  test('feeds the converted full-text markdown into the analysis', async () => {
    const fulltextMdPath = `/tmp/paperPipeline/fulltext/${PMID}.md`;
    convertFulltextToMarkdownMock.mockResolvedValue(fulltextMdPath);

    const { service } = buildService();
    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // The pre-fetch downloaded the PDF and converted it to md BEFORE the
    // analysis ran, and the analysis prompt got the md as its input.
    expect(convertFulltextToMarkdownMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      sourcePath: PDF_PATH,
      sourceKind: 'pdf',
      title: 'LNP delivery of mRNA vaccines',
    }));
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      fulltextMdPath,
    }));
  });

  test('retries the md conversion twice before the third attempt succeeds', async () => {
    // User decision 2026-09-19: a failed conversion gets 2 retries (three
    // attempts total) before the run continues without the md.
    const fulltextMdPath = `/tmp/paperPipeline/fulltext/${PMID}.md`;
    convertFulltextToMarkdownMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fulltextMdPath);

    const { service } = buildService();
    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    expect(convertFulltextToMarkdownMock).toHaveBeenCalledTimes(3);
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      fulltextMdPath,
    }));
  });

  test('continues past a persistently failing md conversion', async () => {
    // All three conversion attempts fail, but the PDF IS on disk: the run
    // still submits the file and generates the WeChat draft (the draft
    // session reads the PDF directly) — the md is a quality enhancement
    // for the analysis, not a gate (user decision 2026-09-19).
    convertFulltextToMarkdownMock.mockResolvedValue(null);

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    expect(convertFulltextToMarkdownMock).toHaveBeenCalledTimes(3);
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      fulltextMdPath: undefined,
    }));
    expect(client.submitFile).toHaveBeenCalledTimes(1);
    expect(prepareWechatDraftMock).toHaveBeenCalledTimes(1);
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('re-picks inside the run when the category pre-pick fails', async () => {
    // The pre-pick throws (e.g. catalogue offline): the loop hook retries
    // the pick at the Categorize step, where the extSummary from the
    // Analyze step is available.
    pickCategoriesMock
      .mockRejectedValueOnce(new Error('catalogue down'))
      .mockResolvedValue({ categoryIds: ['7'], tagIds: [] });

    const { service, client } = buildService();
    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    expect(pickCategoriesMock).toHaveBeenCalledTimes(2);
    expect(pickCategoriesMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      extSummary: '【标题】 heuristic extSummary',
    }));
    expect(client.submitCategories).toHaveBeenCalledWith(PMID, ['7'], [], undefined);
  });

  test('re-picks at the Categorize step when the pre-pick returns empty lists', async () => {
    // User decision 2026-09-23: an all-empty pre-pick (LLM skipped, keyword
    // 0-hit) used to be locked in and submitted as-is — the task advanced
    // with NO tags. Now it resets so the Categorize step re-picks with the
    // extSummary and the warm pooled session.
    pickCategoriesMock
      .mockResolvedValueOnce({ categoryIds: [], tagIds: [] })
      .mockResolvedValue({ categoryIds: ['7'], tagIds: ['8'] });

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
    );

    expect(pickCategoriesMock).toHaveBeenCalledTimes(2);
    expect(pickCategoriesMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      extSummary: '【标题】 heuristic extSummary',
    }));
    expect(client.submitCategories).toHaveBeenCalledWith(PMID, ['7'], ['8'], undefined);
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('aborts the run when the catalogue stays unreachable (no tagless LLM run)', async () => {
    // User decision 2026-09-23: after the pre-pick AND the Categorize-step
    // retry both fail, the run must abort visibly — reportTaskFailure, no
    // empty category submit, no WeChat draft — instead of continuing LLM
    // steps and submitting 0 categories / 0 tags.
    pickCategoriesMock.mockRejectedValue(
      new Error('category catalogue unavailable after 3 attempts: network down'),
    );

    const { service, client } = buildService();
    await expect(
      service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady),
    ).rejects.toThrow('category catalogue unavailable after 3 attempts');

    // Three attempts, all swallowed-retried until the final one throws:
    // pre-pick at the Analyze step, pre-pick at the Categorize step entry,
    // and the in-case re-pick whose rejection propagates.
    expect(pickCategoriesMock).toHaveBeenCalledTimes(3);
    // The analysis submitted fine before the categorize abort.
    expect(client.submitAnalysis).toHaveBeenCalledTimes(1);
    expect(client.submitCategories).not.toHaveBeenCalled();
    expect(client.reportTaskFailure).toHaveBeenCalledTimes(1);
    expect(prepareWechatDraftMock).not.toHaveBeenCalled();
  });

  test('converts the closed-access landing page and skips the doomed download retry', async () => {
    // Genuinely closed-access from the very first step: the pre-fetch
    // download fails, the landing page is saved, and the file step must
    // NOT burn a second download chain on it.
    const htmlPath = `/tmp/paperPipeline/html/${PMID}.html`;
    await fsp.mkdir('/tmp/paperPipeline/html', { recursive: true });
    await fsp.writeFile(htmlPath, '<html><body>landing page</body></html>', 'utf-8');
    const fulltextMdPath = `/tmp/paperPipeline/fulltext/${PMID}.md`;
    downloadPdfMock.mockRejectedValue(new PaperPdfDownloadError(
      `All PDF strategies exhausted for PMID ${PMID} (last error: LLM PDF finder returned no usable URL). Closed access — landing page saved to ${htmlPath}`,
      { htmlPath },
    ));
    convertFulltextToMarkdownMock.mockResolvedValue(fulltextMdPath);
    uploadFileMock.mockResolvedValue({ url: `html/${PMID}.html`, publicUrl: 'https://oss/html/12345.html' });

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
    );

    // Exactly ONE download attempt (the pre-fetch) — the file step
    // short-circuited straight to the HTML fallback upload.
    expect(downloadPdfMock).toHaveBeenCalledTimes(1);
    expect(convertFulltextToMarkdownMock).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath: htmlPath,
      sourceKind: 'html',
    }));
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      fulltextMdPath,
    }));
    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      fileType: 'html',
      localPath: htmlPath,
    }));
    expect(client.submitFile).toHaveBeenCalledWith(PMID, 'html', `html/${PMID}.html`, undefined);
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('ends the run gracefully at categorized when no full text is obtainable', async () => {
    // Fully offline acquisition (no htmlPath on the error, nothing cached):
    // the analysis runs on the XML alone, the categories are submitted, and
    // the run ENDS at `categorized` — no failure report, no file submit —
    // so the next run retries the download (user decision 2026-09-19).
    downloadPdfMock.mockRejectedValue(new Error('offline'));

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    expect(downloadPdfMock).toHaveBeenCalledTimes(1);
    expect(convertFulltextToMarkdownMock).not.toHaveBeenCalled();
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      fulltextMdPath: undefined,
    }));
    expect(client.submitAnalysis).toHaveBeenCalledTimes(1);
    expect(client.submitCategories).toHaveBeenCalledTimes(1);
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(client.submitFile).not.toHaveBeenCalled();
    expect(prepareWechatDraftMock).not.toHaveBeenCalled();
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.Categorized);
  });

  test('reuses an existing full-text markdown without downloading or converting again', async () => {
    const fulltextMdPath = `/tmp/paperPipeline/fulltext/${PMID}.md`;
    getExistingFulltextMdPathMock.mockResolvedValue(fulltextMdPath);
    // A previous run left the PDF next to its converted md.
    await fsp.mkdir('/tmp/paperPipeline/pdfs', { recursive: true });
    await fsp.writeFile(PDF_PATH, 'x'.repeat(2048), 'utf-8');

    const { service } = buildService();
    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // Only the file step's own (cache-hit) download ran; no conversion turn.
    expect(downloadPdfMock).toHaveBeenCalledTimes(1);
    expect(convertFulltextToMarkdownMock).not.toHaveBeenCalled();
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      fulltextMdPath,
    }));
  });

  test('skips the download chain when the backend flags closed access', async () => {
    // Contract v1.3: openAccess=false means no OA PDF anywhere — the
    // pre-fetch and the file step must both go straight to the landing
    // page instead of burning the EuropePMC/LLM/agent chain.
    const htmlPath = `/tmp/paperPipeline/html/${PMID}.html`;
    await fsp.mkdir('/tmp/paperPipeline/html', { recursive: true });
    await fsp.writeFile(htmlPath, '<html><body>landing page</body></html>', 'utf-8');
    const fulltextMdPath = `/tmp/paperPipeline/fulltext/${PMID}.md`;
    ensureClosedAccessLandingPageMock.mockResolvedValue(htmlPath);
    convertFulltextToMarkdownMock.mockResolvedValue(fulltextMdPath);
    uploadFileMock.mockResolvedValue({ url: `html/${PMID}.html`, publicUrl: 'https://oss/html/12345.html' });

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
      undefined,
      { openAccess: false },
    );

    // NO download attempt at all; the landing page served both the
    // analysis conversion and the archived full-text artifact.
    expect(downloadPdfMock).not.toHaveBeenCalled();
    expect(ensureClosedAccessLandingPageMock).toHaveBeenCalledWith(PMID);
    expect(convertFulltextToMarkdownMock).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath: htmlPath,
      sourceKind: 'html',
    }));
    expect(generateAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      fulltextMdPath,
    }));
    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      fileType: 'html',
      localPath: htmlPath,
    }));
    expect(client.submitFile).toHaveBeenCalledWith(PMID, 'html', `html/${PMID}.html`, undefined);
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('short-circuits from categorized with the closed-access flag (no pre-fetch ran)', async () => {
    // Run resuming at `categorized` never executes the pre-fetch — the
    // flag alone must still keep the file step off the download chain.
    const htmlPath = `/tmp/paperPipeline/html/${PMID}.html`;
    await fsp.mkdir('/tmp/paperPipeline/html', { recursive: true });
    await fsp.writeFile(htmlPath, '<html><body>landing page</body></html>', 'utf-8');
    ensureClosedAccessLandingPageMock.mockResolvedValue(htmlPath);
    uploadFileMock.mockResolvedValue({ url: `html/${PMID}.html`, publicUrl: 'https://oss/html/12345.html' });

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.Categorized,
      undefined,
      { openAccess: false },
    );

    expect(downloadPdfMock).not.toHaveBeenCalled();
    expect(ensureClosedAccessLandingPageMock).toHaveBeenCalledWith(PMID);
    expect(client.submitFile).toHaveBeenCalledWith(PMID, 'html', `html/${PMID}.html`, undefined);
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('runs the normal download chain when the flag says open access', async () => {
    const { service } = buildService();
    await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
      undefined,
      { openAccess: true },
    );

    // Pre-fetch + file step downloads, exactly like the flag-less path.
    expect(downloadPdfMock).toHaveBeenCalledTimes(2);
    expect(ensureClosedAccessLandingPageMock).not.toHaveBeenCalled();
    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({
      fileType: 'pdf',
    }));
  });
});

describe('advanceTaskAuto closed-access HTML fallback', () => {
  const HTML_PATH = `/tmp/paperPipeline/html/${PMID}.html`;

  beforeEach(async () => {
    vi.clearAllMocks();
    await fsp.rm('/tmp/paperPipeline', { recursive: true, force: true });
    uploadFileMock.mockResolvedValue({ url: `html/${PMID}.html`, publicUrl: 'https://oss/html/12345.html' });
    prepareWechatDraftMock.mockResolvedValue({
      localMarkdownPath: '/tmp/wechat-12345.md',
      markdownUrl: 'https://oss/md/12345.md',
      renderedTitle: 'A draft title',
      renderedSummary: 'A draft summary',
    });
    netFetch.mockRejectedValue(new Error('offline'));
  });

  test('uploads the saved landing page and continues to the WeChat draft', async () => {
    // The download service's closed-access fallback landed the page on
    // disk and attached the path to its rejection (2026-09-19: genuinely
    // closed-access papers, e.g. PMID 38342193, have no OA PDF anywhere).
    await fsp.mkdir('/tmp/paperPipeline/html', { recursive: true });
    await fsp.writeFile(HTML_PATH, '<html><body>landing page</body></html>', 'utf-8');
    downloadPdfMock.mockRejectedValue(new PaperPdfDownloadError(
      `All PDF strategies exhausted for PMID ${PMID} (last error: LLM PDF finder returned no usable URL). Closed access — landing page saved to ${HTML_PATH}`,
      { htmlPath: HTML_PATH },
    ));

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.Categorized,
    );

    // The HTML took the PDF's place: archived to OSS under the html key
    // and registered via submitFile(html), which advances to pdf_ready.
    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({
      pmid: PMID,
      fileType: 'html',
      localPath: HTML_PATH,
    }));
    expect(client.submitFile).toHaveBeenCalledWith(PMID, 'html', `html/${PMID}.html`, undefined);
    // The task did NOT fail — the chain continued into the draft step and
    // stopped at the normal pdf_ready node awaiting the user's docUrl.
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
    expect(prepareWechatDraftMock).toHaveBeenCalledTimes(1);
    expect(prepareWechatDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      pdfUrl: `html/${PMID}.html`,
    }));
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.PdfReady);
  });

  test('reuses a previously cached landing page when this round saved nothing', async () => {
    // Retry resilience: fully-offline round produced no htmlPath on the
    // error, but a previous round left html/{pmid}.html on disk.
    await fsp.mkdir('/tmp/paperPipeline/html', { recursive: true });
    await fsp.writeFile(HTML_PATH, '<html><body>cached landing page</body></html>', 'utf-8');
    downloadPdfMock.mockRejectedValue(new PaperPdfDownloadError(
      'All PDF strategies exhausted for PMID 12345 (last error: offline)',
    ));

    const { service, client } = buildService();
    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.Categorized);

    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({
      fileType: 'html',
      localPath: HTML_PATH,
    }));
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
  });

  test('ends the run gracefully when no full-text source exists anywhere', async () => {
    // User decision 2026-09-19: when neither a PDF nor a landing page is
    // obtainable, the run ends at `categorized` WITHOUT reporting a
    // failure — the next run (or the autopilot batch) retries the download.
    downloadPdfMock.mockRejectedValue(new PaperPdfDownloadError(
      'All PDF strategies exhausted for PMID 12345 (last error: offline)',
    ));

    const { service, client } = buildService();
    const result = await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.Categorized,
    );

    // Synthetic no-op result: the run started at `categorized`, the gate
    // fired before any step ran.
    expect(result.toStatus).toBe(PaperPipelineProcessingStatus.Categorized);
    expect(result.action).toBe(PaperPipelineAdvanceAction.DownloadAndUploadPdf);
    expect(client.reportTaskFailure).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(client.submitFile).not.toHaveBeenCalled();
    expect(prepareWechatDraftMock).not.toHaveBeenCalled();
  });
});

/**
 * Expert-agent auto-detect + override (user requirement 2026-09-19).
 *
 * When the user has installed an agent named "生物研究" (or one of the
 * other aliases in `PIPELINE_EXPERT_AGENT_ALIASES`) under 专家套件 →
 * 已安装, every LLM-driven step in the one-click advance chain should
 * run on that agent instead of the default `main`. When no expert is
 * installed, or when the caller explicitly overrides, the orchestrator
 * must respect the choice — and a missing store must never break the
 * step (the pre-existing behaviour is "fall back to `main`").
 */
describe('advanceTaskAuto agent resolution', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await fsp.rm('/tmp/paperPipeline', { recursive: true, force: true });
    downloadPdfMock.mockImplementation(async () => {
      await fsp.mkdir('/tmp/paperPipeline/pdfs', { recursive: true });
      await fsp.writeFile(PDF_PATH, 'x'.repeat(2048), 'utf-8');
      return { bytes: 2048, localPath: PDF_PATH };
    });
    uploadFileMock.mockResolvedValue({ url: `pdf/${PMID}.pdf`, publicUrl: 'https://oss/pdf/12345.pdf' });
    generateAnalysisMock.mockResolvedValue('【标题】 heuristic extSummary');
    pickCategoriesMock.mockResolvedValue({ categoryIds: ['293'], tagIds: ['88'] });
    getExistingFulltextMdPathMock.mockResolvedValue(null);
    convertFulltextToMarkdownMock.mockResolvedValue(null);
    ensureClosedAccessLandingPageMock.mockResolvedValue(null);
    prepareWechatDraftMock.mockResolvedValue({
      localMarkdownPath: '/tmp/wechat-12345.md',
      markdownUrl: 'https://oss/md/12345.md',
      renderedTitle: 'A draft title',
      renderedSummary: 'A draft summary',
    });
    netFetch.mockRejectedValue(new Error('offline'));
  });

  test('falls back to "main" when no store is wired', async () => {
    // Default buildService() — no coworker store thunk. The resolver must
    // hand back 'main' without throwing so the pre-existing per-step
    // behaviour is preserved (the existing test suite relies on this).
    const { service } = buildService();

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // All four LLM-driven call sites receive 'main' as the agent id.
    // `mock.calls.flat()` gives the args objects directly (each call's
    // single object argument).
    const pickArgs = pickCategoriesMock.mock.calls.flat() as Array<{ agentId?: string }>;
    const analysisArgs = generateAnalysisMock.mock.calls.flat() as Array<{ agentId?: string }>;
    const convertArgs = convertFulltextToMarkdownMock.mock.calls.flat() as Array<{ agentId?: string }>;
    expect(pickArgs.map(c => c.agentId)).toContain('main');
    expect(analysisArgs.map(c => c.agentId)).toContain('main');
    expect(convertArgs.map(c => c.agentId)).toContain('main');
    expect(prepareWechatDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main' }),
    );
  });

  test('uses the installed "生物研究" expert when present in the store', async () => {
    // User-installed agent under the Chinese alias.
    const listAgents = vi.fn(() => [
      { id: 'main-agent', name: 'Main', enabled: true },
      { id: 'bio-agent', name: '生物研究', enabled: true },
      { id: 'stock-agent', name: '股票助手', enabled: true },
    ]);
    const { service } = buildService({ coworkStore: { listAgents } });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // Every LLM step received the expert's id, not 'main'.
    const allAgents: Array<string | undefined> = [
      ...(pickCategoriesMock.mock.calls.flat() as Array<{ agentId?: string }>).map(c => c.agentId),
      ...(generateAnalysisMock.mock.calls.flat() as Array<{ agentId?: string }>).map(c => c.agentId),
      ...(convertFulltextToMarkdownMock.mock.calls.flat() as Array<{ agentId?: string }>).map(c => c.agentId),
      (prepareWechatDraftMock.mock.calls[0]?.[0] as { agentId?: string } | undefined)?.agentId,
    ];
    expect(allAgents).not.toContain('main');
    expect(allAgents).toContain('bio-agent');
    // Auto-detect MUST consult the store exactly once per run (cheap, no
    // need to re-list for every step).
    expect(listAgents).toHaveBeenCalledTimes(1);
  });

  test('uses the English alias "Biological Research" when only that is installed', async () => {
    const listAgents = vi.fn(() => [
      { id: 'bio-en-agent', name: 'Biological Research', enabled: true },
    ]);
    const { service } = buildService({ coworkStore: { listAgents } });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const wechatArgs = prepareWechatDraftMock.mock.calls[0]?.[0] as { agentId?: string };
    expect(wechatArgs?.agentId).toBe('bio-en-agent');
    expect(
      (pickCategoriesMock.mock.calls.flat() as Array<{ agentId?: string }>).map(c => c.agentId),
    ).toContain('bio-en-agent');
  });

  test('ignores disabled expert agents and falls back to main', async () => {
    // Expert is installed but the user disabled it — must NOT be hijacked.
    const listAgents = vi.fn(() => [
      { id: 'bio-agent', name: '生物研究', enabled: false },
    ]);
    const { service } = buildService({ coworkStore: { listAgents } });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const wechatArgs = prepareWechatDraftMock.mock.calls[0]?.[0] as { agentId?: string };
    expect(wechatArgs?.agentId).toBe('main');
  });

  test('explicit options.agentId overrides auto-detect (no store lookup)', async () => {
    const listAgents = vi.fn(() => [
      { id: 'bio-agent', name: '生物研究', enabled: true },
    ]);
    const { service } = buildService({ coworkStore: { listAgents } });

    await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
      undefined,
      { agentId: 'custom-explicit-agent' },
    );

    // Explicit id wins; the store is not consulted at all.
    const wechatArgs = prepareWechatDraftMock.mock.calls[0]?.[0] as { agentId?: string };
    expect(wechatArgs?.agentId).toBe('custom-explicit-agent');
    expect(
      (pickCategoriesMock.mock.calls.flat() as Array<{ agentId?: string }>).map(c => c.agentId),
    ).toContain('custom-explicit-agent');
    expect(listAgents).not.toHaveBeenCalled();
  });

  test('explicit options.agentId=null forces the main fallback even with an expert installed', async () => {
    const listAgents = vi.fn(() => [
      { id: 'bio-agent', name: '生物研究', enabled: true },
    ]);
    const { service } = buildService({ coworkStore: { listAgents } });

    await service.advanceTaskAuto(
      PMID,
      PaperPipelineProcessingStatus.XmlReady,
      undefined,
      { agentId: null },
    );

    // Force-fall-back: the expert exists but the caller wants main.
    const wechatArgs = prepareWechatDraftMock.mock.calls[0]?.[0] as { agentId?: string };
    expect(wechatArgs?.agentId).toBe('main');
    expect(listAgents).not.toHaveBeenCalled();
  });

  test('logs the expert-agent switch when an expert is used', async () => {
    const { service, emitter } = buildService({
      coworkStore: {
        listAgents: () => [{ id: 'bio-agent', name: '生物研究', enabled: true }],
      },
    });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // The status-changed / log emitter should have seen the info line so
    // the user can verify in main-YYYY-MM-DD.log which run used which agent.
    const logCalls = emitter.emitLog.mock.calls.map(call => String(call[0]?.message ?? ''));
    expect(logCalls.some(line => line.includes('bio-agent'))).toBe(true);
  });

  test('does not log the expert line when the agent is main', async () => {
    // No store → 'main' is the resolved id. The noisy info log must stay
    // silent so production logs do not gain a spurious line per run.
    const { service, emitter } = buildService();

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const logCalls = emitter.emitLog.mock.calls.map(call => String(call[0]?.message ?? ''));
    expect(logCalls.some(line => line.includes('pipeline agent:'))).toBe(false);
  });
});

/**
 * Pipeline model config threading (user requirement 2026-09-22): the
 * kv-backed `PaperPipelineModelConfig` decides the model override for every
 * hidden-session LLM step. Explicit config wins verbatim; unset smart-follows
 * the driving agent's binding with a DeepSeek-reasoner → v4-flash swap
 * (same provider only); the PDF URL suggestion model defaults to the shared
 * constant.
 */
describe('advanceTaskAuto model config', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await fsp.rm('/tmp/paperPipeline', { recursive: true, force: true });
    downloadPdfMock.mockImplementation(async () => {
      await fsp.mkdir('/tmp/paperPipeline/pdfs', { recursive: true });
      await fsp.writeFile(PDF_PATH, 'x'.repeat(2048), 'utf-8');
      return { bytes: 2048, localPath: PDF_PATH };
    });
    uploadFileMock.mockResolvedValue({ url: `pdf/${PMID}.pdf`, publicUrl: 'https://oss/pdf/12345.pdf' });
    generateAnalysisMock.mockResolvedValue('【标题】 heuristic extSummary');
    pickCategoriesMock.mockResolvedValue({ categoryIds: ['293'], tagIds: ['88'] });
    getExistingFulltextMdPathMock.mockResolvedValue(null);
    convertFulltextToMarkdownMock.mockResolvedValue(null);
    ensureClosedAccessLandingPageMock.mockResolvedValue(null);
    prepareWechatDraftMock.mockResolvedValue({
      localMarkdownPath: '/tmp/wechat-12345.md',
      markdownUrl: 'https://oss/md/12345.md',
      renderedTitle: 'A draft title',
      renderedSummary: 'A draft summary',
    });
    netFetch.mockRejectedValue(new Error('offline'));
  });

  test('explicit pipelineModel threads modelOverride into every LLM step', async () => {
    const { service, emitter } = buildService({
      modelConfig: { pipelineModel: 'zhipu/glm-4.7', pdfUrlSuggestModel: '' },
    });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const expectOverride = (mock: ReturnType<typeof vi.fn>, label: string) => {
      const calls = mock.mock.calls.flat() as Array<{ modelOverride?: string }>;
      expect(calls.length, `${label} ran`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.modelOverride).toBe('zhipu/glm-4.7');
      }
    };
    expectOverride(pickCategoriesMock, 'pickCategories');
    expectOverride(generateAnalysisMock, 'generateAnalysis');
    expectOverride(convertFulltextToMarkdownMock, 'convertFulltextToMarkdown');
    expectOverride(prepareWechatDraftMock, 'prepareWechatDraft');

    // The override is surfaced in the task log so the user can verify in
    // main-YYYY-MM-DD.log which model a run actually used.
    const logCalls = emitter.emitLog.mock.calls.map(call => String(call[0]?.message ?? ''));
    expect(logCalls.some(line => line.includes("pipeline model override: 'zhipu/glm-4.7'"))).toBe(true);
  });

  test('unset config + agent bound to a DeepSeek reasoner swaps to v4-flash', async () => {
    const { service } = buildService({
      coworkStore: {
        listAgents: () => [{ id: 'bio-agent', name: '生物研究', enabled: true }],
        getAgent: (id: string) =>
          id === 'bio-agent' ? { id, model: 'deepseek/deepseek-reasoner' } : null,
      },
      modelConfig: { pipelineModel: '', pdfUrlSuggestModel: '' },
    });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const analysisArgs = generateAnalysisMock.mock.calls.flat() as Array<{ modelOverride?: string }>;
    expect(analysisArgs.length).toBeGreaterThan(0);
    for (const call of analysisArgs) {
      expect(call.modelOverride).toBe('deepseek/deepseek-v4-flash');
    }
  });

  test('unset config + non-DeepSeek agent binding leaves the model undefined', async () => {
    const { service } = buildService({
      coworkStore: {
        listAgents: () => [{ id: 'bio-agent', name: '生物研究', enabled: true }],
        getAgent: (id: string) =>
          id === 'bio-agent' ? { id, model: 'zhipu/glm-4.7' } : null,
      },
      modelConfig: { pipelineModel: '', pdfUrlSuggestModel: '' },
    });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const analysisArgs = generateAnalysisMock.mock.calls.flat() as Array<{ modelOverride?: string }>;
    expect(analysisArgs.length).toBeGreaterThan(0);
    for (const call of analysisArgs) {
      // undefined = no override; the agent's own binding wins at runtime.
      expect(call.modelOverride).toBeUndefined();
    }
  });

  test('default (no thunk wired) leaves every step without an override', async () => {
    const { service } = buildService();

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const analysisArgs = generateAnalysisMock.mock.calls.flat() as Array<{ modelOverride?: string }>;
    expect(analysisArgs.length).toBeGreaterThan(0);
    for (const call of analysisArgs) {
      expect(call.modelOverride).toBeUndefined();
    }
  });

  test('single-step advanceTask also applies the configured model', async () => {
    const { service } = buildService({
      modelConfig: { pipelineModel: 'zhipu/glm-4.7', pdfUrlSuggestModel: '' },
    });

    await service.advanceTask(PMID, PaperPipelineProcessingStatus.Parsed);

    const analysisArgs = generateAnalysisMock.mock.calls.flat() as Array<{ modelOverride?: string }>;
    expect(analysisArgs.length).toBeGreaterThan(0);
    for (const call of analysisArgs) {
      expect(call.modelOverride).toBe('zhipu/glm-4.7');
    }
  });

  test('the configured pdfUrlSuggestModel reaches the findPdfUrl callback', async () => {
    const { findPdfUrl } = await import('./pdfUrlFinder');
    const { service } = buildService({
      modelConfig: { pipelineModel: '', pdfUrlSuggestModel: 'zhipu/glm-4.7' },
    });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    // `downloadPdf` is mocked, so exercise the closure it received: the
    // suggestModel must ride along into the token-proxy `findPdfUrl` call.
    const downloadInput = downloadPdfMock.mock.calls
      .map(call => call[0] as { findPdfUrl?: (args: unknown) => Promise<unknown> })
      .find(input => typeof input?.findPdfUrl === 'function');
    expect(downloadInput).toBeDefined();
    await downloadInput!.findPdfUrl({ pmid: PMID, title: 't', abstractText: 'a' });
    expect(findPdfUrl).toHaveBeenCalledWith(expect.objectContaining({
      suggestModel: 'zhipu/glm-4.7',
    }));
  });

  test('the default pdfUrlSuggestModel falls back to the shared constant', async () => {
    const { findPdfUrl } = await import('./pdfUrlFinder');
    const { service } = buildService({
      modelConfig: { pipelineModel: '', pdfUrlSuggestModel: '' },
    });

    await service.advanceTaskAuto(PMID, PaperPipelineProcessingStatus.XmlReady);

    const downloadInput = downloadPdfMock.mock.calls
      .map(call => call[0] as { findPdfUrl?: (args: unknown) => Promise<unknown> })
      .find(input => typeof input?.findPdfUrl === 'function');
    expect(downloadInput).toBeDefined();
    await downloadInput!.findPdfUrl({ pmid: PMID, title: 't', abstractText: 'a' });
    expect(findPdfUrl).toHaveBeenCalledWith(expect.objectContaining({
      suggestModel: DEFAULT_PDF_URL_SUGGEST_MODEL,
    }));
  });
});
