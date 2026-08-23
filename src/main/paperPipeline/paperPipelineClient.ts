import { net } from 'electron';

import { LitResponseCode } from '../../shared/paperPipeline/constants';
import {
  type LitEnvelope,
  type LitEnvelopeResult,
  PaperPipelineProcessingStatus,
  type PaperTask,
  type PaperTaskAdvanceResult,
  type PaperTaskAuthor,
  type PaperTaskReportFailureRequest,
} from '../../shared/paperPipeline/types';

/**
 * Dependency surface for {@link PaperPipelineClient}.
 *
 * The client is constructed by the service manager and receives the lit
 * backend base URL plus a token getter. We deliberately do **not** route
 * these calls through `fetchWithAuth`: lit's session uses an empty
 * `refreshToken`, and `fetchWithAuth` would attempt an OAuth refresh
 * against `lobsterai-server.youdao.com` which is unreachable from the lit
 * host. See `main.ts:6742-6753` for the matching manual-Bearer pattern.
 */
export interface PaperPipelineClientDeps {
  getBaseUrl: () => string;
  getAccessToken: () => string | null;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  /** When true the request body is sent as-is (e.g. multipart). */
  rawBody?: BodyInit;
  signal?: AbortSignal;
}

/**
 * Thin wrapper around `net.fetch` that:
 *   - prefixes the lit backend base URL,
 *   - attaches `Authorization: Bearer <token>` when a token is available,
 *   - parses the RuoYi `{code, msg?, data?}` envelope.
 *
 * Each method on this class corresponds to one of the seven paper-processing
 * endpoints the backend exposes. The orchestrator (paperPipelineService)
 * calls these in order as a task advances through the state machine.
 */
export class PaperPipelineClient {
  constructor(private readonly deps: PaperPipelineClientDeps) {}

  /**
   * Expose the deps so sibling services (e.g. paperFileUpload) can make
   * authenticated requests against the same backend with the same token.
   */
  getDeps(): PaperPipelineClientDeps {
    return this.deps;
  }

  /**
   * GET /lit/listPendingTasks
   * Returns the list of tasks awaiting processing.
   */
  async listPendingTasks(signal?: AbortSignal): Promise<PaperTask[]> {
    const envelope = await this.request<{ tasks: PaperTask[] }>(
      '/lit/listPendingTasks',
      { method: 'GET' },
      signal,
    );
    return envelope.data?.tasks ?? [];
  }

  /**
   * GET /lit/getXmlContent?pmid=...
   * Returns the raw PubMed XML body for parsing.
   */
  async getXmlContent(pmid: string, signal?: AbortSignal): Promise<string> {
    const envelope = await this.request<{ xml: string }>(
      `/lit/getXmlContent?pmid=${encodeURIComponent(pmid)}`,
      { method: 'GET' },
      signal,
    );
    return envelope.data?.xml ?? '';
  }

  /** POST /lit/submitParseResult — advances task to `parsed`. */
  async submitParseResult(
    pmid: string,
    authors: PaperTaskAuthor[],
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ task: PaperTask }>(
      '/lit/submitParseResult',
      { method: 'POST', body: { pmid, authors } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.XmlReady,
      toStatus: envelope.data?.task?.status ?? PaperPipelineProcessingStatus.Parsed,
      action: 'parseXml',
    };
  }

  /** POST /lit/submitAnalysis — advances task to `analyzed`. */
  async submitAnalysis(
    pmid: string,
    extSummary: string,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ task: PaperTask }>(
      '/lit/submitAnalysis',
      { method: 'POST', body: { pmid, extSummary } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.Parsed,
      toStatus: envelope.data?.task?.status ?? PaperPipelineProcessingStatus.Analyzed,
      action: 'analyze',
    };
  }

  /** POST /lit/submitCategories — advances task to `categorized`. */
  async submitCategories(
    pmid: string,
    categoryIds: string[],
    tagIds: string[],
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ task: PaperTask }>(
      '/lit/submitCategories',
      { method: 'POST', body: { pmid, categoryIds, tagIds } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.Analyzed,
      toStatus: envelope.data?.task?.status ?? PaperPipelineProcessingStatus.Categorized,
      action: 'categorize',
    };
  }

  /** POST /lit/submitFile — advances task to `pdf_ready`. */
  async submitFile(
    pmid: string,
    fileType: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ task: PaperTask }>(
      '/lit/submitFile',
      { method: 'POST', body: { pmid, fileType, url } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.Categorized,
      toStatus: envelope.data?.task?.status ?? PaperPipelineProcessingStatus.PdfReady,
      action: 'downloadAndUploadPdf',
    };
  }

  /** POST /lit/submitWechatDoc — advances task to `completed`. */
  async submitWechatDoc(
    pmid: string,
    docUrl: string,
    extras: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ task: PaperTask }>(
      '/lit/submitWechatDoc',
      { method: 'POST', body: { pmid, docUrl, extras } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.PdfReady,
      toStatus: envelope.data?.task?.status ?? PaperPipelineProcessingStatus.Completed,
      action: 'generateWechatDoc',
    };
  }

  /** POST /lit/reportTaskFailure. */
  async reportTaskFailure(
    payload: PaperTaskReportFailureRequest,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ task: PaperTask }>(
      '/lit/reportTaskFailure',
      { method: 'POST', body: payload },
      signal,
    );
    const targetStatus = envelope.data?.task?.status
      ?? (payload.markAsFailed
        ? PaperPipelineProcessingStatus.Failed
        : payload.resetTo ?? PaperPipelineProcessingStatus.XmlReady);
    return {
      pmid: payload.pmid,
      fromStatus: targetStatus,
      toStatus: targetStatus,
      action: 'parseXml', // not meaningful for failure reports; UI only uses toStatus.
    };
  }

  /**
   * Centralized request helper. Parses the RuoYi envelope and throws on
   * transport errors / non-`200` codes.
   */
  private async request<T>(
    path: string,
    options: RequestOptions,
    signal?: AbortSignal,
  ): Promise<LitEnvelopeResult<T>> {
    const url = `${this.deps.getBaseUrl()}${path}`;
    const token = this.deps.getAccessToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      redirect: 'follow',
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    } else if (options.rawBody !== undefined) {
      init.body = options.rawBody;
    }
    if (signal) init.signal = signal;

    let response: Response;
    try {
      response = await net.fetch(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'network error';
      throw new PaperPipelineClientError(`Network request to ${path} failed: ${message}`, { cause: err });
    }

    if (response.status === 401) {
      throw new PaperPipelineClientError(`Lit backend rejected token (401) at ${path}`, {
        statusCode: 401,
      });
    }
    if (!response.ok) {
      throw new PaperPipelineClientError(
        `Lit backend returned HTTP ${response.status} at ${path}`,
        { statusCode: response.status },
      );
    }

    let envelope: LitEnvelope<T>;
    try {
      envelope = (await response.json()) as LitEnvelope<T>;
    } catch (err) {
      throw new PaperPipelineClientError(`Failed to parse JSON response from ${path}`, { cause: err });
    }

    if (envelope.code !== LitResponseCode.Success) {
      const message = envelope.msg ?? envelope.message ?? `Lit error code ${envelope.code}`;
      throw new PaperPipelineClientError(message, { statusCode: response.status });
    }
    return { ok: true, data: envelope.data };
  }
}

export class PaperPipelineClientError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, options: { cause?: unknown; statusCode?: number } = {}) {
    super(message);
    this.name = 'PaperPipelineClientError';
    this.statusCode = options.statusCode;
    if (options.cause !== undefined) {
      // Use standard ES2022 cause attachment (Electron/Node ≥ 24 supports it).
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}