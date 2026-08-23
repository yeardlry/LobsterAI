import type { PaperTaskAuthor } from '../../shared/paperPipeline/types';
import type { PaperPipelineClientDeps } from './paperPipelineClient';
import { extractAbstract, extractTitle } from './xmlParser';

/**
 * Phase 5 category picker.
 *
 * The lit backend now exposes a `/lit/categories/all` endpoint (see
 * `docs/MCP工具清单.md §3.2` / `docs/对外接口兼容清单.md §20`). We fetch
 * the catalogue once per pick (lightweight, RuoYi-cached), then pick
 * the best-matching category + tags by simple keyword overlap with the
 * heuristic extSummary.
 *
 * Why keyword overlap and not an LLM? Phase 5 prioritises deterministic
 * behaviour so the first integration round can validate the wiring. The
 * heuristic is intentionally conservative: when nothing obvious matches,
 * we hand back `[]` rather than a wrong guess (the contract on
 * `submitCategories` allows both `categoryIds` and `tagIds` to be empty
 * — see `外部处理架构与接口方案.md §三.5`).
 *
 * Phase 6 (out of scope here) will swap the picker for an LLM-driven one
 * once OpenClaw is reliably online.
 */
export async function pickCategories(input: {
  pmid: string;
  extSummary: string;
  authors: PaperTaskAuthor[];
  clientDeps: PaperPipelineClientDeps;
  /** Optional raw XML to mine for abstract / title; supplied by callers
   *  that have it in memory. */
  xml?: string;
}): Promise<{ categoryIds: string[]; tagIds: string[] }> {
  const catalogue = await fetchCategoryCatalogue(input.clientDeps).catch((): null => null);
  if (!catalogue || catalogue.categories.length === 0) {
    // No catalogue → keep the task moving by submitting an empty list,
    // which the contract explicitly permits.
    return { categoryIds: [], tagIds: [] };
  }

  const text = await buildPickText(input);
  const categories = pickBestMatches(text, catalogue.categories, 2);
  const tags = pickBestMatches(text, catalogue.tags, 3);

  return {
    categoryIds: categories.map(c => c.id),
    tagIds: tags.map(t => t.id),
  };
}

interface Catalogue {
  categories: Array<{ id: string; name: string; groupCode?: string }>;
  tags: Array<{ id: string; name: string }>;
}

interface CategoryCatalogueResponse {
  code: number;
  data?: {
    categories?: Array<{ id: string | number; name: string; groupCode?: string }>;
    tags?: Array<{ id: string | number; name: string }>;
  };
}

/** Hit `/lit/categories/all` and normalise the response into a flat catalogue. */
async function fetchCategoryCatalogue(deps: PaperPipelineClientDeps): Promise<Catalogue> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = deps.getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${deps.getBaseUrl()}/lit/categories/all`, { headers });
  if (!response.ok) {
    throw new Error(`/lit/categories/all returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as CategoryCatalogueResponse;
  if (payload.code !== 200 || !payload.data) {
    throw new Error(`/lit/categories/all non-success code=${payload.code}`);
  }

  return {
    categories: (payload.data.categories ?? []).map(c => ({
      id: String(c.id),
      name: c.name,
      groupCode: c.groupCode,
    })),
    tags: (payload.data.tags ?? []).map(t => ({
      id: String(t.id),
      name: t.name,
    })),
  };
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

