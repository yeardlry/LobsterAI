import { EventEmitter } from 'node:events';

import {
  PaperPipelineAdvanceAction,
  PaperPipelineProcessingStatus,
} from '../../shared/paperPipeline/constants';
import type {
  PaperTask,
  PaperTaskAdvanceResult,
  PaperTaskAuthor,
  PaperTaskLogEntry,
  PaperTaskLogEvent,
  PaperTaskReportFailureRequest,
  PaperTaskStatusChangedEvent,
} from '../../shared/paperPipeline/types';
import { generateAnalysis } from './analysisService';
import { pickCategories } from './categoryService';
import { downloadPdf } from './paperDownloadService';
import { uploadFile } from './paperFileUpload';
import { PaperPipelineClient } from './paperPipelineClient';
import {
  buildDefaultPdfUrlFinderDeps,
  findPdfUrl,
  type PdfUrlFinderDeps,
} from './pdfUrlFinder';
import { prepareWechatDraft } from './wechatArticleService';
import {
  cacheXml,
  extractAbstract,
  extractTitle,
  parseAuthors,
  readCachedXml,
} from './xmlParser';

/**
 * Per-task orchestration context. Captures intermediate results so a single
 * `advanceTask` call can chain `getXmlContent → parse → submitParseResult →
 * ... → submitWechatDoc` without re-fetching from the server.
 */
interface AdvanceContext {
  pmid: string;
  xml: string | null;
  authors: PaperTaskAuthor[];
  extSummary: string | null;
  /** Article title mined from the cached XML; reused by the LLM PDF finder. */
  title: string | null;
  /** Abstract text mined from the cached XML; reused by the LLM PDF finder. */
  abstractText: string | null;
  categoryIds: string[];
  tagIds: string[];
  pdfUrl: string | null;
  docUrl: string | null;
}

/**
 * Push-channel owner for the orchestrator. `paperPipelineServiceManager`
 * forwards every `StatusChanged` and `Log` event into the renderer via the
 * `BrowserWindow.getAllWindows().forEach(... webContents.send(...))` pattern.
 */
export interface PaperPipelineEmitter {
  emitStatusChanged(event: PaperTaskStatusChangedEvent): void;
  emitLog(event: PaperTaskLogEvent): void;
}

const STATUS_TO_ACTION: Partial<Record<PaperPipelineProcessingStatus, PaperPipelineAdvanceAction>> = {
  [PaperPipelineProcessingStatus.XmlReady]: PaperPipelineAdvanceAction.ParseXml,
  [PaperPipelineProcessingStatus.Parsed]: PaperPipelineAdvanceAction.Analyze,
  [PaperPipelineProcessingStatus.Analyzed]: PaperPipelineAdvanceAction.Categorize,
  [PaperPipelineProcessingStatus.Categorized]: PaperPipelineAdvanceAction.DownloadAndUploadPdf,
  [PaperPipelineProcessingStatus.PdfReady]: PaperPipelineAdvanceAction.GenerateWechatDoc,
};

/**
 * Drives one task through a single state transition.
 *
 * The orchestrator is intentionally *manual-per-step*: each `advanceTask`
 * call runs exactly one transition so the user (or a future cron) can
 * interrupt between steps. Multi-step auto-advance would belong in a
 * higher-level coordinator.
 *
 * Each transition:
 *   1. runs the local work for the current status (parse / analyze / ...);
 *   2. submits the result via the matching endpoint on
 *      {@link PaperPipelineClient};
 *   3. on success emits a `StatusChanged` event so the renderer refreshes.
 *
 * On any thrown error the orchestrator forwards the failure to the
 * `reportTaskFailure` endpoint, marks the task `failed`, and emits a
 * `StatusChanged` event with the server's reported error.
 */
export class PaperPipelineService {
  private readonly logs = new Map<string, PaperTaskLogEntry[]>();
  /**
   * LLM PDF finder deps. When the caller supplies a concrete
   * `pdfUrlFinderDeps` we store it directly. Otherwise we keep the
   * Cowork-side fields as thunks and resolve them lazily on first use
   * — see {@link getPdfUrlFinderDeps}.
   */
  private readonly pdfUrlFinderDeps:
    | PdfUrlFinderDeps
    | (() => PdfUrlFinderDeps);
  private readonly coworkRuntimeThunk:
    | PdfUrlFinderDeps['coworkRuntime']
    | (() => PdfUrlFinderDeps['coworkRuntime'])
    | undefined;
  private readonly coworkStoreThunk:
    | PdfUrlFinderDeps['coworkStore']
    | (() => PdfUrlFinderDeps['coworkStore'])
    | undefined;
  private readonly resolveAgentCwdThunk:
    | PdfUrlFinderDeps['resolveAgentCwd']
    | (() => PdfUrlFinderDeps['resolveAgentCwd'])
    | undefined;

