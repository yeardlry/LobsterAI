import { net } from 'electron';

import { LitAuthHeader } from '../../shared/paperPipeline/constants';
import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import type { PaperPipelineClientDeps } from './paperPipelineClient';
import {
  resolveTaskSessionDeps,
  runTaskHiddenSession,
  type TaskSessionDeps,
} from './taskHiddenSession';
import { extractAbstract, extractTitle } from './xmlParser';

/**
 * Phase 5 category picker — LLM-first with a keyword-overlap fallback.
 *
 * Fetches the catalogue once per pick (with retry) from `GET /lit/catalog`
 * (added 2026-08-27 — see [MCP接口权威契约 §4.4](../java/MRnaLnpLiterature/docs/MCP接口权威契约.md)).
 * That single REST endpoint returns `{parentCategories, categories, tags}`
 * with `categories[].groupCode` included. Since contract v1.5 (2026-09-21)
 * the backend only returns `is_active=1` entries; we filter inactive tags
 * client-side too as double insurance. A catalogue that stays unreachable
 * after the retries THROWS — the advance run aborts instead of silently
 * submitting empty lists (user decision 2026-09-23: a run that produced no
 * categories/tags was invisible in the logs and looked like success).
 *
 * Primary path: the task's pooled hidden Cowork session picks 1-2
 * categories and up to 3 tags semantically. Its reply is parsed strictly
 * and every id is validated against the catalogue whitelist before use —
 * the LLM never gets to invent ids. When nothing existing fits, the agent
 * may instead suggest NEW entries (`NEW_CATEGORIES` / `NEW_TAGS`, contract
 * §4.5.3); those are created through the idempotent write endpoints
 * `POST /lit/tags` / `POST /lit/categories` (contract §4.5) and the returned
 * ids are merged into the submission — create-then-submit. Creation
 * failures are logged and skipped; they never break the step.
 *
 * Fallback path: keyword-overlap matching (the original Phase 5 picker),
 * used when the session deps are not wired, the agent fails, or its reply
 * is unusable / picks nothing. The heuristic is intentionally conservative:
 * when nothing obvious matches, we hand back `[]` rather than a wrong
 * guess (the contract on `submitCategories` allows both `categoryIds` and
 * `tagIds` to be empty).
 */
export async function pickCategories(input: {
  pmid: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
  clientDeps: PaperPipelineClientDeps;
  /** Optional raw XML to mine for abstract / title; supplied by callers
   *  that have it in memory. */
  xml?: string;
  /** Absolute path of the cached full-text XML for the hidden session. */
  xmlPath?: string;
  /** Hidden-session deps; when wired the LLM picks first. */
  deps?: TaskSessionDeps;
  /**
   * Override agent id for the hidden session. When omitted the global
   * `main` agent drives the pick (pre-existing behaviour); the
   * auto-advance orchestrator resolves an installed expert at run entry
   * and threads the id through here so the LLM picker can use the
   * biology-tuned skills / system prompt.
   */
  agentId?: string;
  /**
   * Session-level model override (provider-qualified ref) threaded from
   * `PaperPipelineModelConfig.pipelineModel`. `undefined` keeps the agent's
   * own binding.
   */
  modelOverride?: string;
}): Promise<{ categoryIds: string[]; tagIds: string[] }> {
  const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
    input.deps?.log ?? ((level, message) => console[level](message));
  // Catalogue fetch with retry, then THROW (user decision 2026-09-23): the
  // old silent `.catch(() => null)` degraded to empty lists, so the task
  // advanced with no tags and nothing in the logs explained why.
  const catalogue = await fetchCategoryCatalogueWithRetry(
    input.clientDeps,
    logSink,
    input.pmid,
  );

  const llmPicked = await tryPickWithAgent(input, catalogue);
  if (llmPicked) return llmPicked;

  const text = await buildPickText(input);
  const categories = pickBestMatches(text, catalogue.categories, 2);
  const tags = pickBestMatches(text, catalogue.tags, 3);
  if (categories.length === 0 && tags.length === 0) {
    logSink(
      'warn',
      `[CategoryService] keyword fallback found no matches for PMID ${input.pmid} — submitting empty category/tag lists`,
    );
  }

  return {
    categoryIds: categories.map(c => c.id),
    tagIds: tags.map(t => t.id),
  };
}

