import { net } from 'electron';

import { LitAuthHeader, LitResponseCode } from '../../shared/paperPipeline/constants';
import {
  type LitEnvelope,
  type LitEnvelopeResult,
  PaperPipelineProcessingStatus,
  type PaperTask,
  type PaperTaskAdvanceResult,
  type PaperTaskAuthor,
  type PaperTaskPage,
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
 *
 * `isLitAuthSession` is the canonical gate: every {@link request} call
 * refuses to fire when the user is signed in via the OAuth portal instead
 * of the lit backend, so an OAuth access token can never leak into a
 * `/lit/*` request. IPC handlers also check this flag for defense-in-
 * depth, but the gate here is the single source of truth.
 */
export interface PaperPipelineClientDeps {
  getBaseUrl: () => string;
  getAccessToken: () => string | null;
  isLitAuthSession: () => boolean;
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
   * Returns a paginated slice of tasks awaiting processing.
   *
   * The backend's RuoYi-paginated response uses `items` (not `tasks`):
   * `{ code, msg, data: { items: PaperTask[], total: number, page, pageSize } }`.
   * Reading the wrong field silently returned `[]`, which is what produced
   * the "0 task(s)" symptom even though the backend had 2256 pending rows.
   *
   * Pagination contract (MRnaLnpLiterature MCP接口权威契约 §5.1):
   *   - `page` defaults to 1 on the backend; clamped to ≥ 1 client-side.
   *   - `pageSize` defaults to 20; backend caps at 50.
   *   - Sort is `ORDER BY created_at ASC` (insertion order).
   *
   * `fetched` tasks are included by default — the orchestrator handles
   * them by reusing the `xml_ready` path (call `getXmlContent` then
   * `submitParseResult`). The backend accepts `fetched → parsed` once
   * OSS holds the XML (assertTransition back-fills `xml_ready` first),
   * so the client advances `fetched` rows exactly like `xml_ready` ones.
   */
  async listPendingTasks(
    options: { page?: number; pageSize?: number } = {},
    signal?: AbortSignal,
  ): Promise<PaperTaskPage> {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(50, Math.floor(options.pageSize ?? 20)));
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const envelope = await this.request<{
      items: PaperTask[];
      total: number;
      page: number;
      pageSize: number;
    }>(`/lit/listPendingTasks?${query.toString()}`, { method: 'GET' }, signal);
    // The backend always echoes back page / pageSize; if it ever returns
    // a missing total the page is still usable (the renderer falls back to
    // "items.length" for the empty-state detection).
    return {
      items: envelope.data?.items ?? [],
      total: envelope.data?.total ?? envelope.data?.items?.length ?? 0,
      page: envelope.data?.page ?? page,
      pageSize: envelope.data?.pageSize ?? pageSize,
    };
  }

  /**
   * GET /lit/getXmlContent?pmid=...
   *
   * Per contract §5.2 the response carries `{pmid, source, size, xmlContent}`.
   * `source` is `"oss"` when read from OSS, `"db"` when from the
   * `pubmed_xml_data` fallback. We only surface the raw XML string to
   * callers (the parser); the other fields are metadata.
   */
  async getXmlContent(pmid: string, signal?: AbortSignal): Promise<string> {
    const envelope = await this.request<{ pmid: string; source: 'oss' | 'db'; size: number; xmlContent: string }>(
      `/lit/getXmlContent?pmid=${encodeURIComponent(pmid)}`,
      { method: 'GET' },
      signal,
    );
    return envelope.data?.xmlContent ?? '';
  }

  /** POST /lit/submitParseResult — advances task to `parsed`.
   *
   * Per contract §5.3 `authors` is a **JSON string**, not an array — the
   * backend double-parses it through Jackson. Response is a flat
   * `{pmid, processingStatus}`, not a wrapped task object.
   */
  async submitParseResult(
    pmid: string,
    authors: PaperTaskAuthor[],
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ pmid: string; processingStatus: PaperPipelineProcessingStatus }>(
      '/lit/submitParseResult',
      { method: 'POST', body: { pmid, authors: JSON.stringify(authors) } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.XmlReady,
      toStatus: envelope.data?.processingStatus ?? PaperPipelineProcessingStatus.Parsed,
      action: 'parseXml',
    };
  }

  /** POST /lit/submitAnalysis — advances task to `analyzed`. */
  async submitAnalysis(
    pmid: string,
    extSummary: string,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ pmid: string; processingStatus: PaperPipelineProcessingStatus }>(
      '/lit/submitAnalysis',
      { method: 'POST', body: { pmid, extSummary } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.Parsed,
      toStatus: envelope.data?.processingStatus ?? PaperPipelineProcessingStatus.Analyzed,
      action: 'analyze',
    };
  }

  /** POST /lit/submitCategories — advances task to `categorized`.
   *
   * Per contract §5.5 `categoryIds` and `tagIds` are **comma-separated
   * strings**, not arrays. Empty arrays serialise to `""`, which the
   * backend treats as "no IDs supplied — advance state only".
   */
  async submitCategories(
    pmid: string,
    categoryIds: string[],
    tagIds: string[],
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ pmid: string; processingStatus: PaperPipelineProcessingStatus }>(
      '/lit/submitCategories',
      {
        method: 'POST',
        body: {
          pmid,
          categoryIds: categoryIds.join(','),
          tagIds: tagIds.join(','),
        },
      },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.Analyzed,
      toStatus: envelope.data?.processingStatus ?? PaperPipelineProcessingStatus.Categorized,
      action: 'categorize',
    };
  }

  /** POST /lit/submitFile — advances task to `pdf_ready` for fileType=pdf/html.
   *
   * Backend contract change 2026-09-19: closed-access papers have no OA
   * PDF, so `fileType=html` (the archived landing page, OSS key
   * `html/{pmid}.html`, stored in the backend's `file_url` column) now
   * advances `categorized → pdf_ready` exactly like a PDF, letting the
   * WeChat draft chain proceed. `fileType=word` / `md` / `xml` remain pure
   * column writes that leave the state machine untouched.
   */
  async submitFile(
    pmid: string,
    fileType: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ pmid: string; processingStatus: PaperPipelineProcessingStatus; fileType: string; url: string }>(
      '/lit/submitFile',
      { method: 'POST', body: { pmid, fileType, url } },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.Categorized,
      toStatus: envelope.data?.processingStatus ?? PaperPipelineProcessingStatus.PdfReady,
      action: 'downloadAndUploadPdf',
    };
  }

  /** POST /lit/submitWechatDoc — advances task to `completed`.
   *
   * Per contract §5.7 `extras` is a **JSON string**, not a map — the
   * backend double-parses it through Jackson. When the caller passes
   * `undefined` we omit the field; passing `null` is the legacy
   * "no extras" marker.
   */
  async submitWechatDoc(
    pmid: string,
    docUrl: string,
    extras: Record<string, unknown> | null | undefined,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const body: Record<string, unknown> = { pmid, docUrl };
    if (extras !== undefined && extras !== null) {
      body.extras = JSON.stringify(extras);
    }
    const envelope = await this.request<{ pmid: string; processingStatus: PaperPipelineProcessingStatus; docUrl: string; extras?: Record<string, unknown> }>(
      '/lit/submitWechatDoc',
      { method: 'POST', body },
      signal,
    );
    return {
      pmid,
      fromStatus: PaperPipelineProcessingStatus.PdfReady,
      toStatus: envelope.data?.processingStatus ?? PaperPipelineProcessingStatus.Completed,
      action: 'generateWechatDoc',
    };
  }

  /** POST /lit/reportTaskFailure.
   *
   * Per contract §5.8: field name is `errorMsg` (not `errorMessage`),
   * and the response is a flat `{pmid, processingStatus, errorMsg}`.
   */
  async reportTaskFailure(
    payload: PaperTaskReportFailureRequest,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const envelope = await this.request<{ pmid: string; processingStatus: PaperPipelineProcessingStatus; errorMsg?: string }>(
      '/lit/reportTaskFailure',
      { method: 'POST', body: payload },
      signal,
    );
    const targetStatus = envelope.data?.processingStatus
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
    // Single source of truth for the lit-vs-OAuth gate: an OAuth access
    // token would not validate against the lit backend's signing key, so
    // refuse to send any request at all when the lit session is inactive.
    // Surface a 401-shaped error so callers (and the orchestrator's
    // `reportTaskFailure` path) can react as if the backend rejected it.
    if (!this.deps.isLitAuthSession()) {
      throw new PaperPipelineClientError('Lit session required for paper pipeline', {
        statusCode: 401,
      });
    }

    const url = `${this.deps.getBaseUrl()}${path}`;
    const token = this.deps.getAccessToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // Hint the lit backend's filter to skip the dual-service dispatch
      // and route directly to LitTokenService. Harmless if the backend
      // ignores it; required once the backend implements direct routing.
      [LitAuthHeader.Name]: LitAuthHeader.Value,
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