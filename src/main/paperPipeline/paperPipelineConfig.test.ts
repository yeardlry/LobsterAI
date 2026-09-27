import { describe, expect, test } from 'vitest';

import {
  DEFAULT_PDF_URL_SUGGEST_MODEL,
} from '../../shared/paperPipeline/constants';
import type { PaperPipelineModelConfig } from '../../shared/paperPipeline/types';
import {
  DEFAULT_PAPER_PIPELINE_MODEL_CONFIG,
  PAPER_PIPELINE_CONFIG_KV_KEY,
  readPaperPipelineModelConfig,
  resolvePdfUrlSuggestModel,
  resolvePipelineModelOverride,
  sanitizePaperPipelineModelConfig,
  writePaperPipelineModelConfig,
} from './paperPipelineConfig';

interface KvStoreStub {
  values: Map<string, unknown>;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

const createStoreStub = (initial: Record<string, unknown> = {}): KvStoreStub => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
};

describe('sanitizePaperPipelineModelConfig', () => {
  test('non-object payloads degrade to defaults', () => {
    expect(sanitizePaperPipelineModelConfig(null)).toEqual(DEFAULT_PAPER_PIPELINE_MODEL_CONFIG);
    expect(sanitizePaperPipelineModelConfig(undefined)).toEqual(DEFAULT_PAPER_PIPELINE_MODEL_CONFIG);
    expect(sanitizePaperPipelineModelConfig('deepseek/deepseek-v4-flash')).toEqual(
      DEFAULT_PAPER_PIPELINE_MODEL_CONFIG,
    );
    expect(sanitizePaperPipelineModelConfig(42)).toEqual(DEFAULT_PAPER_PIPELINE_MODEL_CONFIG);
    expect(sanitizePaperPipelineModelConfig(['deepseek/deepseek-v4-flash'])).toEqual(
      DEFAULT_PAPER_PIPELINE_MODEL_CONFIG,
    );
  });

  test('valid provider-qualified refs survive, others are dropped per-field', () => {
    expect(
      sanitizePaperPipelineModelConfig({
        pipelineModel: 'deepseek/deepseek-v4-flash',
        pdfUrlSuggestModel: 'lobsterai-server/glm-4.7',
      }),
    ).toEqual({ pipelineModel: 'deepseek/deepseek-v4-flash', pdfUrlSuggestModel: 'lobsterai-server/glm-4.7' });

    // Missing "/" → dropped; garbage type → dropped; trim applied.
    expect(
      sanitizePaperPipelineModelConfig({
        pipelineModel: 'deepseek-v4-flash',
        pdfUrlSuggestModel: '  deepseek/deepseek-v4-flash  ',
      }),
    ).toEqual({ pipelineModel: '', pdfUrlSuggestModel: 'deepseek/deepseek-v4-flash' });

    expect(
      sanitizePaperPipelineModelConfig({ pipelineModel: 123, pdfUrlSuggestModel: { deepseek: 1 } }),
    ).toEqual(DEFAULT_PAPER_PIPELINE_MODEL_CONFIG);
  });

  test('over-long refs are rejected', () => {
    const longRef = `deepseek/${'a'.repeat(300)}`;
    expect(sanitizePaperPipelineModelConfig({ pipelineModel: longRef })).toEqual(
      DEFAULT_PAPER_PIPELINE_MODEL_CONFIG,
    );
  });
});

describe('readPaperPipelineModelConfig', () => {
  test('missing row yields defaults', () => {
    expect(readPaperPipelineModelConfig(createStoreStub())).toEqual(DEFAULT_PAPER_PIPELINE_MODEL_CONFIG);
  });

  test('corrupt row yields defaults; valid row round-trips', () => {
    expect(readPaperPipelineModelConfig(createStoreStub({
      [PAPER_PIPELINE_CONFIG_KV_KEY]: 'not-json-object',
    }))).toEqual(DEFAULT_PAPER_PIPELINE_MODEL_CONFIG);

    const valid: PaperPipelineModelConfig = {
      pipelineModel: 'deepseek/deepseek-v4-flash',
      pdfUrlSuggestModel: '',
    };
    expect(
      readPaperPipelineModelConfig(createStoreStub({ [PAPER_PIPELINE_CONFIG_KV_KEY]: valid })),
    ).toEqual(valid);
  });
});

