import * as fsp from 'node:fs/promises';

import { net } from 'electron';

import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import { type PdfIdentityTarget, verifyPdfIdentity } from './pdfIdentityVerifier';
import { ensurePaperPipelineDirs, getPaperPipelineHtmlPath, getPaperPipelinePdfPath } from './storage';

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
 *   4. Hidden-session agent download (Phase 7): the agent searches, judges,
 *      and downloads the PDF itself to a temporary path; the main process
 *      validates it before promoting it to the cache.
 *   5. LLM-driven URL finder (Phase 6 — compatibility fallback): if the
 *      self-downloading agent is unavailable or unsuccessful, the tool-less
 *      LLM suggests candidate URLs and this module downloads and validates
 *      them.
 *   6. Closed-access HTML fallback: when every strategy fails, save the
 *      public landing page (PubMed abstract / Europe PMC) to
 *      `html/<pmid>.html` and note the saved path in the error.
 *
 * The signature is the contract the orchestrator relies on:
 *   downloadPdf(input: { pmid: string }): Promise<{ localPath: string; bytes: number }>
 */

interface DownloadStrategyResult {
  url: string;
  bytes: number;
}

/**
 * Browser-grade User-Agent: publisher CDNs commonly answer non-browser UAs
 * with verification pages / 403s, which used to push every download into
 * the (heavier) agent fallback. Sending a plain Chrome UA keeps the
 * deterministic direct-URL chains viable headlessly.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function downloadPdf(input: {
  pmid: string;
  /** Existing full URL returned by listPendingTasks, preferred on regeneration. */
  preferredUrl?: string | null;
  /**
   * Optional Phase 6 LLM URL finder kept as a compatibility fallback after
   * the self-downloading agent. When provided, the orchestrator calls it
   * once and tries every returned URL through `downloadFromUrl`.
   */
  findPdfUrl?: (args: {
    pmid: string;
    title?: string | null;
    abstractText?: string | null;
    doi?: string | null;
    authors?: PaperTaskAuthor[];
  }) => Promise<string[]>;
  /**
   * Optional Phase 7 agent download. When provided and the deterministic
   * chains fail, the orchestrator asks a hidden Cowork session to search,
   * judge, and download the PDF itself. The agent writes to a temporary
   * path supplied by the caller; the downloaded file is independently
   * verified (size + PDF magic bytes) before being accepted.
   */
  downloadViaAgent?: (args: {
    pmid: string;
    localPath: string;
    title?: string | null;
    abstractText?: string | null;
    doi?: string | null;
    authors?: PaperTaskAuthor[];
  }) => Promise<boolean>;
  /** Extra context to feed the LLM finder. */
  title?: string | null;
  abstractText?: string | null;
  doi?: string | null;
  authors?: PaperTaskAuthor[];
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
      const cached = await verifyPdfIdentity({ ...input, path: localPath });
      if (cached?.matched) return { localPath, bytes: cached.bytes };
      await fsp.rm(localPath, { force: true });
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
  if (input.preferredUrl) {
    try {
      return await downloadFromUrl({
        url: input.preferredUrl,
        localPath,
        identity: input,
      });
    } catch (err) {
      lastError = err;
    }
  }
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      if (result !== null) {
        return await downloadFromUrl({ url: result.url, localPath, identity: input });
      }
    } catch (err) {
      lastError = err;
      // Continue trying the next strategy.
    }
  }

  // Strategy 4 (Phase 7): let a hidden Cowork session search, judge, and
  // download the PDF itself. The agent writes to a temporary path first;
  // only a PDF that passes the independent verifier is promoted to the
  // final cache path.
  if (input.downloadViaAgent) {
    const agentPath = `${localPath}.agent.part`;
    await fsp.rm(agentPath, { force: true }).catch((): undefined => undefined);
    try {
      const agentClaimed = await input.downloadViaAgent({
        pmid,
        localPath: agentPath,
        title: input.title ?? undefined,
        abstractText: input.abstractText ?? undefined,
        doi: input.doi ?? undefined,
        authors: input.authors,
      });
      const bytes = await verifyDownloadedPdf(agentPath, input);
      if (bytes !== null) {
        await fsp.rm(localPath, { force: true });
        await fsp.rename(agentPath, localPath);
        return { localPath, bytes };
      }
      if (agentClaimed) {
        lastError = new PaperPdfDownloadError(
          'agent claimed DOWNLOADED but the file at the target path is not a valid PDF (temporary file verification failed)',
        );
      }
    } catch (err) {
      lastError = err;
      // A timeout can occur just after the agent wrote the file. Verify the
      // temporary path before discarding the attempt.
      const bytes = await verifyDownloadedPdf(agentPath, input);
      if (bytes !== null) {
        await fsp.rm(localPath, { force: true });
        await fsp.rename(agentPath, localPath);
        return { localPath, bytes };
      }
    } finally {
      await fsp.rm(agentPath, { force: true }).catch((): undefined => undefined);
    }
  }

  // Compatibility fallback (Phase 6): if the self-downloading agent is
  // unavailable or unsuccessful, ask the tool-less LLM for candidate URLs.
  // The program still downloads and validates every candidate itself.
  if (input.findPdfUrl) {
    try {
      const llmUrls = await input.findPdfUrl({
        pmid,
        title: input.title ?? undefined,
        abstractText: input.abstractText ?? undefined,
        doi: input.doi ?? undefined,
        authors: input.authors,
      });
      if (llmUrls.length === 0) {
        lastError = new PaperPdfDownloadError(
          'LLM PDF finder returned no usable URL (see [PdfUrlFinder] logs for per-strategy reasons)',
        );
      }
      for (const llmUrl of llmUrls) {
        try {
          return await downloadFromUrl({ url: llmUrl, localPath, identity: input });
        } catch (err) {
          lastError = err;
        }
      }
    } catch (err) {
      lastError = err;
    }
  }

  // Every PDF strategy failed. When the paper is genuinely closed access
  // (the usual NO_PDF verdict — no OA copy anywhere, not a verification
  // block), there is no PDF to be had, but the public landing page is
  // still worth keeping as a local artifact. Best-effort: never masks the
  // exhausted error, never throws on its own.
  const htmlPath = await saveClosedAccessHtmlFallback(pmid);

  throw new PaperPdfDownloadError(
    `All PDF strategies exhausted for PMID ${pmid} (last error: ${
      lastError instanceof Error ? lastError.message : 'unknown'
    }).${
      htmlPath
        ? ` Closed access — landing page saved to ${htmlPath}.`
        : ' Reset the task once a strategy is available.'
    }`,
    { htmlPath },
  );
}

