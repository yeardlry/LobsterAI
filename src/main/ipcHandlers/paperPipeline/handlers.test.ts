import { beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { PaperPipelineIpcChannel } from '../../../shared/paperPipeline/constants';
import type { PaperPipelineModelConfig } from '../../../shared/paperPipeline/types';
import {
  type PaperPipelineHandlerDeps,
  registerPaperPipelineHandlers,
} from './handlers';

function makeDeps(
  options: {
    litAuth?: boolean;
    modelConfig?: PaperPipelineModelConfig;
  } = {},
) {
  const readPipelineModelConfig = vi.fn(
    (): PaperPipelineModelConfig =>
      options.modelConfig ?? { pipelineModel: '', pdfUrlSuggestModel: '' },
  );
  const writePipelineModelConfig = vi.fn(
    (raw: unknown): PaperPipelineModelConfig => {
      if (raw === null || typeof raw !== 'object') {
        throw new Error('invalid payload');
      }
      return { pipelineModel: '', pdfUrlSuggestModel: '' };
    },
  );
  const deps: PaperPipelineHandlerDeps = {
    isLitAuthSession: () => options.litAuth ?? true,
    readPipelineModelConfig,
    writePipelineModelConfig,
  };
  return { deps, readPipelineModelConfig, writePipelineModelConfig };
}

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerPaperPipelineHandlers — model config', () => {
  test('getModelConfig returns the read thunk value without any auth gate', async () => {
    const { deps, readPipelineModelConfig } = makeDeps({
      litAuth: false,
      modelConfig: { pipelineModel: 'deepseek/deepseek-v4-flash', pdfUrlSuggestModel: '' },
    });
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.GetModelConfig);
    expect(handler).toBeDefined();

    const result = (await handler?.()) as { success: boolean; data?: PaperPipelineModelConfig };
    expect(readPipelineModelConfig).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      data: { pipelineModel: 'deepseek/deepseek-v4-flash', pdfUrlSuggestModel: '' },
    });
  });

  test('getModelConfig wraps a thunk failure in an error envelope', async () => {
    const { deps } = makeDeps();
    deps.readPipelineModelConfig = vi.fn(() => {
      throw new Error('kv store unavailable');
    });
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.GetModelConfig);
    const result = (await handler?.()) as { success: boolean; error?: string };
    expect(result).toEqual({ success: false, error: 'kv store unavailable' });
  });

  test('setModelConfig forwards a valid payload to the write thunk', async () => {
    const { deps, writePipelineModelConfig } = makeDeps();
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.SetModelConfig);
    expect(handler).toBeDefined();

    const payload = { pipelineModel: 'deepseek/deepseek-v4-flash', pdfUrlSuggestModel: '' };
    const result = (await handler?.(undefined, payload)) as {
      success: boolean;
      data?: PaperPipelineModelConfig;
    };
    expect(writePipelineModelConfig).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      success: true,
      data: { pipelineModel: '', pdfUrlSuggestModel: '' },
    });
  });

  test('setModelConfig accepts payloads with omitted optional fields', async () => {
    const { deps, writePipelineModelConfig } = makeDeps();
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.SetModelConfig);
    const result = (await handler?.(undefined, {})) as { success: boolean };
    expect(writePipelineModelConfig).toHaveBeenCalledWith({});
    expect(result.success).toBe(true);
  });

  test('setModelConfig rejects non-string field values and missing payloads', async () => {
    const { deps, writePipelineModelConfig } = makeDeps();
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.SetModelConfig);
    for (const payload of [
      undefined,
      null,
      'deepseek/deepseek-v4-flash',
      { pipelineModel: 123 },
      { pdfUrlSuggestModel: { ref: 'deepseek/deepseek-v4-flash' } },
    ]) {
      const result = (await handler?.(undefined, payload)) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'setModelConfig requires { pipelineModel, pdfUrlSuggestModel } as strings',
      );
    }
    expect(writePipelineModelConfig).not.toHaveBeenCalled();
  });

  test('setModelConfig wraps a thunk failure in an error envelope', async () => {
    const { deps, writePipelineModelConfig } = makeDeps();
    writePipelineModelConfig.mockImplementation(() => {
      throw new Error('write failed');
    });
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.SetModelConfig);
    const result = (await handler?.(undefined, { pipelineModel: '' })) as {
      success: boolean;
      error?: string;
    };
    expect(result).toEqual({ success: false, error: 'write failed' });
  });
});

describe('registerPaperPipelineHandlers — lit-auth gates unchanged', () => {
  test('listPendingTasks still bails without a lit session', async () => {
    const { deps } = makeDeps({ litAuth: false });
    registerPaperPipelineHandlers(deps);

    const handler = registeredHandlers.get(PaperPipelineIpcChannel.ListPendingTasks);
    const result = (await handler?.()) as { success: boolean; error?: string };
    expect(result).toEqual({ success: false, error: 'Lit session required for paper pipeline' });
  });
});