  constructor(
    private readonly client: PaperPipelineClient,
    private readonly emitter: PaperPipelineEmitter,
    /**
     * Phase 6 + 7 PDF URL finder dependencies. When the deterministic
     * EuropePMC / PMC chains fail, the orchestrator delegates to the LLM
     * via these deps. Defaults to the production factory — tests should
     * pass their own bundle.
     *
     * When the caller supplies a `pdfUrlFinderDeps` we trust it directly.
     * Otherwise we fall back to `buildDefaultPdfUrlFinderDeps()` and
     * forward any optional `coworkRuntime` / `coworkStore` /
     * `resolveAgentCwd` the orchestrator has been told about — that
     * keeps the priority-2 hidden-session branch opt-in for the main
     * process.
     *
     * The Cowork-side fields accept either a value or a thunk. The
     * thunk variant is mandatory for the service-manager wiring in
     * `main.ts`: that block runs at module load BEFORE `initStore()`,
     * and `getCoworkEngineRouter()` / `getCoworkStore()` both call
     * `getStore()` which throws until `initStore()` has run. We resolve
     * the thunks lazily, when the first `DownloadAndUploadPdf` step
     * actually needs the LLM PDF finder, by which time store init has
     * finished.
     */
    deps?: {
      pdfUrlFinderDeps?: PdfUrlFinderDeps;
      coworkRuntime?: PdfUrlFinderDeps['coworkRuntime'] | (() => PdfUrlFinderDeps['coworkRuntime']);
      coworkStore?: PdfUrlFinderDeps['coworkStore'] | (() => PdfUrlFinderDeps['coworkStore']);
      resolveAgentCwd?: PdfUrlFinderDeps['resolveAgentCwd'] | (() => PdfUrlFinderDeps['resolveAgentCwd']);
    },
  ) {
    if (deps?.pdfUrlFinderDeps) {
      this.pdfUrlFinderDeps = deps.pdfUrlFinderDeps;
      this.coworkRuntimeThunk = undefined;
      this.coworkStoreThunk = undefined;
      this.resolveAgentCwdThunk = undefined;
    } else {
      // Store the thunks as-is. Resolution happens in
      // {@link getPdfUrlFinderDeps} on first call, which is after
      // `initStore()` has finished.
      this.pdfUrlFinderDeps = () => this.buildDefaultFinderDeps();
      this.coworkRuntimeThunk = deps?.coworkRuntime;
      this.coworkStoreThunk = deps?.coworkStore;
      this.resolveAgentCwdThunk = deps?.resolveAgentCwd;
    }
  }

  /**
   * Resolve the Cowork-side thunks exactly once, then cache the bundle
   * so we don't keep calling `getCoworkStore()` on every step. Tests
   * that pass a non-thunk `pdfUrlFinderDeps` skip this code path
   * entirely.
   */
  private buildDefaultFinderDeps(): PdfUrlFinderDeps {
    const resolveRuntime = (): PdfUrlFinderDeps['coworkRuntime'] => {
      const v = this.coworkRuntimeThunk;
      if (v === undefined) return undefined;
      return typeof v === 'function' && v.length === 0
        ? (v as () => PdfUrlFinderDeps['coworkRuntime'])()
        : (v as PdfUrlFinderDeps['coworkRuntime']);
    };
    const resolveStore = (): PdfUrlFinderDeps['coworkStore'] => {
      const v = this.coworkStoreThunk;
      if (v === undefined) return undefined;
      return typeof v === 'function' && v.length === 0
        ? (v as () => PdfUrlFinderDeps['coworkStore'])()
        : (v as PdfUrlFinderDeps['coworkStore']);
    };
    const resolveCwd = (): PdfUrlFinderDeps['resolveAgentCwd'] => {
      const v = this.resolveAgentCwdThunk;
      if (v === undefined) return undefined;
      // `resolveAgentCwd(agentId: string)` is itself a function — use
      // arity to distinguish a thunk (`() => string`) from a value
      // (`(agentId: string) => string`).
      return typeof v === 'function' && v.length === 0
        ? (v as () => PdfUrlFinderDeps['resolveAgentCwd'])()
        : (v as PdfUrlFinderDeps['resolveAgentCwd']);
    };
    return buildDefaultPdfUrlFinderDeps({
      coworkRuntime: resolveRuntime(),
      coworkStore: resolveStore(),
      resolveAgentCwd: resolveCwd(),
    });
  }