/**
 * Ensure the closed-access landing page exists locally: reuse a previously
 * saved `html/{pmid}.html`, else fetch it now (PubMed first, Europe PMC
 * second). Returns the page path, or null when nothing plausible could be
 * fetched.
 *
 * Used by the orchestrator when the backend already flagged the paper as
 * closed access (`openAccess === false`, contract v1.3) — no point running
 * the full PDF strategy chain (EuropePMC/PMC/LLM/agent, up to 300s) on a
 * paper known to have no OA copy.
 */
export async function ensureClosedAccessLandingPage(pmid: string): Promise<string | null> {
  const cachedPath = getPaperPipelineHtmlPath(pmid);
  const cachedExists = await fsp
    .access(cachedPath)
    .then(() => true)
    .catch(() => false);
  if (cachedExists) return cachedPath;
  return saveClosedAccessHtmlFallback(pmid);
}

/**
 * Closed-access fallback: fetch the article's public landing page (PubMed
 * abstract first, Europe PMC second) and save it to `html/<pmid>.html`.
 * Returns the saved path, or null when no source produced a plausible HTML
 * body. Swallows all errors — this runs on the exhausted-error path, where
 * the PDF failure is the outcome that matters.
 */
async function saveClosedAccessHtmlFallback(pmid: string): Promise<string | null> {
  const sources = [
    `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    `https://europepmc.org/article/MED/${pmid}`,
  ];
  for (const url of sources) {
    try {
      const response = await safeGet(url);
      if (!response || !response.ok) continue;
      const body = Buffer.from(await response.arrayBuffer());
      // Plausibility guards: CAPTCHA/interstitial responses are tiny or
      // not HTML at all. A real landing page is well over 1KB of HTML.
      if (body.length <= 1024) continue;
      const head = body.subarray(0, 512).toString('latin1');
      if (!/<html[\s>]|<!doctype html/i.test(head)) continue;
      const htmlPath = getPaperPipelineHtmlPath(pmid);
      await fsp.writeFile(htmlPath, body);
      console.log(`[PaperPipeline] closed-access HTML fallback saved ${pmid} → ${htmlPath} (${body.length} bytes)`);
      return htmlPath;
    } catch {
      // Try the next source; the PDF error is the outcome that matters.
    }
  }
  return null;
}