interface Catalogue {
  /** Top-level dimensions — the parent ids a NEW_CATEGORIES entry may target. */
  parentCategories: Array<{ id: string; name: string }>;
  categories: Array<{
    id: string;
    name: string;
    /** Parent dimension id — rendered into the prompt to disambiguate
     * same-name subcategories (they are legal under different parents,
     * contract §4.5.2). */
    parentCategoryId?: string;
    groupCode?: string;
  }>;
  tags: Array<{ id: string; name: string }>;
}

/**
 * Drive the task's hidden session to pick categories semantically. Returns
 * the picked ids iff the reply parses AND at least one id survives the
 * catalogue whitelist / create step — otherwise null so the caller runs the
 * keyword heuristic. Errors are logged and swallowed.
 */
async function tryPickWithAgent(
  input: {
    pmid: string;
    extSummary: string;
    authors: PaperTaskAuthor[];
    clientDeps: PaperPipelineClientDeps;
    xml?: string;
    xmlPath?: string;
    deps?: TaskSessionDeps;
    agentId?: string;
    modelOverride?: string;
  },
  catalogue: Catalogue,
): Promise<{ categoryIds: string[]; tagIds: string[] } | null> {
  const sessionDeps = resolveTaskSessionDeps(input.deps);
  const logSink: (level: 'info' | 'warn' | 'error', message: string) => void =
    input.deps?.log ?? ((level, message) => console[level](message));
  if (!sessionDeps) {
    // Silent until 2026-09-23: this skip was the invisible first domino in
    // the "no tags generated" run — log it so a missing runtime/store/cwd
    // trio is diagnosable from the main log.
    logSink(
      'warn',
      `[CategoryService] hidden session unavailable for PMID ${input.pmid} — falling back to keyword matching`,
    );
    return null;
  }

  try {
    const result = await runTaskHiddenSession(
      input.pmid,
      {
        prompt: buildCategorizePrompt(input, catalogue),
        agentId: input.agentId ?? 'main',
        modelOverride: input.modelOverride,
        // Semantic picking over an already-read article is a short turn.
        timeoutMs: 120 * 1000,
      },
      sessionDeps,
    );
    const parsed = parseCategoryReply(result.finalText, catalogue);
    if (
      !parsed ||
      (parsed.categoryIds.length === 0 &&
        parsed.tagIds.length === 0 &&
        parsed.newCategories.length === 0 &&
        parsed.newTags.length === 0)
    ) {
      logSink(
        'warn',
        `[CategoryService] LLM pick unusable for PMID ${input.pmid}: ${result.finalText.slice(0, 160)}`,
      );
      return null;
    }
    const merged = await materializeNewEntries(
      input.pmid,
      parsed,
      catalogue,
      input.clientDeps,
      logSink,
    );
    if (merged.categoryIds.length === 0 && merged.tagIds.length === 0) {
      // Nothing survived (e.g. every create call failed) — treat like an
      // unusable reply and let the keyword heuristic decide.
      logSink(
        'warn',
        `[CategoryService] LLM pick produced no usable ids for PMID ${input.pmid}`,
      );
      return null;
    }
    logSink(
      'info',
      `[CategoryService] LLM picked ${merged.categoryIds.length} categor(ies) and ${merged.tagIds.length} tag(s) for PMID ${input.pmid}`,
    );
    return merged;
  } catch (err) {
    logSink(
      'warn',
      `[CategoryService] LLM pick session failed for PMID ${input.pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    return null;
  }
}

function buildCategorizePrompt(
  input: {
    pmid: string;
    extSummary: string;
    authors: PaperTaskAuthor[];
    xml?: string;
    xmlPath?: string;
  },
  catalogue: Catalogue,
): string {
  const abstract = extractAbstract(input.xml ?? '');
  const title = extractTitle(input.xml ?? '');
  const lines: string[] = [
    '请为下面这篇生物医学文献选择分类和标签。',
    '',
    `文献 PMID：${input.pmid}`,
  ];
  if (title) lines.push(`标题：${title}`);
  // Full abstract, no truncation — the category picker needs the complete
  // text to judge fit (user requirement 2026-09-19; the old 600-char cut
  // dropped method/result detail the picker relies on).
  if (abstract) lines.push(`摘要：${abstract}`);
  if (input.xmlPath) {
    lines.push(`全文 XML（本地文件，需要更多上下文时可读取）：${input.xmlPath}`);
  }
  if (catalogue.parentCategories.length > 0) {
    lines.push(
      '',
      '可选父分类（ID: 名称，新建分类时从中选择归属维度）：',
      ...catalogue.parentCategories.map(p => `${p.id}: ${p.name}`),
    );
  }
  // Same-name subcategories are legal under different parents (contract
  // §4.5.2) — append the parent name so the LLM (and the human reading the
  // prompt) can tell them apart instead of seeing what looks like a bug.
  const parentNameById = new Map(catalogue.parentCategories.map(p => [p.id, p.name]));
  lines.push(
    '',
    '可选分类（ID: 名称（父分类））：',
    ...catalogue.categories.map(c => {
      const parent = c.parentCategoryId ? parentNameById.get(c.parentCategoryId) : undefined;
      return parent ? `${c.id}: ${c.name}（${parent}）` : `${c.id}: ${c.name}`;
    }),
    '',
    '可选标签（ID: 名称）：',
    ...catalogue.tags.map(t => `${t.id}: ${t.name}`),
    '',
    '要求：',
    '1. 优先从上面给出的分类/标签 ID 里选；选择 1-2 个最贴切的分类、最多 3 个标签；',
    '2. 现有分类/标签确实都不贴切时，可以建议新建：新建分类必须从父分类 ID 里选一个归属维度（格式 父分类ID:名称），新建标签直接给名称；名称用简洁的中文（专有名词、通用缩写可保留英文，如 mRNA/LNP），不要用长英文短语，不超过 50 字；已选 + 新建合计不超过 2 个分类、3 个标签；',
    '3. 严格按以下四行格式回复，不要任何其他内容：',
    'CATEGORIES: <逗号分隔的分类ID，可为空>',
    'TAGS: <逗号分隔的标签ID，可为空>',
    'NEW_CATEGORIES: <逗号分隔的新建分类，格式 父分类ID:名称，可为空>',
    'NEW_TAGS: <逗号分隔的新建标签名称，可为空>',
  );
  return lines.join('\n');
}

/** A `NEW_CATEGORIES` entry: a new child category under a known parent. */
export interface NewCategorySuggestion {
  parentCategoryId: string;
  name: string;
}

/**
 * Parse the agent's `CATEGORIES:` / `TAGS:` reply against the catalogue
 * whitelist, plus the optional `NEW_CATEGORIES:` / `NEW_TAGS:` lines
 * (contract §4.5.3). Returns null when the two mandatory lines are missing
 * (unparseable reply); unknown ids are silently dropped rather than
 * trusted — the LLM never gets to invent ids the backend doesn't know.
 */
export function parseCategoryReply(
  reply: string,
  catalogue: {
    parentCategories?: Array<{ id: string }>;
    categories: Array<{ id: string }>;
    tags: Array<{ id: string }>;
  },
): {
  categoryIds: string[];
  tagIds: string[];
  newCategories: NewCategorySuggestion[];
  newTags: string[];
} | null {
  const catLine = reply.match(/^\s*CATEGORIES\s*[:：]\s*(.*)$/im);
  const tagLine = reply.match(/^\s*TAGS\s*[:：]\s*(.*)$/im);
  if (!catLine || !tagLine) return null;
  const validCategories = new Set(catalogue.categories.map(c => c.id));
  const validTags = new Set(catalogue.tags.map(t => t.id));
  const validParents = new Set((catalogue.parentCategories ?? []).map(p => p.id));
  return {
    categoryIds: extractValidIds(catLine[1], validCategories),
    tagIds: extractValidIds(tagLine[1], validTags),
    newCategories: parseNewCategorySuggestions(reply, validParents),
    newTags: parseNewTagNames(reply),
  };
}

/** Caps mirroring the pick rules: at most 2 new categories / 3 new tags. */
const MAX_NEW_CATEGORIES = 2;
const MAX_NEW_TAGS = 3;

/**
 * `NEW_CATEGORIES: 父分类ID:名称,...` — the parent id must be a known parent
 * category; names are sanitized and deduplicated; malformed tokens are
 * dropped rather than trusted.
 */
function parseNewCategorySuggestions(
  reply: string,
  validParents: Set<string>,
): NewCategorySuggestion[] {
  const line = reply.match(/^\s*NEW_CATEGORIES\s*[:：]\s*(.*)$/im);
  if (!line) return [];
  const out: NewCategorySuggestion[] = [];
  for (const token of splitNameTokens(line[1])) {
    const pair = token.match(/^(\S+?)\s*[:：]\s*(.+)$/);
    if (!pair) continue;
    const [, parentCategoryId, rawName] = pair;
    const name = sanitizeNewName(rawName);
    if (!name || !validParents.has(parentCategoryId)) continue;
    if (
      out.some(entry => entry.parentCategoryId === parentCategoryId && entry.name === name)
    ) {
      continue;
    }
    out.push({ parentCategoryId, name });
    if (out.length >= MAX_NEW_CATEGORIES) break;
  }
  return out;
}

/** `NEW_TAGS: 名称,...` — sanitized, deduplicated names. */
function parseNewTagNames(reply: string): string[] {
  const line = reply.match(/^\s*NEW_TAGS\s*[:：]\s*(.*)$/im);
  if (!line) return [];
  const names: string[] = [];
  for (const token of splitNameTokens(line[1])) {
    const name = sanitizeNewName(token);
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length >= MAX_NEW_TAGS) break;
  }
  return names;
}

/**
 * Split a NEW_* line into raw tokens. Unlike the id lists, names may contain
 * spaces, so only list punctuation splits — never whitespace.
 */
function splitNameTokens(raw: string): string[] {
  return raw
    .split(/[,，、;；]+/)
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

/** Trim, strip wrapping quotes, and enforce the backend's 1-50 char name rule. */
function sanitizeNewName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^["'「『]+/, '')
    .replace(/["'」』]+$/, '')
    .trim();
  if (name.length < 1 || name.length > 50) return null;
  return name;
}

/** Split a raw id list and keep only known, deduplicated ids, in order. */
function extractValidIds(raw: string, valid: Set<string>): string[] {
  const ids: string[] = [];
  for (const token of raw.split(/[,，、;；\s]+/)) {
    const id = token.trim();
    if (id && valid.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

interface CatalogResponse {
  code: number;
  data?: {
    parentCategories?: Array<{ id: number | string; type?: string; name: string; description?: string }>;
    categories?: Array<{ id: number | string; name: string; parentCategoryId?: number | string; groupCode?: string }>;
    tags?: Array<{ id: number | string; name: string; isActive?: number }>;
    total?: number;
  };
}

/** Catalogue fetch attempts before giving up (user decision 2026-09-23). */
const CATALOGUE_FETCH_ATTEMPTS = 3;
const CATALOGUE_FETCH_RETRY_DELAY_MS = 1000;

/**
 * Fetch the catalogue with bounded retries. An empty `categories` list is
 * treated as a failure too — picking without a catalogue is exactly the
 * silent-empty-tags bug this retry loop exists to prevent. After the last
 * attempt the error is rethrown so the caller (and the advance run) can
 * abort visibly instead of degrading to an empty submission.
 */
async function fetchCategoryCatalogueWithRetry(
  deps: PaperPipelineClientDeps,
  logSink: (level: 'info' | 'warn' | 'error', message: string) => void,
  pmid: string,
): Promise<Catalogue> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CATALOGUE_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const catalogue = await fetchCategoryCatalogue(deps);
      if (catalogue.categories.length === 0) {
        throw new Error('/lit/catalog returned an empty category list');
      }
      return catalogue;
    } catch (err) {
      lastError = err;
      if (attempt < CATALOGUE_FETCH_ATTEMPTS) {
        logSink(
          'warn',
          `[CategoryService] catalogue fetch ${attempt}/${CATALOGUE_FETCH_ATTEMPTS} failed for PMID ${pmid}: ${
            err instanceof Error ? err.message : 'unknown'
          } — retrying`,
        );
        await new Promise(resolve => setTimeout(resolve, CATALOGUE_FETCH_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(
    `category catalogue unavailable after ${CATALOGUE_FETCH_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : 'unknown error'
    }`,
  );
}

/**
 * Hit `GET /lit/catalog` (contract §4.4) and normalise the response into a
 * flat catalogue. The endpoint intentionally rolls the `parentCategories`
 * field into the response so the picker doesn't need a second round-trip
 * to look up a `groupCode` per category — `categories[].groupCode` is
 * already populated server-side (it equals the parent `type`).
 */
async function fetchCategoryCatalogue(deps: PaperPipelineClientDeps): Promise<Catalogue> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    [LitAuthHeader.Name]: LitAuthHeader.Value,
  };
  const token = deps.getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await net.fetch(`${deps.getBaseUrl()}/lit/catalog`, { headers });
  if (!response.ok) {
    throw new Error(`/lit/catalog returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as CatalogResponse;
  if (payload.code !== 200 || !payload.data) {
    throw new Error(`/lit/catalog non-success code=${payload.code}`);
  }

  return {
    parentCategories: (payload.data.parentCategories ?? []).map(p => ({
      id: String(p.id),
      name: p.name,
    })),
    categories: (payload.data.categories ?? []).map(c => ({
      id: String(c.id),
      name: c.name,
      parentCategoryId:
        c.parentCategoryId !== undefined ? String(c.parentCategoryId) : undefined,
      groupCode: c.groupCode,
    })),
    // Contract v1.5 (2026-09-21): the backend filters is_active=1
    // server-side. Keep a client-side guard as double insurance; isActive
    // missing (pre-v1.5 backend) is treated as active so the whole tag
    // pool isn't dropped on old deployments.
    tags: (payload.data.tags ?? [])
      .filter(t => t.isActive === undefined || t.isActive === 1)
      .map(t => ({
        id: String(t.id),
        name: t.name,
      })),
  };
}

interface CreateResponse {
  code: number;
  msg?: string;
  data?: { id: number | string; name?: string };
}

/** Common headers for the /lit/* catalogue write endpoints. */
function litWriteHeaders(deps: PaperPipelineClientDeps): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [LitAuthHeader.Name]: LitAuthHeader.Value,
  };
  const token = deps.getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** POST one of the §4.5 create endpoints and return the created entity's id. */
async function postLitCreate(
  path: string,
  body: Record<string, unknown>,
  deps: PaperPipelineClientDeps,
): Promise<string> {
  const response = await net.fetch(`${deps.getBaseUrl()}${path}`, {
    method: 'POST',
    headers: litWriteHeaders(deps),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as CreateResponse;
  if (payload.code !== 200 || payload.data?.id === undefined) {
    throw new Error(
      `POST ${path} non-success code=${payload.code} msg=${payload.msg ?? ''}`,
    );
  }
  return String(payload.data.id);
}

/** `POST /lit/tags` (contract §4.5) — idempotent by name. */
async function createTag(
  name: string,
  deps: PaperPipelineClientDeps,
): Promise<string> {
  return postLitCreate('/lit/tags', { name }, deps);
}

/** `POST /lit/categories` (contract §4.5) — idempotent per (parent, name). */
async function createCategory(
  name: string,
  parentCategoryId: string,
  deps: PaperPipelineClientDeps,
): Promise<string> {
  return postLitCreate(
    '/lit/categories',
    { name, parentCategoryId: Number(parentCategoryId) },
    deps,
  );
}

/**
 * Create the agent's suggested new entries and merge the returned ids into
 * the picked lists — create-then-submit per §4.5.3. A suggested tag whose
 * name already exists in the catalogue resolves locally without a create
 * round-trip. Creation failures are logged and skipped; they never break
 * the categorize step.
 */
async function materializeNewEntries(
  pmid: string,
  parsed: {
    categoryIds: string[];
    tagIds: string[];
    newCategories: NewCategorySuggestion[];
    newTags: string[];
  },
  catalogue: Catalogue,
  clientDeps: PaperPipelineClientDeps,
  logSink: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<{ categoryIds: string[]; tagIds: string[] }> {
  const categoryIds = [...parsed.categoryIds];
  const tagIds = [...parsed.tagIds];
  const tagIdByName = new Map(catalogue.tags.map(t => [t.name, t.id]));

  for (const { parentCategoryId, name } of parsed.newCategories) {
    try {
      const id = await createCategory(name, parentCategoryId, clientDeps);
      if (!categoryIds.includes(id)) categoryIds.push(id);
      logSink(
        'info',
        `[CategoryService] created category "${name}" under parent ${parentCategoryId} (id=${id}) for PMID ${pmid}`,
      );
    } catch (err) {
      logSink(
        'warn',
        `[CategoryService] createCategory("${name}") failed for PMID ${pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
  for (const name of parsed.newTags) {
    try {
      const id = tagIdByName.get(name) ?? (await createTag(name, clientDeps));
      if (!tagIds.includes(id)) tagIds.push(id);
      logSink(
        'info',
        `[CategoryService] resolved new tag "${name}" (id=${id}) for PMID ${pmid}`,
      );
    } catch (err) {
      logSink(
        'warn',
        `[CategoryService] createTag("${name}") failed for PMID ${pmid}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
  return { categoryIds, tagIds };
}

async function buildPickText(input: {
  pmid: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
  xml?: string;
}): Promise<string> {
  const abstract = extractAbstract(input.xml ?? '');
  const title = extractTitle(input.xml ?? '');
  const authorNames = input.authors.map(a => a.fullName).join(' ');
  return [
    input.extSummary,
    abstract,
    title,
    authorNames,
    `pmid ${input.pmid}`,
  ]
    .filter(part => part && part.length > 0)
    .join(' ')
    .toLowerCase();
}

interface MatchEntry {
  id: string;
  name: string;
}

function pickBestMatches(
  text: string,
  entries: MatchEntry[],
  maxResults: number,
): MatchEntry[] {
  if (!text || entries.length === 0) return [];
  const scored = entries
    .map(entry => ({ entry, score: scoreMatch(text, entry.name) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(item => item.entry);
}

/**
 * Sum the number of distinct tokens from `name` that appear in `text`.
 * Single-character tokens are ignored to avoid spurious matches.
 */
function scoreMatch(text: string, name: string): number {
  if (!name) return 0;
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter(token => token.length >= 2);
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += 1;
  }
  return score;
}