  /**
   * Return the LLM PDF finder deps, resolving any deferred thunks the
   * first time this is called. Tests that pass a non-thunk `pdfUrlFinderDeps`
   * get the same instance every time; production code goes through the
   * thunk wrapper above and resolves the production singletons on first
   * use, safely after `initStore()`.
   */
  private getPdfUrlFinderDeps(): PdfUrlFinderDeps {
    if (typeof this.pdfUrlFinderDeps === 'function') {
      return this.pdfUrlFinderDeps();
    }
    return this.pdfUrlFinderDeps;
  }

  /** Refresh the pending task list from the backend. */
  async listPendingTasks(signal?: AbortSignal): Promise<PaperTask[]> {
    this.logGlobal('info', 'listPendingTasks requested');
    const tasks = await this.client.listPendingTasks(signal);
    return tasks;
  }

  /** Read the buffered log for a task (most recent last). */
  getTaskLog(pmid: string): PaperTaskLogEntry[] {
    return this.logs.get(pmid)?.slice() ?? [];
  }

  /**
   * Advance one task through one state transition. Returns the transition
   * descriptor (from/to status + action) so the caller can decide whether
   * to chain another call.
   */
  async advanceTask(
    pmid: string,
    currentStatus: PaperPipelineProcessingStatus,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const action = STATUS_TO_ACTION[currentStatus];
    if (!action) {
      throw new PaperPipelineOrchestratorError(
        `Cannot advance task ${pmid} from terminal status ${currentStatus}`,
      );
    }

    const ctx: AdvanceContext = {
      pmid,
      xml: null,
      authors: [],
      extSummary: null,
      title: null,
      abstractText: null,
      categoryIds: [],
      tagIds: [],
      pdfUrl: null,
      docUrl: null,
    };

    this.log(pmid, 'info', `advance: ${currentStatus} → ${action}`);

    try {
      switch (action) {
        case PaperPipelineAdvanceAction.ParseXml: {
          const xml = await this.fetchAndCacheXml(pmid, signal);
          ctx.xml = xml;
          ctx.authors = parseAuthors(xml);
          // Cache the article title + abstract text so the LLM PDF finder
          // (Phase 6) and the WeChat drafter have something to work with
          // even when the cached XML is large.
          ctx.title = extractTitle(xml) || null;
          ctx.abstractText = extractAbstract(xml) || null;
          this.log(pmid, 'info', `parsed ${ctx.authors.length} author(s)`);
          const result = await this.client.submitParseResult(pmid, ctx.authors, signal);
          this.emitAdvance(pmid, currentStatus, result.toStatus, null);
          return result;
        }
        case PaperPipelineAdvanceAction.Analyze: {
          ctx.xml = (await readCachedXml(pmid)) ?? '';
          ctx.authors = parseAuthors(ctx.xml);
          ctx.title = extractTitle(ctx.xml) || null;
          ctx.abstractText = extractAbstract(ctx.xml) || null;
          const extSummary = await generateAnalysis({
            pmid,
            xml: ctx.xml,
            authors: ctx.authors,
          });
          ctx.extSummary = extSummary;
          this.log(pmid, 'info', `generated extSummary (${extSummary.length} chars)`);
          const result = await this.client.submitAnalysis(pmid, extSummary, signal);
          this.emitAdvance(pmid, currentStatus, result.toStatus, null);
          return result;
        }
        case PaperPipelineAdvanceAction.Categorize: {
          ctx.xml = (await readCachedXml(pmid)) ?? '';
          ctx.authors = parseAuthors(ctx.xml);
          // Phase 2: re-use the heuristic analysis from the previous step
          // (kept in ctx.extSummary when the Analyze step ran in this
          // session). If we entered Categorize without ever running Analyze
          // (e.g. the task started at `analyzed` in a previous session),
          // generate one on the fly using the same heuristic so the
          // category picker still has something to work with.
          if (!ctx.extSummary) {
            ctx.extSummary = await generateAnalysis({
              pmid,
              xml: ctx.xml,
              authors: ctx.authors,
            });
          }
          const picked = await pickCategories({
            pmid,
            extSummary: ctx.extSummary,
            authors: ctx.authors,
            clientDeps: this.client.getDeps(),
            xml: ctx.xml ?? undefined,
          });
          ctx.categoryIds = picked.categoryIds;
          ctx.tagIds = picked.tagIds;
          this.log(
            pmid,
            'info',
            `picked ${picked.categoryIds.length} categor(ies) and ${picked.tagIds.length} tag(s)`,
          );
          const result = await this.client.submitCategories(
            pmid,
            picked.categoryIds,
            picked.tagIds,
            signal,
          );
          this.emitAdvance(pmid, currentStatus, result.toStatus, null);
          return result;
        }
        case PaperPipelineAdvanceAction.DownloadAndUploadPdf: {
          const download = await downloadPdf({
            pmid,
            title: ctx.title,
            abstractText: ctx.abstractText,
            findPdfUrl: async (args) => findPdfUrl({
              ...args,
              deps: this.getPdfUrlFinderDeps(),
            }),
          });
          this.log(pmid, 'info', `downloaded ${download.bytes} bytes → ${download.localPath}`);
          const uploaded = await uploadFile({
            pmid,
            fileType: 'pdf',
            localPath: download.localPath,
            bytes: download.bytes,
            clientDeps: this.client.getDeps(),
          });
          ctx.pdfUrl = uploaded.url;
          this.log(pmid, 'info', `uploaded to ${uploaded.url}`);
          const result = await this.client.submitFile(pmid, 'pdf', uploaded.url, signal);
          this.emitAdvance(pmid, currentStatus, result.toStatus, null);
          return result;
        }
        case PaperPipelineAdvanceAction.GenerateWechatDoc: {
          ctx.xml = (await readCachedXml(pmid)) ?? '';
          ctx.authors = parseAuthors(ctx.xml);
          ctx.title = extractTitle(ctx.xml) || null;
          ctx.abstractText = extractAbstract(ctx.xml) || null;
          // Phase 4 — manual paste workflow:
          //   1) Render a publication-ready Markdown to disk + upload to
          //      OSS so the user can copy/paste it into 微信编辑器.
          //   2) `submitWechatDoc` is NOT called here. The renderer shows a
          //      modal with the preview + an input box for the docUrl the
          //      user pastes back from 微信公众平台. Only after the user
          //      confirms does the UI call `paperPipeline:submitWechatDoc`
          //      → service.submitUserProvidedDocUrl(...).
          //
          // This step intentionally keeps the task in `pdf_ready` and just
          // exposes the draft + URL. The status flips to `completed` only
          // when the user-supplied docUrl is submitted successfully.
          // Re-use the cached extSummary when we already produced one
          // (Analyze step ran this session). Otherwise fall back to the
          // heuristic summary so the Markdown isn't blank.
          let extSummary = ctx.extSummary ?? '';
          if (!extSummary) {
            extSummary = await generateAnalysis({
              pmid,
              xml: ctx.xml,
              authors: ctx.authors,
            });
            ctx.extSummary = extSummary;
          }
          const draft = await prepareWechatDraft({
            pmid,
            extSummary,
            authors: ctx.authors,
            categoryIds: ctx.categoryIds,
            tagIds: ctx.tagIds,
            pdfUrl: ctx.pdfUrl,
          });
          ctx.docUrl = draft.markdownUrl;
          this.log(
            pmid,
            'info',
            `wechat draft prepared at ${draft.localMarkdownPath} (public: ${draft.markdownUrl})`,
          );
          // We deliberately do NOT change status here. The status stays
          // `pdf_ready` until the user-supplied docUrl is submitted.
          // Callers that want to chain must call `submitUserProvidedDocUrl`
          // separately once the renderer has the docUrl.
          return {
            pmid,
            fromStatus: currentStatus,
            toStatus: currentStatus,
            draftLocalPath: draft.localMarkdownPath,
            draftUrl: draft.markdownUrl,
            draftTitle: draft.renderedTitle,
            draftSummary: draft.renderedSummary,
          } as unknown as PaperTaskAdvanceResult;
        }
        default: {
          // Exhaustiveness check.
          const exhaustive: never = action;
          throw new PaperPipelineOrchestratorError(
            `Unknown advance action: ${String(exhaustive)}`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.log(pmid, 'error', `advance failed at ${action}: ${message}`);
      // Best-effort failure report. We don't want a failure report failure
      // to mask the original error, so swallow + log.
      try {
        await this.client.reportTaskFailure(
          {
            pmid,
            errorMessage: message,
            markAsFailed: true,
          },
          signal,
        );
      } catch (reportErr) {
        this.log(
          pmid,
          'warn',
          `reportTaskFailure also failed: ${
            reportErr instanceof Error ? reportErr.message : 'unknown'
          }`,
        );
      }
      this.emitAdvance(pmid, currentStatus, PaperPipelineProcessingStatus.Failed, message);
      throw err;
    }
  }

  /**
   * Submit a user-pasted WeChat docUrl. Called by the renderer modal after
   * the user copies the prepared Markdown into 微信编辑器 and pastes the
   * resulting `https://mp.weixin.qq.com/s/...` link back. Flips the task
   * from `pdf_ready` to `completed`.
   */
  async submitUserProvidedDocUrl(
    pmid: string,
    docUrl: string,
    extras: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    this.log(pmid, 'info', `submitting user-provided WeChat docUrl: ${docUrl}`);
    const result = await this.client.submitWechatDoc(pmid, docUrl, extras, signal);
    this.emitAdvance(
      pmid,
      PaperPipelineProcessingStatus.PdfReady,
      result.toStatus,
      null,
    );
    return result;
  }

  /** Manual failure reporting — used by the "Mark failed" UI button. */
  async reportFailure(
    payload: PaperTaskReportFailureRequest,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    this.log(payload.pmid, 'warn', `manual reportFailure: ${payload.errorMessage}`);
    const result = await this.client.reportTaskFailure(payload, signal);
    const toStatus = payload.markAsFailed
      ? PaperPipelineProcessingStatus.Failed
      : payload.resetTo ?? PaperPipelineProcessingStatus.XmlReady;
    this.emitAdvance(payload.pmid, undefined, toStatus, payload.markAsFailed ? null : payload.errorMessage);
    return result;
  }

  private async fetchAndCacheXml(pmid: string, signal?: AbortSignal): Promise<string> {
    const cached = await readCachedXml(pmid);
    if (cached) return cached;
    const xml = await this.client.getXmlContent(pmid, signal);
    await cacheXml(pmid, xml);
    return xml;
  }

  private emitAdvance(
    pmid: string,
    fromStatus: PaperPipelineProcessingStatus | undefined,
    toStatus: PaperPipelineProcessingStatus,
    errorMessage: string | null,
  ): void {
    this.emitter.emitStatusChanged({
      pmid,
      fromStatus,
      toStatus,
      errorMessage: errorMessage ?? null,
    });
  }

  private log(pmid: string, level: PaperTaskLogEntry['level'], message: string): void {
    const entry: PaperTaskLogEntry = {
      pmid,
      at: new Date().toISOString(),
      level,
      message,
    };
    const buffer = this.logs.get(pmid) ?? [];
    buffer.push(entry);
    // Keep at most 200 entries per task in memory.
    if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
    this.logs.set(pmid, buffer);
    this.emitter.emitLog(entry);
  }

  private logGlobal(level: PaperTaskLogEntry['level'], message: string): void {
    this.emitter.emitLog({
      pmid: '',
      at: new Date().toISOString(),
      level,
      message,
    });
  }
}

export class PaperPipelineOrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperPipelineOrchestratorError';
  }
}

/**
 * Adapter wrapping the orchestrator's push channels onto an EventEmitter so
 * `paperPipelineServiceManager` can hook `BrowserWindow.webContents.send`
 * into a single bus.
 */
export class PaperPipelineEmitterBus implements PaperPipelineEmitter {
  private readonly emitter = new EventEmitter();

  emitStatusChanged(event: PaperTaskStatusChangedEvent): void {
    this.emitter.emit('statusChanged', event);
  }

  emitLog(event: PaperTaskLogEvent): void {
    this.emitter.emit('log', event);
  }

  onStatusChanged(listener: (event: PaperTaskStatusChangedEvent) => void): () => void {
    this.emitter.on('statusChanged', listener);
    return () => this.emitter.off('statusChanged', listener);
  }

  onLog(listener: (event: PaperTaskLogEvent) => void): () => void {
    this.emitter.on('log', listener);
    return () => this.emitter.off('log', listener);
  }
}