/**
 * Download a known PDF URL straight to the local cache. Used both by the
 * deterministic chains (after a successful `tryDirectPdf`) and by the LLM
 * URL finder.
 *
 * The response body must actually be a PDF: paywalls, CAPTCHAs, and
 * "verify you are human" interstitials return HTTP 200 with an HTML body
 * that would otherwise pass the size guard and get cached as a corrupt
 * "PDF". Rejecting non-PDF bodies makes those URLs count as failures so
 * the caller moves on to the next candidate.
 */
async function downloadFromUrl(input: {
  url: string;
  localPath: string;
  identity: PdfIdentityTarget;
}): Promise<{
  localPath: string;
  bytes: number;
}> {
  const body = await fetchBytes(input.url);
  if (!isPdfBuffer(body)) {
    throw new PaperPdfDownloadError(
      `download from ${input.url} is not a PDF (${describeBodyHead(body)})`,
    );
  }
  await fsp.writeFile(input.localPath, body);
  const stat = await fsp.stat(input.localPath);
  if (stat.size <= 1024) {
    throw new PaperPdfDownloadError(
      `download from ${input.url} produced ${stat.size} bytes (< 1KB)`,
    );
  }
  const identity = await verifyPdfIdentity({ ...input.identity, path: input.localPath });
  if (!identity?.matched) {
    await fsp.rm(input.localPath, { force: true });
    throw new PaperPdfDownloadError(
      `download from ${input.url} failed PDF identity verification: ${identity?.reason ?? 'invalid PDF'}`,
    );
  }
  return { localPath: input.localPath, bytes: stat.size };
}

/** PDF files start with the literal magic prefix `%PDF-`. */
function isPdfBuffer(body: Buffer): boolean {
  return body.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Verify a file on disk is a plausible PDF: exists, larger than 1KB, and
 * starts with the `%PDF-` magic. Returns the size in bytes when valid,
 * null otherwise. Used to check files the hidden-session agent claims to
 * have downloaded — the claim alone is not evidence.
 */
async function verifyDownloadedPdf(
  localPath: string,
  identity: PdfIdentityTarget,
): Promise<number | null> {
  try {
    const result = await verifyPdfIdentity({ ...identity, path: localPath });
    return result?.matched ? result.bytes : null;
  } catch {
    return null;
  }
}

/** Human-readable head of a rejected body, for the error message. */
function describeBodyHead(body: Buffer): string {
  const head = body
    .subarray(0, 16)
    .toString('latin1')
    // Non-printable bytes render as dots so the message stays loggable.
    .replace(/[^\x20-\x7e]/g, '.');
  return `starts with "${head}", ${body.length} bytes`;
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
  /**
   * Local path of the closed-access HTML landing page saved by the
   * fallback (`html/{pmid}.html`), when one could be fetched. The
   * orchestrator reads this to continue the pipeline on the HTML path
   * instead of failing the task — null when no HTML was saved.
   */
  readonly htmlPath?: string | null;

  constructor(message: string, options: { htmlPath?: string | null } = {}) {
    super(message);
    this.name = 'PaperPdfDownloadError';
    this.htmlPath = options.htmlPath ?? null;
  }
}
