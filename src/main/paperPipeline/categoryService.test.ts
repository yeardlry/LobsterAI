import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';

const cataloguePayload = {
  code: 200,
  data: {
    parentCategories: [
      { id: 1, type: 'delivery_system', name: '疫苗递送' },
      { id: 2, type: 'application', name: '应用方向' },
    ],
    categories: [
      { id: 1, name: 'LNP delivery', parentCategoryId: 1, groupCode: 'delivery_system' },
      { id: 2, name: 'mRNA vaccine', parentCategoryId: 2, groupCode: 'application' },
      { id: 3, name: 'Unrelated category', parentCategoryId: 1 },
    ],
    tags: [
      { id: 10, name: 'mRNA', isActive: 1 },
      { id: 11, name: 'LNP', isActive: 1 },
      { id: 12, name: 'lipid', isActive: 1 },
      { id: 13, name: 'unrelated tag', isActive: 1 },
      // Contract v1.5: inactive tags must not reach the prompt / whitelist.
      { id: 14, name: 'stale tag', isActive: 0 },
    ],
    total: 3,
  },
};

/**
 * `pickCategories` calls `net.fetch` (Electron) for `/lit/catalog`
 * (contract §4.4, added 2026-08-27). We mock `electron` here so the
 * test runs in plain Node without an Electron runtime.
 */
const netFetch = vi.fn();

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
}));

/**
 * The LLM path drives the pooled hidden session via `runTaskHiddenSession`.
 * We mock just that function (the real `resolveTaskSessionDeps` stays) so
 * the fallback logic runs against controlled replies.
 */
const runTaskHiddenSessionMock = vi.fn();

vi.mock('./taskHiddenSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskHiddenSession')>();
  return {
    ...actual,
    runTaskHiddenSession: (...args: unknown[]) => runTaskHiddenSessionMock(...args),
  };
});

// Import after vi.mock so the mock is wired up before module init.
const {
  parseCategoryReply,
  pickCategories: pickCategoriesUnderTest,
} = await import('./categoryService');

const clientDeps = {
  getBaseUrl: () => 'https://lit.example',
  getAccessToken: () => 'token-abc',
  isLitAuthSession: () => true,
};

/** Session deps wired with dummies — the runner is mocked, so only
 * truthiness matters (mirrors what `resolveTaskSessionDeps` checks). */
const wiredDeps = {
  coworkRuntime: {} as CoworkRuntime,
  coworkStore: {} as CoworkStore,
  resolveAgentCwd: () => '/tmp',
};

describe('parseCategoryReply', () => {
  const catalogue = {
    parentCategories: [{ id: '1' }, { id: '2' }],
    categories: [{ id: '1' }, { id: '2' }, { id: '3' }],
    tags: [{ id: '10' }, { id: '11' }, { id: '12' }],
  };

  test('parses the two protocol lines and keeps valid ids in order', () => {
    const parsed = parseCategoryReply('CATEGORIES: 2, 1\nTAGS: 11, 10', catalogue);
    expect(parsed).toEqual({
      categoryIds: ['2', '1'],
      tagIds: ['11', '10'],
      newCategories: [],
      newTags: [],
    });
  });

  test('drops unknown ids instead of trusting them', () => {
    const parsed = parseCategoryReply('CATEGORIES: 1, 999\nTAGS: 10, 42, 11', catalogue);
    expect(parsed).toEqual({
      categoryIds: ['1'],
      tagIds: ['10', '11'],
      newCategories: [],
      newTags: [],
    });
  });

  test('handles full-width punctuation and deduplication', () => {
    const parsed = parseCategoryReply('CATEGORIES：1、1，2\nTAGS： 12', catalogue);
    expect(parsed).toEqual({
      categoryIds: ['1', '2'],
      tagIds: ['12'],
      newCategories: [],
      newTags: [],
    });
  });

  test('parses NEW_CATEGORIES pairs and NEW_TAGS names', () => {
    const parsed = parseCategoryReply(
      'CATEGORIES: \nTAGS: \nNEW_CATEGORIES: 1:递送系统， 2:mRNA 稳定性\nNEW_TAGS: 脂质纳米颗粒, LNP delivery',
      catalogue,
    );
    expect(parsed?.newCategories).toEqual([
      { parentCategoryId: '1', name: '递送系统' },
      // Names may contain spaces — only list punctuation splits.
      { parentCategoryId: '2', name: 'mRNA 稳定性' },
    ]);
    expect(parsed?.newTags).toEqual(['脂质纳米颗粒', 'LNP delivery']);
  });

  test('drops NEW_CATEGORIES entries with unknown parents or invalid names', () => {
    const parsed = parseCategoryReply(
      'CATEGORIES: 1\nTAGS: 10\n' +
        `NEW_CATEGORIES: 999:坏父级, 只有名称没有冒号, 1:${'超'.repeat(51)}\n` +
        `NEW_TAGS: "", ${'长'.repeat(51)}, 脂质纳米颗粒`,
      catalogue,
    );
    expect(parsed?.newCategories).toEqual([]);
    expect(parsed?.newTags).toEqual(['脂质纳米颗粒']);
  });

  test('caps new entries at 2 categories / 3 tags and strips wrapping quotes', () => {
    const parsed = parseCategoryReply(
      'CATEGORIES: 1\nTAGS: 10\nNEW_CATEGORIES: 1:a, 2:b, 1:c\nNEW_TAGS: "t1", t2, t3, t4',
      catalogue,
    );
    expect(parsed?.newCategories).toEqual([
      { parentCategoryId: '1', name: 'a' },
      { parentCategoryId: '2', name: 'b' },
    ]);
    expect(parsed?.newTags).toEqual(['t1', 't2', 't3']);
  });

  test('returns null when the protocol lines are missing', () => {
    expect(parseCategoryReply('我觉得应该选 1 和 2', catalogue)).toBeNull();
    expect(parseCategoryReply('CATEGORIES: 1\n其他内容', catalogue)).toBeNull();
  });
});