describe('writePaperPipelineModelConfig', () => {
  test('sanitizes, persists under the kv key, and returns the sanitized value', () => {
    const store = createStoreStub();
    const result = writePaperPipelineModelConfig(store, {
      pipelineModel: '  deepseek/deepseek-v4-flash  ',
      pdfUrlSuggestModel: 'garbage-no-slash',
    });
    expect(result).toEqual({ pipelineModel: 'deepseek/deepseek-v4-flash', pdfUrlSuggestModel: '' });
    expect(store.values.get(PAPER_PIPELINE_CONFIG_KV_KEY)).toEqual(result);
  });
});

describe('resolvePipelineModelOverride', () => {
  const unset: PaperPipelineModelConfig = { pipelineModel: '', pdfUrlSuggestModel: '' };

  test('explicit config wins verbatim — no substitution ever', () => {
    expect(
      resolvePipelineModelOverride('deepseek/deepseek-reasoner', {
        pipelineModel: 'zhipu/glm-4.7',
        pdfUrlSuggestModel: '',
      }),
    ).toBe('zhipu/glm-4.7');
  });

  test('unset + DeepSeek reasoner binding → same-provider v4-flash swap', () => {
    expect(resolvePipelineModelOverride('deepseek/deepseek-reasoner', unset)).toBe(
      'deepseek/deepseek-v4-flash',
    );
    expect(resolvePipelineModelOverride('deepseek/deepseek-r1', unset)).toBe(
      'deepseek/deepseek-v4-flash',
    );
    // Whitespace / casing tolerated.
    expect(resolvePipelineModelOverride('  DeepSeek/DeepSeek-Reasoner ', unset)).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });

  test('unset + non-reasoner DeepSeek model → no override', () => {
    expect(resolvePipelineModelOverride('deepseek/deepseek-v4-flash', unset)).toBe('');
    expect(resolvePipelineModelOverride('deepseek/deepseek-chat', unset)).toBe('');
  });

  test('unset + non-DeepSeek provider → never cross-provider forced', () => {
    expect(resolvePipelineModelOverride('zhipu/glm-4.7', unset)).toBe('');
    expect(resolvePipelineModelOverride('openai/gpt-5', unset)).toBe('');
    expect(resolvePipelineModelOverride('anthropic/claude-sonnet-5', unset)).toBe('');
    expect(resolvePipelineModelOverride('moonshot/kimi-k2', unset)).toBe('');
  });

  test('unset + empty/unparsable agent model → no override', () => {
    expect(resolvePipelineModelOverride('', unset)).toBe('');
    expect(resolvePipelineModelOverride('   ', unset)).toBe('');
    expect(resolvePipelineModelOverride('bare-model-id', unset)).toBe('');
    expect(resolvePipelineModelOverride('deepseek/', unset)).toBe('');
    expect(resolvePipelineModelOverride('/deepseek-reasoner', unset)).toBe('');
  });
});

describe('resolvePdfUrlSuggestModel', () => {
  test('unset falls back to the shared default constant', () => {
    expect(resolvePdfUrlSuggestModel({ pipelineModel: '', pdfUrlSuggestModel: '' })).toBe(
      DEFAULT_PDF_URL_SUGGEST_MODEL,
    );
  });

  test('explicit value passes through', () => {
    expect(resolvePdfUrlSuggestModel({ pipelineModel: '', pdfUrlSuggestModel: 'zhipu/glm-4.7' })).toBe(
      'zhipu/glm-4.7',
    );
  });
});
