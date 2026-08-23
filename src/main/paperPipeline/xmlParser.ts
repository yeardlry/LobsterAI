import * as fsp from 'node:fs/promises';

import { XMLParser } from 'fast-xml-parser';

import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import { ensurePaperPipelineDirs, getPaperPipelineXmlPath } from './storage';

/**
 * Real PubMed-style XML → author list extractor (Phase 2).
 *
 * Walks `PubmedArticleSet > PubmedArticle > MedlineCitation > Article >
 * AuthorList > Author`. Each Author block is expected to provide:
 *   - `ForeName` (sometimes `FirstName` in older records)
 *   - `LastName`
 *   - optional `Affiliation`
 *   - optional `Name` (collective author, used as fullName fallback)
 *
 * Tolerant of empty / non-PubMed payloads: returns [] when nothing
 * recognisable is found so the orchestrator can still advance and the
 * server can fix up authors later.
 */
export function parseAuthors(xml: string): PaperTaskAuthor[] {
  if (!xml || xml.trim().length === 0) return [];

  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    textNodeName: '#text',
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const authorList = findAuthorList(parsed);
  if (!authorList) return [];

  // `AuthorList.Author` may be a single object (one author), an array of
  // objects (multiple authors), or — if the source had no authors — absent.
  const rawAuthorsContainer =
    typeof authorList === 'object' && authorList !== null
      ? (authorList as Record<string, unknown>).Author
      : undefined;
  if (rawAuthorsContainer === undefined) return [];
  const rawAuthors = Array.isArray(rawAuthorsContainer)
    ? rawAuthorsContainer
    : [rawAuthorsContainer];
  const result: PaperTaskAuthor[] = [];
  const seen = new Set<string>();

  rawAuthors.forEach((raw) => {
    if (typeof raw !== 'object' || raw === null) return;
    const a = raw as Record<string, unknown>;

    const fore = firstString(a.ForeName ?? a.FirstName);
    const last = firstString(a.LastName);
    const name = firstString(a.Name);
    const affiliation = firstString(a.Affiliation);

    let fullName: string;
    if (name) {
      fullName = name;
    } else if (fore || last) {
      fullName = `${fore ?? ''} ${last ?? ''}`.trim();
    } else {
      return; // Skip authors with no name payload at all.
    }

    const dedupeKey = fullName.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    result.push({
      fullName,
      firstName: fore ?? null,
      lastName: last ?? null,
      affiliation: affiliation ?? null,
      ...(extractOrder(a) !== undefined ? { order: extractOrder(a) } : {}),
    });
  });

  // Ensure each entry has an `order` (some records omit it).
  result.forEach((author, index) => {
    if (author.order === undefined) {
      author.order = index + 1;
    }
  });

  // Sanity: ignore if we somehow produced nothing useful.
  if (result.length === 0 && rawAuthors.length > 0) {
    // Last-resort: synthesise fullName from any text field we can find so
    // the orchestrator still advances with at least one author row.
    const fallback: PaperTaskAuthor[] = [];
    rawAuthors.forEach((raw, index) => {
      if (typeof raw !== 'object' || raw === null) return;
      const text = collectText(raw).trim();
      if (!text) return;
      fallback.push({
        fullName: text,
        firstName: null,
        lastName: null,
        affiliation: null,
        order: index + 1,
      });
    });
    return fallback;
  }

  return result;
}

/**
 * Pull a flat string from a value that may be a string, an array of strings,
 * an object with a `#text` child, or undefined.
 */
function firstString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (text !== undefined) return firstString(text);
  }
  return null;
}

function extractOrder(author: Record<string, unknown>): number | undefined {
  const candidate = author.order ?? author.Order;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === 'string') {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Walk the parsed tree for `AuthorList`, tolerant of multiple wrappers. */
function findAuthorList(root: unknown): unknown {
  if (typeof root !== 'object' || root === null) return null;
  const direct = (root as Record<string, unknown>).AuthorList;
  if (direct !== undefined) return direct;

  // Try descending one level — some records wrap everything in
  // PubmedArticleSet > ArticleSet > Article.
  for (const value of Object.values(root as Record<string, unknown>)) {
    const found = findAuthorList(value);
    if (found !== null) return found;
  }
  return null;
}

/** Concatenate all leaf strings under `node` — used as a last-resort name. */
function collectText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (typeof node === 'object' && node !== null) {
    return Object.values(node as Record<string, unknown>).map(collectText).join(' ');
  }
  return '';
}

/**
 * Persist the raw XML returned by `/lit/getXmlContent` to local cache so
 * downstream steps (analysis, re-parse) can read it without re-fetching.
 */
export async function cacheXml(pmid: string, xml: string): Promise<string> {
  await ensurePaperPipelineDirs();
  const filePath = getPaperPipelineXmlPath(pmid);
  await fsp.writeFile(filePath, xml, 'utf8');
  return filePath;
}

/** Read previously cached XML. Returns null if not cached. */
export async function readCachedXml(pmid: string): Promise<string | null> {
  try {
    return await fsp.readFile(getPaperPipelineXmlPath(pmid), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Extract the abstract text block(s) from the cached XML. Used by the
 * heuristic summariser so it has real content to pull from.
 */
export function extractAbstract(xml: string): string {
  if (!xml || xml.trim().length === 0) return '';
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return '';
  }
  const abstract = findByKey(parsed, 'Abstract');
  if (abstract === null) return '';
  const blocks = Array.isArray(abstract) ? abstract : [abstract];
  const parts: string[] = [];
  for (const block of blocks) {
    const texts = collectAllText(block, 'AbstractText');
    if (texts.length > 0) {
      parts.push(texts.join(' '));
    } else {
      parts.push(collectText(block));
    }
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

/** Extract the article title (used by both summary and WeChat draft). */
export function extractTitle(xml: string): string {
  if (!xml || xml.trim().length === 0) return '';
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return '';
  }
  const title = findByKey(parsed, 'ArticleTitle');
  if (title === null) return '';
  return collectText(title).replace(/\s+/g, ' ').trim();
}

function findByKey(root: unknown, key: string): unknown {
  if (typeof root !== 'object' || root === null) return null;
  if (Array.isArray(root)) {
    for (const entry of root) {
      const found = findByKey(entry, key);
      if (found !== null) return found;
    }
    return null;
  }
  const obj = root as Record<string, unknown>;
  if (obj[key] !== undefined) return obj[key];
  for (const value of Object.values(obj)) {
    const found = findByKey(value, key);
    if (found !== null) return found;
  }
  return null;
}

function collectAllText(root: unknown, key: string): string[] {
  const found = findByKey(root, key);
  if (found === null) return [];
  const items = Array.isArray(found) ? found : [found];
  return items
    .map(item => collectText(item).replace(/\s+/g, ' ').trim())
    .filter(text => text.length > 0);
}