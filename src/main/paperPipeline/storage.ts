import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { app } from 'electron';

/**
 * Local cache directory for paper-pipeline artefacts (downloaded PDFs,
 * intermediate summaries, raw XML). Lives under Electron `userData` so it
 * survives upgrades and is removed with the app uninstall.
 */
const ROOT_DIRNAME = 'paperPipeline';
const PDF_DIRNAME = 'pdfs';
const XML_DIRNAME = 'xml';
const WECHAT_DIRNAME = 'wechat';
const HTML_DIRNAME = 'html';
const FULLTEXT_DIRNAME = 'fulltext';

let resolvedRoot: string | null = null;

/**
 * Resolve the root directory for paper-pipeline local artefacts. Lazily
 * computed on first use so this module is safe to import before `app.whenReady`.
 */
export function getPaperPipelineRootDir(): string {
  if (resolvedRoot !== null) return resolvedRoot;
  resolvedRoot = path.join(app.getPath('userData'), ROOT_DIRNAME);
  return resolvedRoot;
}

export function getPaperPipelinePdfDir(): string {
  return path.join(getPaperPipelineRootDir(), PDF_DIRNAME);
}

export function getPaperPipelineXmlDir(): string {
  return path.join(getPaperPipelineRootDir(), XML_DIRNAME);
}

export function getPaperPipelineWechatDir(): string {
  return path.join(getPaperPipelineRootDir(), WECHAT_DIRNAME);
}

export function getPaperPipelineHtmlDir(): string {
  return path.join(getPaperPipelineRootDir(), HTML_DIRNAME);
}

export function getPaperPipelineFulltextDir(): string {
  return path.join(getPaperPipelineRootDir(), FULLTEXT_DIRNAME);
}

/**
 * Resolve a path under a named artefact subdir (e.g. 'wechat', 'pdfs').
 * Used by Phase 4 to write a per-pmid Markdown draft to `wechat/<pmid>.md`
 * so the renderer can preview it before the user pastes the docUrl back.
 */
export function getPaperPipelineArtifactPath(
  subdir: 'wechat' | 'pdfs' | 'xml',
  filename: string,
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  switch (subdir) {
    case 'wechat':
      return path.join(getPaperPipelineWechatDir(), safe);
    case 'pdfs':
      return path.join(getPaperPipelinePdfDir(), safe);
    case 'xml':
      return path.join(getPaperPipelineXmlDir(), safe);
    default:
      return path.join(getPaperPipelineRootDir(), safe);
  }
}

export function getPaperPipelinePdfPath(pmid: string): string {
  const safe = pmid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getPaperPipelinePdfDir(), `${safe}.pdf`);
}

export function getPaperPipelineXmlPath(pmid: string): string {
  const safe = pmid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getPaperPipelineXmlDir(), `${safe}.xml`);
}

/**
 * Landing-page HTML cached for closed-access papers: when no OA PDF exists
 * anywhere, the pipeline still saves the article's public landing page
 * (PubMed abstract / Europe PMC) to `html/<pmid>.html` so the user has a
 * local artifact for the paper.
 */
export function getPaperPipelineHtmlPath(pmid: string): string {
  const safe = pmid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getPaperPipelineHtmlDir(), `${safe}.html`);
}

/**
 * Local full-text Markdown converted from the downloaded PDF (or the
 * closed-access HTML landing page) so the analysis step can cite
 * body-level data. Local-only analysis input — unlike the WeChat draft
 * (`wechat/`, uploaded to OSS as `md/{pmid}.md`), this file is never
 * uploaded anywhere.
 */
export function getPaperPipelineFulltextMdPath(pmid: string): string {
  const safe = pmid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getPaperPipelineFulltextDir(), `${safe}.md`);
}

/** Make sure the directory tree exists; idempotent. */
export async function ensurePaperPipelineDirs(): Promise<void> {
  await fsp.mkdir(getPaperPipelinePdfDir(), { recursive: true });
  await fsp.mkdir(getPaperPipelineXmlDir(), { recursive: true });
  await fsp.mkdir(getPaperPipelineWechatDir(), { recursive: true });
  await fsp.mkdir(getPaperPipelineHtmlDir(), { recursive: true });
  await fsp.mkdir(getPaperPipelineFulltextDir(), { recursive: true });
}