describe('categoryService', () => {
  beforeEach(() => {
    netFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runTaskHiddenSessionMock.mockReset();
  });

  test('returns matching categories and tags from the lit catalogue', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
      authors: [{ fullName: 'Alice Reiser' }],
      clientDeps,
    });
    expect(result.categoryIds.length).toBeGreaterThan(0);
    expect(result.tagIds.length).toBeGreaterThan(0);
    // The keyword 'mRNA' should be in the tags.
    expect(result.tagIds).toContain('10');
    // No session deps wired → the keyword heuristic runs, no LLM attempt.
    expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
  });

  test('returns the LLM pick, whitelisted against the catalogue', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'CATEGORIES: 1, 999\nTAGS: 10, 13, 14',
      segmentCount: 1,
    });

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'an LNP delivery paper',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    // 999 is unknown and 14 is inactive — both dropped, not trusted.
    expect(result).toEqual({ categoryIds: ['1'], tagIds: ['10', '13'] });
    const [pmid, input] = runTaskHiddenSessionMock.mock.calls[0] as unknown as [
      string,
      { prompt: string; agentId: string },
    ];
    expect(pmid).toBe('39106599');
    expect(input.prompt).toContain('CATEGORIES');
    // §4.5.2: subcategories render with their parent dimension so
    // same-name entries under different parents are distinguishable.
    expect(input.prompt).toContain('1: LNP delivery（疫苗递送）');
    // The inactive tag never reaches the prompt (v1.5 double insurance).
    expect(input.prompt).not.toContain('stale tag');
    // §4.5.3: the reply format now has four lines and the prompt lists the
    // parent categories a NEW_CATEGORIES entry may target.
    expect(input.prompt).toContain('NEW_CATEGORIES');
    expect(input.prompt).toContain('NEW_TAGS');
    expect(input.prompt).toContain('1: 疫苗递送');
    // New-entry names are steered to concise Chinese — long English phrases
    // pollute the shared tag pool (user guidance 2026-09-21).
    expect(input.prompt).toContain('名称用简洁的中文');
    expect(input.agentId).toBe('main');
  });

  test('creates suggested entries via §4.5 and merges the returned ids', async () => {
    netFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/lit/tags')) {
        const body = JSON.parse(init.body ?? '{}') as { name: string };
        expect(body).toEqual({ name: '脂质纳米颗粒' });
        return new Response(
          JSON.stringify({ code: 200, data: { id: 99, name: body.name } }),
          { status: 200 },
        );
      }
      if (init?.method === 'POST' && url.endsWith('/lit/categories')) {
        const body = JSON.parse(init.body ?? '{}') as { name: string; parentCategoryId: number };
        expect(body).toEqual({ name: '递送系统', parentCategoryId: 2 });
        return new Response(
          JSON.stringify({
            code: 200,
            data: { id: 312, name: body.name, parentCategoryId: 2 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(cataloguePayload), { status: 200 });
    });
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'CATEGORIES: 1\nTAGS: \nNEW_CATEGORIES: 2:递送系统\nNEW_TAGS: 脂质纳米颗粒',
      segmentCount: 1,
    });

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'an LNP delivery paper',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    // Create-then-submit: picked id 1 + created 312; created tag 99.
    expect(result).toEqual({ categoryIds: ['1', '312'], tagIds: ['99'] });
  });

  test('resolves a suggested tag name against the catalogue without a create call', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      // 'LNP' already exists as tag 11 — no POST /lit/tags round-trip.
      finalText: 'CATEGORIES: \nTAGS: \nNEW_TAGS: LNP',
      segmentCount: 1,
    });

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'an LNP delivery paper',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    expect(result).toEqual({ categoryIds: [], tagIds: ['11'] });
    // Only the catalogue GET happened.
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  test('skips entries whose create call fails and keeps the usable picks', async () => {
    netFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 200 });
      }
      return new Response(JSON.stringify(cataloguePayload), { status: 200 });
    });
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'CATEGORIES: 1\nTAGS: 10\nNEW_CATEGORIES: 2:递送系统\nNEW_TAGS: 脂质纳米颗粒',
      segmentCount: 1,
    });

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'an LNP delivery paper',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    // Both creates failed → the new suggestions are dropped, the whitelist
    // picks survive.
    expect(result).toEqual({ categoryIds: ['1'], tagIds: ['10'] });
  });

  test('falls back to the keyword heuristic when every create fails and nothing else fits', async () => {
    netFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 403, msg: 'read-only account' }), { status: 200 });
      }
      return new Response(JSON.stringify(cataloguePayload), { status: 200 });
    });
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'CATEGORIES: \nTAGS: \nNEW_TAGS: 脂质纳米颗粒',
      segmentCount: 1,
    });

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    // New-only reply whose create failed → same as an unusable reply: the
    // keyword heuristic runs.
    expect(result.tagIds).toContain('10');
  });

  test('falls back to the keyword heuristic when the LLM reply is unusable', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
    runTaskHiddenSessionMock.mockResolvedValue({
      sessionId: 'sess-1',
      finalText: 'CATEGORIES: 999\nTAGS: 42',
      segmentCount: 1,
    });

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    // Everything the agent said was unknown → keyword heuristic result.
    expect(result.categoryIds.length).toBeGreaterThan(0);
    expect(result.tagIds).toContain('10');
  });

  test('falls back to the keyword heuristic when the session throws', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
    runTaskHiddenSessionMock.mockRejectedValue(new Error('timed out'));

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
      authors: [],
      clientDeps,
      deps: wiredDeps,
    });

    expect(result.categoryIds.length).toBeGreaterThan(0);
  });

  test('retries the catalogue fetch, then throws after the final attempt', async () => {
    // User decision 2026-09-23: an unreachable catalogue used to silently
    // submit empty lists (the task advanced with no tags and nothing in the
    // logs). Now the fetch retries, and exhaustion THROWS so the advance
    // run aborts visibly.
    netFetch.mockRejectedValue(new Error('network down'));
    const log = vi.fn();
    vi.useFakeTimers();
    try {
      const promise = pickCategoriesUnderTest({
        pmid: '39106599',
        extSummary: 'whatever',
        authors: [],
        clientDeps,
        deps: { log },
      });
      const expectation = expect(promise).rejects.toThrow(
        'category catalogue unavailable after 3 attempts: network down',
      );
      // Flush both 1s retry delays while the promise chain is pending.
      await vi.advanceTimersByTimeAsync(2000);
      await expectation;

      expect(netFetch).toHaveBeenCalledTimes(3);
      // Each retry warned through the caller's log sink (visibility was the
      // whole point of this fix).
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('catalogue fetch 1/3 failed'),
      );
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('catalogue fetch 2/3 failed'),
      );
      // No LLM turn ever ran — the run must not continue tagless.
      expect(runTaskHiddenSessionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('recovers when a catalogue retry succeeds', async () => {
    netFetch
      .mockRejectedValueOnce(new Error('transient 502'))
      .mockResolvedValue(new Response(JSON.stringify(cataloguePayload), { status: 200 }));
    const log = vi.fn();
    vi.useFakeTimers();
    try {
      const promise = pickCategoriesUnderTest({
        pmid: '39106599',
        extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
        authors: [],
        clientDeps,
        deps: { log },
      });
      const expectation = expect(promise).resolves.toMatchObject({
        categoryIds: expect.any(Array),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expectation;

      expect(netFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('treats an empty catalogue as a failure and aborts after retries', async () => {
    // A 200 with zero categories is as unusable as a network error — the
    // keyword/LLM pickers both need the catalogue to exist. Fresh Response
    // per attempt: a body can only be read once.
    netFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: 200, data: { categories: [], tags: [] } }), {
          status: 200,
        }),
    );
    const log = vi.fn();
    vi.useFakeTimers();
    try {
      const promise = pickCategoriesUnderTest({
        pmid: '39106599',
        extSummary: 'whatever',
        authors: [],
        clientDeps,
        deps: { log },
      });
      const expectation = expect(promise).rejects.toThrow(
        'category catalogue unavailable after 3 attempts: /lit/catalog returned an empty category list',
      );
      await vi.advanceTimersByTimeAsync(2000);
      await expectation;

      expect(netFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('warns when the LLM path is skipped because session deps are missing', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
    const log = vi.fn();

    const result = await pickCategoriesUnderTest({
      pmid: '39106599',
      extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
      authors: [],
      clientDeps,
      // No coworkRuntime/store/cwd — the old code fell through silently.
      deps: { log },
    });

    expect(result.tagIds).toContain('10');
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('hidden session unavailable'),
    );
  });
});
