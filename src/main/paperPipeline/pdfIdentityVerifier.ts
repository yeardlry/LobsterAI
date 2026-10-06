import * as fsp from 'node:fs/promises';

import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  }>;
}

interface PdfJsModule {
  getDocument(input: { data: Uint8Array; disableWorker: boolean }): {
    promise: Promise<PdfJsDocument>;
  };
}

export interface PdfIdentityInput {
  path: string;
  pmid: string;
  doi?: string | null;
  title?: string | null;
  authors?: PaperTaskAuthor[];
}

export type PdfIdentityTarget = Omit<PdfIdentityInput, 'path'>;

export interface PdfIdentityResult {
  bytes: number;
  matched: boolean;
  matchedBy: string[];
  reason: string;
}

/**
 * Validate the PDF itself, then compare its first pages with the target
 * article identity. A valid PDF is not automatically the right PDF: OA
 * mirrors and publisher redirects occasionally return a different article.
 */
export async function verifyPdfIdentity(input: PdfIdentityInput): Promise<PdfIdentityResult | null> {
  const file = await readPdf(input.path);
  if (!file) return null;

  const hasIdentityTarget = Boolean(
    input.doi?.trim() || input.title?.trim() || input.authors?.some(author => author.fullName.trim()),
  );
  if (!hasIdentityTarget) {
    return {
      bytes: file.bytes,
      matched: true,
      matchedBy: [],
      reason: 'no title, DOI, or author identity was available; accepted structural PDF validation',
    };
  }

  const text = await extractPdfText(file.bytesData);
  if (!text) {
    return {
      bytes: file.bytes,
      matched: false,
      matchedBy: [],
      reason: 'PDF text could not be extracted for identity verification',
    };
  }

  const normalizedText = normalize(text);
  const compactText = text.toLowerCase().replace(/\s+/g, '');
  const matchedBy: string[] = [];
  const normalizedDoi = normalizeDoi(input.doi);
  if (normalizedDoi && compactText.includes(normalizedDoi)) matchedBy.push('doi');
  if (input.pmid && new RegExp(`\\b${escapeRegExp(input.pmid)}\\b`).test(normalizedText)) {
    matchedBy.push('pmid');
  }

  const titleScore = similarity(input.title, normalizedText);
  if (titleScore >= 0.84) matchedBy.push('title');

  const authorMatched = (input.authors ?? []).some((author) => {
    const surname = normalize(author.lastName || lastName(author.fullName));
    return surname.length >= 3 && normalizedText.includes(surname);
  });
  if (authorMatched) matchedBy.push('author');

  const strongIdentifier = matchedBy.includes('doi') || matchedBy.includes('pmid');
  const titleAndAuthor = matchedBy.includes('title') && matchedBy.includes('author');
  const distinctiveTitle = titleScore >= 0.9 && titleTokenCount(input.title, normalizedText) >= 3;
  const matched = strongIdentifier || titleAndAuthor || distinctiveTitle;
  return {
    bytes: file.bytes,
    matched,
    matchedBy,
    reason: matched
      ? `identity matched by ${matchedBy.join(', ')}`
      : 'PDF did not contain a sufficiently strong match for the target title, DOI, PMID, or author',
  };
}

async function readPdf(path: string): Promise<{ bytes: number; bytesData: Uint8Array } | null> {
  try {
    const data = await fsp.readFile(path);
    if (data.length <= 1024 || data.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
    return { bytes: data.length, bytesData: data };
  } catch {
    return null;
  }
}

async function extractPdfText(data: Uint8Array): Promise<string> {
  try {
    // pdfjs-dist is ESM in the current dependency line; loading lazily keeps
    // startup cheap and avoids initializing the parser for empty candidates.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfJsModule;
    const document = await pdfjs.getDocument({ data, disableWorker: true }).promise;
    const pageCount = Math.min(document.numPages, 4);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str ?? '').join(' '));
    }
    return pages.join('\n').slice(0, 120_000);
  } catch {
    return '';
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizeDoi(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[)\].,;:]+$/, '');
}

function similarity(title: string | null | undefined, text: string): number {
  const titleTokens = tokens(title ?? '');
  if (titleTokens.length === 0) return 0;
  const textTokens = new Set(tokens(text));
  const overlap = titleTokens.filter(token => textTokens.has(token)).length;
  return overlap / titleTokens.length;
}

function titleTokenCount(title: string | null | undefined, text: string): number {
  const textTokens = new Set(tokens(text));
  return tokens(title ?? '').filter(token => textTokens.has(token)).length;
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .filter((token, index, all) => all.indexOf(token) === index);
}

function lastName(fullName: string): string {
  return fullName.trim().split(/\s+/).at(-1) ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
