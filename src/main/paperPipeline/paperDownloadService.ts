import * as fsp from 'node:fs/promises';

import { net } from 'electron';

import { ensurePaperPipelineDirs, getPaperPipelinePdfPath } from './storage';

/**
 * PDF download strategies (Phase 3).
 *
 * LobsterAI tries multiple public sources in order before giving up. Each
 * strategy is intentionally simple (no auth, no proxy) so the first
 * integration round can run against a fresh dev backend:
 *
 *   1. EuropePMC direct PDF URL
 *      `https://europepmc.org/articles/PMC<pmid>/pdf`
 *      Works for the majority of PubMed Central papers (PMC IDs).
 *   2. PubMed Central direct PDF URL
 *      `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC<pmid>/pdf/`
 *      Mirror of (1) for IDs that aren't yet on EuropePMC.
 *   3. EuropePMC search API → resolve the best matching PDF URL
 *      Used when the deterministic URLs above 404 — we ask the API for
 *      `PMCID` / `fullTextUrlList` and pull the first `PDF` link.
 *   4. LLM-driven URL finder (Phase 6 — `pdfUrlFinder.ts`)
 *      When the deterministic chains fail the orchestrator delegates to
 *      the LLM (via OpenClaw token-proxy → DeepSeek etc.) to suggest a
 *      PDF URL. The actual download still happens here so the same
 *      caching and size guards apply. This is the same capability the
 *      user exercised manually in chat (see paper-pipeline screen-shots:
 *      DeepSeek returned `s41467-025-68103-7.pdf` for the user request).
 *
 * The signature is the contract the orchestrator relies on:
 *   downloadPdf(input: { pmid: string }): Promise<{ localPath: string; bytes: number }>
 */

interface DownloadStrategyResult {
  url: string;
  bytes: number;
}

const USER_AGENT = 'LobsterAI-PaperPipeline/1.0 (Electron)';

export async function downloadPdf(input: {
  pmid: string;
  /**
   * Optional Phase 6 LLM URL finder. When provided AND the deterministic
   * chains fail, the orchestrator will call this callback once and then
   * route the returned URL through `downloadFromUrl` so the same size +
   * cache guards apply. The orchestrator is responsible for closing
   * over the real `PdfUrlFinderDeps` — this module only sees the inputs
   * it needs to forward to the model.
   */
  findPdfUrl?: (args: {
    pmid: string;
    title?: string | null;
    abstractText?: string | null;
  }) => Promise<string | null>;
  /** Extra context to feed the LLM finder. */
  title?: string | null;
  abstractText?: string | null;
}): Promise<{
  localPath: string;
  bytes: number;
}> {
  await ensurePaperPipelineDirs();
  const localPath = getPaperPipelinePdfPath(input.pmid);

  // If we've already cached a non-trivial PDF, reuse it. Saves repeated
  // downloads while the user iterates on the same pmid in the UI.
  try {
    const stat = await fsp.stat(localPath);
    if (stat.size > 1024) {
      return { localPath, bytes: stat.size };
    }
  } catch {
    /* fresh download path */
  }

  const pmid = input.pmid.trim();
  if (!/^\d{1,9}$/.test(pmid)) {
    throw new PaperPdfDownloadError(
      `PMID must be 1-9 digits, got ${JSON.stringify(pmid)}`,
    );
  }

  const attempts: Array<{ label: string; run: () => Promise<DownloadStrategyResult | null> }> = [
    { label: 'europepmc-direct', run: () => tryDirectPdf(`https://europepmc.org/articles/PMC${pmid}/pdf`) },
    { label: 'pmc-direct', run: () => tryDirectPdf(`https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmid}/pdf/`) },
    { label: 'europepmc-search', run: () => tryEuropePmcSearch(pmid) },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      if (result !== null) {
        return await downloadFromUrl({ url: result.url, localPath });
      }
    } catch (err) {
      lastError = err;
      // Continue trying the next strategy.
    }
  }

  // Strategy 4 (Phase 6): ask the LLM for a PDF URL and download it.
  // The orchestrator wraps `findPdfUrl` so the real deps (token-proxy
  // port + optional hidden-session hook) are passed in from the caller.
  if (input.findPdfUrl) {
    try {
      const llmUrl = await input.findPdfUrl({
        pmid,
        title: input.title ?? undefined,
        abstractText: input.abstractText ?? undefined,
      });
      if (llmUrl) {
        return await downloadFromUrl({ url: llmUrl, localPath });
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw new PaperPdfDownloadError(
    `All PDF strategies exhausted for PMID ${pmid} (last error: ${
      lastError instanceof Error ? lastError.message : 'unknown'
    }). Reset the task once a strategy is available.`,
  );
}

/**
 * Download a known PDF URL straight to the local cache. Used both by the
 * deterministic chains (after a successful `tryDirectPdf`) and by the LLM
 * URL finder.
 */
async function downloadFromUrl(input: { url: string; localPath: string }): Promise<{
  localPath: string;
  bytes: number;
}> {
  await fsp.writeFile(input.localPath, await fetchBytes(input.url));
  const stat = await fsp.stat(input.localPath);
  if (stat.size <= 1024) {
    throw new PaperPdfDownloadError(
      `download from ${input.url} produced ${stat.size} bytes (< 1KB)`,
    );
  }
  return { localPath: input.localPath, bytes: stat.size };
}

/** Resolve `url`; return { url, bytes } when 2xx, null otherwise. */
async function tryDirectPdf(url: string): Promise<DownloadStrategyResult | null> {
  const response = await safeHead(url);
  if (!response || response.status !== 200) return null;
  return { url, bytes: Number(response.headers.get('content-length') ?? 0) };
}

/** EuropePMC search API: returns a PDF URL when one is listed. */
async function tryEuropePmcSearch(pmid: string): Promise<DownloadStrategyResult | null> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=ext_id:${encodeURIComponent(
    pmid,
  )}&format=json&resultType=lite`;
  const response = await safeGet(url);
  if (!response) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const resultList = readResults(payload);
  for (const entry of resultList) {
    const fullText = entry.fullTextUrlList;
    if (!Array.isArray(fullText)) continue;
    for (const item of fullText) {
      const candidate = (item as Record<string, unknown>)?.url;
      const style = String((item as Record<string, unknown>)?.documentStyle ?? '');
      if (typeof candidate === 'string' && /pdf/i.test(style)) {
        return { url: candidate, bytes: 0 };
      }
    }
  }
  return null;
}

async function safeHead(url: string): Promise<Response | null> {
  try {
    return await net.fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
  } catch {
    return null;
  }
}

async function safeGet(url: string): Promise<Response | null> {
  try {
    return await net.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
    });
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await safeGet(url);
  if (!response || !response.ok) {
    throw new PaperPdfDownloadError(`Failed to fetch PDF body from ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function readResults(payload: unknown): Array<Record<string, unknown>> {
  if (typeof payload !== 'object' || payload === null) return [];
  const result = (payload as Record<string, unknown>).resultList;
  if (!result || typeof result !== 'object') return [];
  const list = (result as Record<string, unknown>).result;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null,
  );
}

export class PaperPdfDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperPdfDownloadError';
  }
}