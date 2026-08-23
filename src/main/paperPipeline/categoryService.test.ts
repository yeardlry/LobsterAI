import { afterEach,beforeEach, describe, expect, test, vi } from 'vitest';

import { pickCategories } from './categoryService';

const cataloguePayload = {
  code: 200,
  data: {
    categories: [
      { id: 1, name: 'LNP delivery', groupCode: 'delivery_system' },
      { id: 2, name: 'mRNA vaccine', groupCode: 'application' },
      { id: 3, name: 'Unrelated category' },
    ],
    tags: [
      { id: 10, name: 'mRNA' },
      { id: 11, name: 'LNP' },
      { id: 12, name: 'lipid' },
      { id: 13, name: 'unrelated tag' },
    ],
  },
};

describe('categoryService', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(cataloguePayload), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('returns matching categories and tags from the lit catalogue', async () => {
    const result = await pickCategories({
      pmid: '39106599',
      extSummary: 'This paper is about LNP delivery of mRNA vaccine.',
      authors: [{ fullName: 'Alice Reiser' }],
      clientDeps: {
        getBaseUrl: () => 'https://lit.example',
        getAccessToken: () => 'token-abc',
      },
    });
    expect(result.categoryIds.length).toBeGreaterThan(0);
    expect(result.tagIds.length).toBeGreaterThan(0);
    // The keyword 'mRNA' should be in the tags.
    expect(result.tagIds).toContain('10');
  });

  test('returns empty lists when the catalogue fetch fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    const result = await pickCategories({
      pmid: '39106599',
      extSummary: 'whatever',
      authors: [],
      clientDeps: {
        getBaseUrl: () => 'https://lit.example',
        getAccessToken: () => null,
      },
    });
    expect(result).toEqual({ categoryIds: [], tagIds: [] });
  });
});