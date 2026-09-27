import { DEFAULT_PDF_URL_SUGGEST_MODEL } from '../../shared/paperPipeline/constants';
import type { PaperPipelineModelConfig } from '../../shared/paperPipeline/types';
import type { SqliteStore } from '../sqliteStore';

/**
 * Paper-pipeline model configuration — persistence + resolution.
 *
 * Storage: one JSON blob in the kv table under
 * {@link PAPER_PIPELINE_CONFIG_KV_KEY} (no schema migration, no new table).
 * Written by the `SetModelConfig` IPC handler, read lazily once per advance
 * run (same cadence as the expert-agent resolution), so there is no cache
 * and therefore no invalidation wiring.
 *
 * All access goes through thunks injected in `main.ts` — `getStore()` is
 * private to main.ts and must not be called before `initStore()` has run.
 */

export const PAPER_PIPELINE_CONFIG_KV_KEY = 'paper_pipeline_config';

export const DEFAULT_PAPER_PIPELINE_MODEL_CONFIG: PaperPipelineModelConfig = {
  pipelineModel: '',
  pdfUrlSuggestModel: '',
};

/** Max length of a persisted model ref — guards against garbage blobs. */
const MODEL_REF_MAX_LENGTH = 200;

/**
 * Model id swapped in when the driving agent's binding is a DeepSeek-family
 * reasoner and the user has not configured an explicit pipeline model.
 * Mirrors `DEEPSEEK_REASONING_MODEL_IDS` in openclawConfigSync.ts.
 */
const DEEPSEEK_REASONER_MODEL_IDS = new Set(['deepseek-reasoner', 'deepseek-r1']);
const DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek-v4-flash';

const sanitizeModelRef = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MODEL_REF_MAX_LENGTH) return '';
  // Provider-qualified refs only (`provider/model`); anything else falls
  // back to the default so a malformed value never reaches the gateway.
  return trimmed.includes('/') ? trimmed : '';
};

/**
 * Coerce an unknown kv/IPC payload into a valid config. Unknown shapes and
 * per-field garbage degrade to defaults, never throw.
 */
export function sanitizePaperPipelineModelConfig(
  raw: unknown,
): PaperPipelineModelConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PAPER_PIPELINE_MODEL_CONFIG };
  }
  const record = raw as Record<string, unknown>;
  return {
    pipelineModel: sanitizeModelRef(record.pipelineModel),
    pdfUrlSuggestModel: sanitizeModelRef(record.pdfUrlSuggestModel),
  };
}

/** Read the config from the kv store; missing/corrupt rows yield defaults. */
export function readPaperPipelineModelConfig(
  store: Pick<SqliteStore, 'get'>,
): PaperPipelineModelConfig {
  return sanitizePaperPipelineModelConfig(
    store.get<unknown>(PAPER_PIPELINE_CONFIG_KV_KEY),
  );
}

/** Sanitize, persist, and return the config. */
export function writePaperPipelineModelConfig(
  store: Pick<SqliteStore, 'get' | 'set'>,
  raw: unknown,
): PaperPipelineModelConfig {
  const config = sanitizePaperPipelineModelConfig(raw);
  store.set(PAPER_PIPELINE_CONFIG_KV_KEY, config);
  return config;
}

/**
 * Resolve the model override for the pipeline's hidden sessions.
 *
 * - Explicit user config always wins and is returned verbatim.
 * - Otherwise (smart follow): a DeepSeek-family reasoner binding
 *   (`deepseek/deepseek-reasoner`, `deepseek/deepseek-r1`) is swapped for
 *   `deepseek-v4-flash` within the SAME provider — DeepSeek's reasoner is
 *   far slower than the pipeline needs for batch advances.
 * - Every other provider (GLM / OpenAI / Claude / Kimi / ...) is returned
 *   as `''` (no override): never cross-provider-force a DeepSeek model on a
 *   user whose setup has no DeepSeek.
 */
export function resolvePipelineModelOverride(
  agentModel: string,
  config: PaperPipelineModelConfig,
): string {
  if (config.pipelineModel) return config.pipelineModel;

  const trimmed = agentModel.trim();
  if (!trimmed) return '';
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return '';
  const providerId = trimmed.slice(0, separatorIndex).toLowerCase();
  const modelId = trimmed.slice(separatorIndex + 1).toLowerCase();
  if (providerId !== 'deepseek') return '';
  if (!DEEPSEEK_REASONER_MODEL_IDS.has(modelId)) return '';
  return `deepseek/${DEEPSEEK_V4_FLASH_MODEL_ID}`;
}

/** Resolve the effective token-proxy model ref for `findPdfUrl`. */
export function resolvePdfUrlSuggestModel(
  config: PaperPipelineModelConfig,
): string {
  return config.pdfUrlSuggestModel || DEFAULT_PDF_URL_SUGGEST_MODEL;
}
