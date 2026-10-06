import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';

import {
  isLitStateTransitionConflict,
  isLitXmlUnavailableError,
  LitArchiveFileType,
  PaperPipelineAdvanceAction,
  PaperPipelineProcessingStatus,
} from '../../shared/paperPipeline/constants';
import type {
  PaperPipelineModelConfig,
  PaperTaskAdvanceResult,
  PaperTaskAuthor,
  PaperTaskLogEntry,
  PaperTaskLogEvent,
  PaperTaskPage,
  PaperTaskReportFailureRequest,
  PaperTaskStatusChangedEvent,
} from '../../shared/paperPipeline/types';
import type { CoworkStore } from '../coworkStore';
import { generateAnalysis } from './analysisService';
import { pickCategories } from './categoryService';
import {
  convertFulltextToMarkdown,
  getExistingFulltextMdPath,
} from './fulltextMdService';
import {
  downloadPdf,
  ensureClosedAccessLandingPage,
  PaperPdfDownloadError,
} from './paperDownloadService';
import { uploadFile } from './paperFileUpload';
import { PaperPipelineClient } from './paperPipelineClient';
import {
  resolvePdfUrlSuggestModel,
  resolvePipelineModelOverride,
} from './paperPipelineConfig';
import {
  buildDefaultPdfUrlFinderDeps,
  downloadPdfViaHiddenCoworkSession,
  findPdfUrl,
  type PdfUrlFinderDeps,
} from './pdfUrlFinder';
import {
  getPaperPipelineHtmlPath,
  getPaperPipelinePdfPath,
  getPaperPipelineXmlPath,
} from './storage';
import { findPipelineExpertAgentId, stopTaskHiddenSession } from './taskHiddenSession';
import { prepareWechatDraft } from './wechatArticleService';
import {
  cacheXml,
  extractAbstract,
  extractDoi,
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
  doi: string | null;
  categoryIds: string[];
  tagIds: string[];
  /**
   * OSS key of the primary full-text artifact: `pdf/{pmid}.pdf` after a
   * normal download, or `html/{pmid}.html` when the paper is closed
   * access and the landing page took the PDF's place. Historical name —
   * downstream (the wechat draft fallback template) renders it as a
   * "view full text" link either way.
   */
  pdfUrl: string | null;
  docUrl: string | null;
  /**
   * Local `fulltext/{pmid}.md` converted from the downloaded PDF / HTML
   * landing page by the auto-advance pre-fetch. Fed into the analysis LLM
   * prompt so 【关键发现】 cites body-level data instead of the abstract.
   */
  fulltextMdPath: string | null;
  fulltextSourceKind: 'pdf' | 'html' | null;
  /**
   * Landing page saved when the pre-fetch established the paper is closed
   * access. The DownloadAndUploadPdf step uses it to skip a doomed
   * download retry and go straight to the HTML fallback upload.
   */
  prefetchedHtmlPath: string | null;
  /**
   * Backend verdict from `listPendingTasks` (`openAccess`, contract v1.3):
   * false = closed access, skip the PDF strategy chain. Null = unknown
   * (backend predates the field) — behave as before.
   */
  openAccess: boolean | null;
  /**
   * The auto-advance pre-pick (user-required work order 2026-09-19) already
   * ran the category/tag selection. True means the Categorize step may
   * submit `ctx.categoryIds` / `ctx.tagIds` without another pick turn.
   */
  categorizePicked: boolean;
  /** This run already attempted the full-text acquisition (download/convert). */
  fulltextAcquired: boolean;
  /**
   * Effective hidden-session agent id for this run. Resolved once at
   * `runAutoAdvance` entry (explicit override → auto-detected
   * "生物研究" expert → `main`) and threaded through every LLM-driven
   * step — categorize, analysis, PDF download, full-text conversion,
   * WeChat draft + word export.
   */
  pipelineAgentId: string;
  /**
   * Effective session-level model override for this run's hidden
   * sessions (provider-qualified ref, `''` = no override — the agent's
   * own binding wins). Resolved once per run from
   * `PaperPipelineModelConfig.pipelineModel`, including the
   * DeepSeek-reasoner → v4-flash smart-follow substitution.
   */
  pipelineModelOverride: string;
  /**
   * Effective model ref for the token-proxy PDF-URL suggestion
   * (`PaperPipelineModelConfig.pdfUrlSuggestModel`, default resolved).
   */
  pdfUrlSuggestModel: string;
}

/** Optional hints an auto-advance caller can pass from the task list. */
export interface PaperAutoAdvanceOptions {
  /**
   * Contract v1.3 `openAccess` flag. False short-circuits the PDF download
   * chain straight to the HTML landing page; null/undefined/true keep the
   * normal chain.
   */
  openAccess?: boolean | null;
  /** Full PDF URL from listPendingTasks, used to restore a missing local cache. */
  pdfUrl?: string | null;
  /**
   * Explicit hidden-session agent id override. When omitted (the common
   * case — one-click advance from the renderer, autopilot batch) the
   * orchestrator auto-detects an installed expert ("生物研究" /
   * "Biological Research") via
   * {@link findPipelineExpertAgentId}; when none is installed it falls
   * back to `main`, the pre-existing behaviour. Pass `null` to force the
   * `main` fallback even when an expert is installed.
   *
   * Wired through every LLM-driven step so the expert's skills + system
   * prompt drive the whole chain end to end.
   */
  agentId?: string | null;
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
  // `fetched` reuses the ParseXml action. `fetched` rows only come from
  // historical imports (fresh PubMed pulls INSERT at `xml_ready`), and
  // the backend's assertTransition accepts `fetched → parsed` once OSS
  // holds the XML (it back-fills `xml_ready` first), so the next
  // actionable step is the same as for `xml_ready`: fetch XML + parse
  // authors + submitParseResult.
  [PaperPipelineProcessingStatus.Fetched]: PaperPipelineAdvanceAction.ParseXml,
  [PaperPipelineProcessingStatus.XmlReady]: PaperPipelineAdvanceAction.ParseXml,
  [PaperPipelineProcessingStatus.Parsed]: PaperPipelineAdvanceAction.Analyze,
  [PaperPipelineProcessingStatus.Analyzed]: PaperPipelineAdvanceAction.Categorize,
  [PaperPipelineProcessingStatus.Categorized]: PaperPipelineAdvanceAction.DownloadAndUploadPdf,
  [PaperPipelineProcessingStatus.PdfReady]: PaperPipelineAdvanceAction.GenerateWechatDoc,
};

/**
 * Default agent id used when no installed expert matches and the caller
 * did not pass an explicit override. The pre-existing behaviour: every
 * hidden session in the paper pipeline has always been driven by the
 * global `main` agent.
 */
export const DEFAULT_PIPELINE_AGENT_ID = 'main';

/**
 * Resolve the LLM driver id for a one-click advance run.
 *
 *   1. Explicit override (`options.agentId`): when provided as a string,
 *      it wins outright. When explicitly `null`, force the default
 *      `main` (skip auto-detect).
 *   2. Auto-detect: {@link findPipelineExpertAgentId} looks up an
 *      installed "生物研究" / "Biological Research" agent in the cowork
 *      store.
 *   3. Fallback: {@link DEFAULT_PIPELINE_AGENT_ID}.
 *
 * Exported for direct unit tests; production callers go through
 * `runAutoAdvance`.
 */
export function resolvePipelineAgentId(
  store: CoworkStore | null | undefined,
  explicitAgentId?: string | null,
): string {
  if (explicitAgentId !== undefined) {
    return explicitAgentId ?? DEFAULT_PIPELINE_AGENT_ID;
  }
  return findPipelineExpertAgentId(store) ?? DEFAULT_PIPELINE_AGENT_ID;
}

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
 * On a thrown processing error the orchestrator forwards the failure to the
 * `reportTaskFailure` endpoint, marks the task `failed`, and emits a
 * `StatusChanged` event with the server's reported error. Two non-processing
 * rejections are re-thrown without reporting: state-transition conflicts
 * (client/server status desync, `isLitStateTransitionConflict` — renderer
 * re-syncs from the pending list) and retryable XML-unavailable rejections
 * (`isLitXmlUnavailableError` — retry later, nothing to re-sync).
 */
export class PaperPipelineService {
  private readonly logs = new Map<string, PaperTaskLogEntry[]>();
  /** PMIDs with an `advanceTaskAuto` run in flight (manual or autopilot). */
  private readonly activeAutoRuns = new Set<string>();
  /** Abort controllers for user-visible one-click runs, keyed by PMID. */
  private readonly autoRunControllers = new Map<string, AbortController>();
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
  private readonly pipelineModelConfigThunk:
    | (() => PaperPipelineModelConfig)
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
      /**
       * Reads the user's pipeline model config (kv store) — injected as a
       * thunk so the main.ts wiring never touches `getStore()` before
       * `initStore()` has run. Omitted in tests: the default config (smart
       * follow) applies.
       */
      getPipelineModelConfig?: () => PaperPipelineModelConfig;
    },
  ) {
    this.pipelineModelConfigThunk = deps?.getPipelineModelConfig;
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

  /**
   * Resolve the lazily-deferred Cowork store singleton used for the
   * expert-agent auto-detect (and other store-backed paths). Mirrors the
   * thunk-arity trick in {@link buildDefaultFinderDeps}: tests that pass
   * a non-thunk `pdfUrlFinderDeps` (where `coworkStoreThunk` is `undefined`)
   * get `null`, so the auto-detect falls through to the `main` agent —
   * the pre-existing behaviour those tests rely on.
   */
  private resolveCoworkStore(): CoworkStore | null {
    const v = this.coworkStoreThunk;
    if (v === undefined) return null;
    return typeof v === 'function' && v.length === 0
      ? ((v as () => CoworkStore)() ?? null)
      : ((v as CoworkStore) ?? null);
  }

  /**
   * Read the user's pipeline model config. Omitted thunk (tests) or a
   * throwing read both degrade to the default config — model selection
   * must never break an advance run.
   */
  private resolveModelConfig(): PaperPipelineModelConfig {
    try {
      return this.pipelineModelConfigThunk?.() ?? { pipelineModel: '', pdfUrlSuggestModel: '' };
    } catch (err) {
      console.warn('[PaperPipeline] model config read failed, using defaults:', err);
      return { pipelineModel: '', pdfUrlSuggestModel: '' };
    }
  }

  /**
   * Resolve the model override for a run given the driving agent id: the
   * config's explicit `pipelineModel` wins; otherwise smart-follow the
   * agent's binding with the DeepSeek-reasoner → v4-flash substitution.
   */
  private resolveRunModelOverride(
    config: PaperPipelineModelConfig,
    pipelineAgentId: string,
  ): string {
    let agentModel = '';
    try {
      agentModel = this.resolveCoworkStore()?.getAgent(pipelineAgentId)?.model ?? '';
    } catch (err) {
      // A transient store read failure must never break an advance run —
      // the model override degrades to unset (the agent binding wins).
      console.warn('[PaperPipeline] agent model read failed, skipping model override:', err);
      return '';
    }
    return resolvePipelineModelOverride(agentModel, config);
  }

  /** Refresh one page of pending tasks from the backend. */
  async listPendingTasks(
    options: { page?: number; pageSize?: number } = {},
    signal?: AbortSignal,
  ): Promise<PaperTaskPage> {
    this.logGlobal(
      'info',
      `listPendingTasks requested (page=${options.page ?? 1}, pageSize=${options.pageSize ?? 20})`,
    );
    return await this.client.listPendingTasks(options, signal);
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
    /**
     * Shared per-task context. `advanceTaskAuto` passes ONE context through
     * every step so later steps reuse the earlier steps' work — the
     * Analyze summary feeds Categorize, and the title / abstract mined at
     * ParseXml feed the PDF download prompt. Single-step callers omit it
     * and get a fresh context (each branch re-populates what it needs).
     */
    sharedCtx?: AdvanceContext,
  ): Promise<PaperTaskAdvanceResult> {
    const action = STATUS_TO_ACTION[currentStatus];
    if (!action) {
      throw new PaperPipelineOrchestratorError(
        `Cannot advance task ${pmid} from terminal status ${currentStatus}`,
      );
    }

    const modelConfig = this.resolveModelConfig();
    const ctx: AdvanceContext = sharedCtx ?? {
      pmid,
      xml: null,
      authors: [],
      extSummary: null,
      title: null,
      abstractText: null,
      doi: null,
      categoryIds: [],
      tagIds: [],
      pdfUrl: null,
      docUrl: null,
      fulltextMdPath: null,
      fulltextSourceKind: null,
      prefetchedHtmlPath: null,
      openAccess: null,
      categorizePicked: false,
      fulltextAcquired: false,
      // Single-step callers never opt into the auto-detected expert
      // — they always drive the global `main` agent, matching the
      // pre-existing per-step behaviour. The auto-detect happens once
      // at `runAutoAdvance` entry. The MODEL config still applies: it is
      // a user-visible global setting, and silently using a different
      // model for the single-step button than for one-click advance
      // would be surprising.
      pipelineAgentId: 'main',
      pipelineModelOverride: this.resolveRunModelOverride(modelConfig, 'main'),
      pdfUrlSuggestModel: resolvePdfUrlSuggestModel(modelConfig),
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
          ctx.doi = extractDoi(xml) || null;
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
          ctx.doi = extractDoi(ctx.xml) || null;
          // LLM-first: the pooled hidden session reads the full-text
          // Markdown (when the auto-advance pre-fetch or an earlier run
          // produced one) and the cached XML, then writes a structured
          // summary; the heuristic template is the fallback (see
          // analysisService.ts).
          const extSummary = await generateAnalysis({
            pmid,
            xml: ctx.xml,
            authors: ctx.authors,
            xmlPath: getPaperPipelineXmlPath(pmid),
            fulltextMdPath: (await this.resolveFulltextMdPath(ctx)) ?? undefined,
            fulltextSourceKind: ctx.fulltextSourceKind,
            deps: this.getPdfUrlFinderDeps(),
            agentId: ctx.pipelineAgentId,
            modelOverride: ctx.pipelineModelOverride || undefined,
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
          if (!ctx.categorizePicked) {
            // No pre-pick (manual single-step click, or the auto-advance
            // pre-pick failed): run the original path — re-use the analysis
            // from the previous step, generating one on the fly when we
            // entered Categorize without ever running Analyze, then pick.
            if (!ctx.extSummary) {
              ctx.extSummary = await generateAnalysis({
                pmid,
                xml: ctx.xml,
                authors: ctx.authors,
                xmlPath: getPaperPipelineXmlPath(pmid),
                fulltextMdPath: (await this.resolveFulltextMdPath(ctx)) ?? undefined,
                fulltextSourceKind: ctx.fulltextSourceKind,
                deps: this.getPdfUrlFinderDeps(),
                modelOverride: ctx.pipelineModelOverride || undefined,
              });
            }
            // LLM-first: the pooled hidden session picks semantically with
            // every id validated against the catalogue whitelist; keyword
            // overlap is the fallback (see categoryService.ts).
            const picked = await pickCategories({
              pmid,
              extSummary: ctx.extSummary,
              authors: ctx.authors,
              clientDeps: this.client.getDeps(),
              xml: ctx.xml ?? undefined,
              xmlPath: getPaperPipelineXmlPath(pmid),
              deps: this.getPdfUrlFinderDeps(),
              agentId: ctx.pipelineAgentId,
              modelOverride: ctx.pipelineModelOverride || undefined,
            });
            ctx.categoryIds = picked.categoryIds;
            ctx.tagIds = picked.tagIds;
          }
          // categorizePicked === true: the auto-advance pre-pick already
          // filled ctx.categoryIds / ctx.tagIds — submit them directly.
          this.log(
            pmid,
            'info',
            `submitting ${ctx.categoryIds.length} categor(ies) and ${ctx.tagIds.length} tag(s)`,
          );
          const result = await this.client.submitCategories(
            pmid,
            ctx.categoryIds,
            ctx.tagIds,
            signal,
          );
          this.emitAdvance(pmid, currentStatus, result.toStatus, null);
          return result;
        }
        case PaperPipelineAdvanceAction.DownloadAndUploadPdf: {
          // Closed-access short-circuit: the auto-advance pre-fetch saved
          // the landing page, or the backend already flagged the paper
          // closed access (`openAccess === false`, contract v1.3). Either
          // way the PDF strategy chain is doomed — skip it and archive the
          // page right away.
          if (!ctx.prefetchedHtmlPath && ctx.openAccess === false) {
            ctx.prefetchedHtmlPath = await ensureClosedAccessLandingPage(pmid);
          }
          if (ctx.prefetchedHtmlPath) {
            const result = await this.uploadClosedAccessHtmlFallback(
              pmid,
              ctx.prefetchedHtmlPath,
              ctx,
              signal,
            );
            this.emitAdvance(pmid, currentStatus, result.toStatus, null);
            return result;
          }
          let download;
          try {
            download = await downloadPdf(this.buildDownloadPdfInput(pmid, ctx));
          } catch (err) {
            // Closed-access continuation: no OA PDF exists, but the download
            // service saved the public landing page to html/{pmid}.html.
            // Upload it and submit as the full-text artifact — the backend
            // (contract change 2026-09-19) advances html to pdf_ready just
            // like a PDF, so the MD draft / word export chain continues.
            // Returning normally skips the outer reportTaskFailure.
            const htmlPath = await this.resolveClosedAccessHtmlPath(pmid, err);
            if (!htmlPath) throw err;
            this.log(
              pmid,
              'warn',
              `no OA PDF — using closed-access HTML fallback ${htmlPath}`,
            );
            const result = await this.uploadClosedAccessHtmlFallback(
              pmid,
              htmlPath,
              ctx,
              signal,
            );
            this.emitAdvance(pmid, currentStatus, result.toStatus, null);
            return result;
          }
          this.log(pmid, 'info', `downloaded ${download.bytes} bytes → ${download.localPath}`);
          const uploaded = await uploadFile({
            pmid,
            fileType: LitArchiveFileType.Pdf,
            localPath: download.localPath,
            bytes: download.bytes,
            clientDeps: this.client.getDeps(),
          });
          ctx.pdfUrl = uploaded.url;
          this.log(pmid, 'info', `uploaded to ${uploaded.url}`);
          const result = await this.client.submitFile(pmid, LitArchiveFileType.Pdf, uploaded.url, signal);
          this.emitAdvance(pmid, currentStatus, result.toStatus, null);
          return result;
        }
        case PaperPipelineAdvanceAction.GenerateWechatDoc: {
          ctx.xml = (await readCachedXml(pmid)) ?? '';
          ctx.authors = parseAuthors(ctx.xml);
          ctx.title = extractTitle(ctx.xml) || null;
          ctx.abstractText = extractAbstract(ctx.xml) || null;
          ctx.doi = extractDoi(ctx.xml) || null;
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
              xmlPath: getPaperPipelineXmlPath(pmid),
              fulltextMdPath: (await this.resolveFulltextMdPath(ctx)) ?? undefined,
              fulltextSourceKind: ctx.fulltextSourceKind,
              deps: this.getPdfUrlFinderDeps(),
              agentId: ctx.pipelineAgentId,
              modelOverride: ctx.pipelineModelOverride || undefined,
            });
            ctx.extSummary = extSummary;
          }
          // `pdf_ready` is a backend state, while the local PDF cache may
          // have been removed after an app restart or an older run. A draft
          // regeneration must reacquire a local PDF/HTML before starting
          // the Markdown Agent; otherwise prepareWechatDraft falls back to
          // the short template and only the subsequent Word Agent is visible.
          if (!(await this.hasFulltextSource(pmid))) {
            this.log(
              pmid,
              'info',
              'wechat regeneration has no local PDF/HTML; reacquiring full-text source',
            );
            await this.acquireFulltext(pmid, ctx, { convert: false });
          }
          const draft = await prepareWechatDraft({
            pmid,
            extSummary,
            authors: ctx.authors,
            categoryIds: ctx.categoryIds,
            tagIds: ctx.tagIds,
            pdfUrl: ctx.pdfUrl,
            // Same session deps the PDF download uses — drives the hidden
            // Cowork session that reads the PDF/XML and writes the draft.
            deps: this.getPdfUrlFinderDeps(),
            // Uploads the finished markdown as md/{pmid}.md.
            clientDeps: this.client.getDeps(),
            agentId: ctx.pipelineAgentId,
            modelOverride: ctx.pipelineModelOverride || undefined,
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
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        this.log(pmid, 'warn', `advance cancelled at ${action}`);
        throw err;
      }
      const isStateConflict = isLitStateTransitionConflict(message);
      if (isStateConflict || isLitXmlUnavailableError(message)) {
        // Neither rejection is a processing failure, so neither may be
        // reported via `reportTaskFailure` (`markAsFailed: true` would
        // pollute a recoverable task) nor flip the local task to `failed`.
        //
        // State conflict: the backend's view of the task differs from
        // ours (duplicate submit, task reset/advanced elsewhere). The
        // renderer re-fetches the pending list (keyed off the same
        // marker) so the next click uses the authoritative status.
        //
        // XML unavailable: the backend could not back-fill `fetched →
        // parsed` because OSS holds no XML for the pmid (transient
        // storage trouble, or the row legitimately has no XML yet). The
        // status is correct as-is — retry later, nothing to re-sync.
        this.log(
          pmid,
          'warn',
          isStateConflict
            ? `state transition rejected: ${message}`
            : `xml unavailable (retry later): ${message}`,
        );
        throw err;
      }
      this.log(pmid, 'error', `advance failed at ${action}: ${message}`);
      // Best-effort failure report. We don't want a failure report failure
      // to mask the original error, so swallow + log.
      try {
        await this.client.reportTaskFailure(
          {
            pmid,
            errorMsg: message,
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
   * Advance a task through EVERY remaining step in one call, stopping after
   * the GenerateWechatDoc step finishes — which ends with the Word document
   * converted and uploaded to `word/{pmid}.docx`. The stop node is
   * deliberate: the only thing left after it is the user pasting the WeChat
   * docUrl back, which no automation can do for them.
   *
   * Local work runs in the user-required order (2026-09-19): the
   * category/tag pick FIRST, then the full-text acquisition (PDF download /
   * closed-access landing page → `fulltext/{pmid}.md` conversion with
   * retries), then the analysis — so the generated 【关键发现】 cites
   * body-level data. The backend submit order is unchanged (analysis at
   * `parsed`, categories at `analyzed`, file at `categorized`); the
   * pre-picked ids and the downloaded artifact are submitted by their
   * regular steps (see {@link prePickCategories} and
   * {@link acquireFulltext}). When NO full-text source is obtainable at
   * all, the run ends gracefully at `categorized` instead of failing, so
   * the next run retries the download.
   *
   * Each intermediate transition goes through {@link advanceTask}, so the
   * per-step logs, failure reporting, and state-conflict handling are
   * identical to clicking the steps one by one. A step failure (already
   * reported + emitted as `failed` by `advanceTask`) propagates and stops
   * the run; the user fixes / resets and clicks again — the run resumes
   * from the surviving status.
   */
  async advanceTaskAuto(
    pmid: string,
    currentStatus: PaperPipelineProcessingStatus,
    signal?: AbortSignal,
    options?: PaperAutoAdvanceOptions,
  ): Promise<PaperTaskAdvanceResult> {
    // One concurrent auto run per task: a scheduled-task autopilot batch
    // can be advancing this pmid while the user clicks the button in the
    // UI. Two runs would double-drive the same per-pmid hidden session.
    if (this.activeAutoRuns.has(pmid)) {
      throw new PaperPipelineOrchestratorError(
        `auto-advance already running for ${pmid}`,
      );
    }
    this.activeAutoRuns.add(pmid);
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    this.autoRunControllers.set(pmid, controller);
    try {
      return await this.runAutoAdvance(pmid, currentStatus, controller.signal, options);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.autoRunControllers.get(pmid) === controller) {
        this.autoRunControllers.delete(pmid);
      }
      this.activeAutoRuns.delete(pmid);
    }
  }

  /** Cancel a running one-click advance without changing the backend status. */
  cancelTaskAuto(pmid: string): boolean {
    const controller = this.autoRunControllers.get(pmid);
    if (!controller) return false;
    controller.abort();
    const runtime = this.getPdfUrlFinderDeps().coworkRuntime;
    if (runtime) stopTaskHiddenSession(pmid, runtime);
    this.log(pmid, 'warn', 'auto-advance cancelled by user');
    return true;
  }

  private async runAutoAdvance(
    pmid: string,
    currentStatus: PaperPipelineProcessingStatus,
    signal?: AbortSignal,
    options?: PaperAutoAdvanceOptions,
  ): Promise<PaperTaskAdvanceResult> {
    let status = currentStatus;
    let result: PaperTaskAdvanceResult | null = null;
    // Resolve the LLM driver for this run once (user requirement
    // 2026-09-19): explicit override wins, then auto-detect an installed
    // "生物研究" / "Biological Research" expert from the cowork store,
    // then fall back to the pre-existing `main` agent. Missing store ⇒
    // `main` (the resolved agent id is the only thing downstream sees;
    // it never throws on its own).
    const pipelineAgentId = resolvePipelineAgentId(
      this.resolveCoworkStore(),
      options?.agentId,
    );
    if (pipelineAgentId !== 'main') {
      this.log(
        pmid,
        'info',
        `pipeline agent: using installed expert '${pipelineAgentId}' (override of default 'main')`,
      );
    }
    // Model config is resolved once per run, right after the agent: an
    // explicit user config wins; otherwise smart-follow the driving
    // agent's binding (DeepSeek reasoner → v4-flash, same provider only).
    const modelConfig = this.resolveModelConfig();
    const pipelineModelOverride = this.resolveRunModelOverride(modelConfig, pipelineAgentId);
    if (pipelineModelOverride) {
      this.log(
        pmid,
        'info',
        `pipeline model override: '${pipelineModelOverride}'`,
      );
    }
    // One context shared by every step of the run: the Analyze summary is
    // reused by Categorize (no redundant re-analysis turn), and the
    // title / abstract mined at ParseXml reach the PDF download prompt.
    const ctx: AdvanceContext = {
      pmid,
      xml: null,
      authors: [],
      extSummary: null,
      title: null,
      abstractText: null,
      doi: null,
      categoryIds: [],
      tagIds: [],
      pdfUrl: options?.pdfUrl ?? null,
      docUrl: null,
      fulltextMdPath: null,
      fulltextSourceKind: null,
      prefetchedHtmlPath: null,
      openAccess: options?.openAccess ?? null,
      categorizePicked: false,
      fulltextAcquired: false,
      pipelineAgentId,
      pipelineModelOverride,
      pdfUrlSuggestModel: resolvePdfUrlSuggestModel(modelConfig),
    };
    // A full run is at most 5 transitions (parse → analyze → categorize →
    // pdf → wechat-doc). The cap is a runaway guard, not a feature.
    for (let step = 0; step < 6; step += 1) {
      if (signal?.aborted) {
        throw new PaperPipelineOrchestratorError(`auto-advance aborted for ${pmid}`);
      }
      const action = STATUS_TO_ACTION[status];
      if (!action) break;
      this.log(pmid, 'info', `auto-advance step ${step + 1}: ${status} → ${action}`);
      // Local pre-work in the user-required order (2026-09-19): the
      // category/tag pick runs FIRST, then the full-text acquisition (PDF
      // URL finder → agent download → Markdown conversion with retries).
      // The backend state machine still forces the SUBMIT order (analysis
      // at `parsed`, categories at `analyzed`, file at `categorized`), so
      // the pre-pick result is held in ctx and submitted by the Categorize
      // step, and the downloaded artifact is uploaded by the
      // DownloadAndUploadPdf step (a cache hit).
      if (
        (action === PaperPipelineAdvanceAction.Analyze ||
          action === PaperPipelineAdvanceAction.Categorize) &&
        !ctx.categorizePicked
      ) {
        await this.prePickCategories(pmid, ctx);
      }
      if (
        (action === PaperPipelineAdvanceAction.Analyze ||
          action === PaperPipelineAdvanceAction.Categorize ||
          action === PaperPipelineAdvanceAction.DownloadAndUploadPdf) &&
        !ctx.fulltextAcquired
      ) {
        // Convert to Markdown only when the analysis has not been
        // submitted yet (the md's only consumer is the extSummary); runs
        // resuming at `analyzed`/`categorized` only need the download.
        await this.acquireFulltext(pmid, ctx, {
          convert: action === PaperPipelineAdvanceAction.Analyze,
        });
      }
      // No full-text source at all (closed access AND the landing page
      // could not be saved): end the run gracefully at `categorized` — no
      // reportTaskFailure, no `failed` mark — so the next run retries the
      // download (user decision 2026-09-19).
      if (
        action === PaperPipelineAdvanceAction.DownloadAndUploadPdf &&
        !(await this.hasFulltextSource(pmid))
      ) {
        this.log(
          pmid,
          'warn',
          'no PDF/HTML obtainable — ending run gracefully (will retry next run)',
        );
        // Mid-run this is the categories submit result (task now at
        // `categorized`); a run that STARTED at `categorized` has run no
        // step yet and gets a no-op result instead of an error.
        return (
          result ?? {
            pmid,
            fromStatus: currentStatus,
            toStatus: currentStatus,
            action: PaperPipelineAdvanceAction.DownloadAndUploadPdf,
          }
        );
      }
      result = await this.advanceTask(pmid, status, signal, ctx);
      // GenerateWechatDoc keeps the task at `pdf_ready` and returns the
      // draft payload — that IS the stop node (word already uploaded).
      if (action === PaperPipelineAdvanceAction.GenerateWechatDoc) {
        this.log(pmid, 'info', 'auto-advance finished: word document uploaded');
        return result;
      }
      // No progress (defensive — a non-wechat step that maps to itself
      // would otherwise spin the loop).
      if (result.toStatus === status) break;
      status = result.toStatus;
    }
    if (!result) {
      throw new PaperPipelineOrchestratorError(
        `Cannot auto-advance task ${pmid} from status ${currentStatus}`,
      );
    }
    return result;
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
    this.log(payload.pmid, 'warn', `manual reportFailure: ${payload.errorMsg}`);
    const result = await this.client.reportTaskFailure(payload, signal);
    const toStatus = payload.markAsFailed
      ? PaperPipelineProcessingStatus.Failed
      : payload.resetTo ?? PaperPipelineProcessingStatus.XmlReady;
    this.emitAdvance(payload.pmid, undefined, toStatus, payload.markAsFailed ? null : payload.errorMsg);
    return result;
  }

  /**
   * Closed-access continuation of the DownloadAndUploadPdf step: archive
   * the saved landing page (`html/{pmid}.html`) to OSS and register it via
   * `submitFile(fileType=html)` — which advances to `pdf_ready` like a
   * PDF (backend contract change 2026-09-19), letting the MD draft / word
   * export chain proceed without a PDF. A stat failure propagates, which
   * routes to the normal reportTaskFailure path.
   */
  private async uploadClosedAccessHtmlFallback(
    pmid: string,
    htmlPath: string,
    ctx: AdvanceContext,
    signal?: AbortSignal,
  ): Promise<PaperTaskAdvanceResult> {
    const stat = await fsp.stat(htmlPath);
    const uploaded = await uploadFile({
      pmid,
      fileType: LitArchiveFileType.Html,
      localPath: htmlPath,
      bytes: stat.size,
      clientDeps: this.client.getDeps(),
    });
    ctx.pdfUrl = uploaded.url;
    this.log(pmid, 'info', `uploaded HTML fallback to ${uploaded.url}`);
    return this.client.submitFile(pmid, LitArchiveFileType.Html, uploaded.url, signal);
  }

  /**
   * Shared `downloadPdf` input for the auto-advance pre-fetch and the
   * DownloadAndUploadPdf step, so both drive the same LLM URL finder and
   * hidden-session downloader wiring.
   */
  private buildDownloadPdfInput(
    pmid: string,
    ctx: AdvanceContext,
  ): Parameters<typeof downloadPdf>[0] {
    return {
      pmid,
      preferredUrl: /^https?:\/\//i.test(ctx.pdfUrl ?? '') ? ctx.pdfUrl : null,
      title: ctx.title,
      abstractText: ctx.abstractText,
      doi: ctx.doi,
      authors: ctx.authors,
      findPdfUrl: async (args) => findPdfUrl({
        ...args,
        deps: this.getPdfUrlFinderDeps(),
        suggestModel: ctx.pdfUrlSuggestModel,
      }),
      downloadViaAgent: async (args) => downloadPdfViaHiddenCoworkSession({
        ...args,
        deps: this.getPdfUrlFinderDeps(),
        // Thread the auto-resolved expert id so the agent walking
        // EuropePMC / PMC mirrors is the biology-tuned one when present.
        agentId: ctx.pipelineAgentId,
        modelOverride: ctx.pipelineModelOverride || undefined,
      }),
    };
  }

  /**
   * Resolve the closed-access landing page for a failed download: the path
   * attached to this round's `PaperPdfDownloadError`, else a previously
   * cached `html/{pmid}.html`. Returns null when no HTML exists anywhere.
   */
  private async resolveClosedAccessHtmlPath(
    pmid: string,
    err: unknown,
  ): Promise<string | null> {
    let htmlPath =
      err instanceof PaperPdfDownloadError ? err.htmlPath ?? null : null;
    if (!htmlPath) {
      // Retry resilience: this round saved nothing (e.g. fully offline)
      // but a previous round did — reuse the cached page.
      const cachedPath = getPaperPipelineHtmlPath(pmid);
      const cachedExists = await fsp
        .access(cachedPath)
        .then(() => true)
        .catch(() => false);
      if (cachedExists) htmlPath = cachedPath;
    }
    return htmlPath;
  }

  /**
   * Local full-text for the analysis step, preferring the one this run
   * produced. Single-step callers reuse a conversion left on disk by an
   * earlier run.
   */
  private async resolveFulltextMdPath(ctx: AdvanceContext): Promise<string | null> {
    return ctx.fulltextMdPath ?? getExistingFulltextMdPath(ctx.pmid);
  }

  /**
   * Auto-advance full-text acquisition (user-required work order
   * 2026-09-19): PDF URL finder → agent download (or closed-access landing
   * page) → Markdown conversion. Runs AFTER the category pre-pick and
   * BEFORE the Analyze step, so 【关键发现】 can cite body-level data.
   *
   * Strictly local: no upload, no submit — the backend state machine only
   * accepts the file submit at `categorized`, so the artifact is archived
   * later by the DownloadAndUploadPdf step (a cache hit for the PDF).
   * Never throws: on any failure the analysis proceeds on the cached XML,
   * and the DownloadAndUploadPdf gate decides how the run ends.
   *
   * `convert: false` (runs resuming at `analyzed`+ where the analysis was
   * already submitted) skips the Markdown conversion — its only consumer
   * is the extSummary, so the conversion sessions would be wasted work.
   * When converting, failures are retried twice (three attempts total,
   * user decision 2026-09-19); a persistent failure does not block the
   * run — the file step still submits the PDF/HTML and the WeChat draft
   * session reads the source directly.
   */
  private async acquireFulltext(
    pmid: string,
    ctx: AdvanceContext,
    opts: { convert: boolean },
  ): Promise<void> {
    // One acquisition round per run, success or failure.
    ctx.fulltextAcquired = true;
    try {
      // A previous run may already have converted the full text.
      const cachedMd = await getExistingFulltextMdPath(pmid, ctx.title);
      if (cachedMd) {
        ctx.fulltextMdPath = cachedMd;
        const cachedPdf = await fsp.access(getPaperPipelinePdfPath(pmid)).then(() => true, (): false => false);
        ctx.fulltextSourceKind = cachedPdf ? 'pdf' : 'html';
        this.log(pmid, 'info', `acquire: reusing cached full-text markdown ${cachedMd}`);
        return;
      }

      await this.mineXmlContext(pmid, ctx);

      // Locate the full-text source: a cached PDF first (data on disk
      // beats the backend flag), then — when the backend flagged the paper
      // closed access (`openAccess === false`, contract v1.3) — straight
      // to the landing page without burning the download chain. Otherwise
      // a cached landing page (a previous round already concluded closed
      // access), else a fresh download.
      let sourcePath: string | null = null;
      let sourceKind: 'pdf' | 'html' = 'pdf';
      const pdfStat = await fsp.stat(getPaperPipelinePdfPath(pmid)).catch((): null => null);
      if (pdfStat && pdfStat.size > 1024) {
        sourcePath = getPaperPipelinePdfPath(pmid);
      } else if (ctx.openAccess === false) {
        const htmlPath = await ensureClosedAccessLandingPage(pmid);
        if (htmlPath) {
          // The backend flag is authoritative proof of closed access, so
          // the file step may short-circuit on this path too.
          ctx.prefetchedHtmlPath = htmlPath;
          sourcePath = htmlPath;
          sourceKind = 'html';
          this.log(pmid, 'info', `acquire: closed access per backend flag — landing page ${htmlPath}`);
        } else {
          this.log(pmid, 'warn', 'acquire: closed access per backend flag, landing page unavailable');
        }
      } else {
        const htmlPath = getPaperPipelineHtmlPath(pmid);
        const hasHtml = await fsp.access(htmlPath).then(() => true, (): false => false);
        if (hasHtml) {
          sourcePath = htmlPath;
          sourceKind = 'html';
        } else {
          const download = await downloadPdf(this.buildDownloadPdfInput(pmid, ctx));
          this.log(pmid, 'info', `acquire: downloaded PDF (${download.bytes} bytes)`);
          sourcePath = download.localPath;
        }
      }
      if (!sourcePath) return;

      if (!opts.convert) {
        this.log(
          pmid,
          'info',
          'acquire: source on disk, skipping md conversion (analysis already submitted)',
        );
        return;
      }
      const mdPath = await this.convertWithRetries(
        pmid,
        sourcePath,
        sourceKind,
        ctx.title,
        ctx.pipelineAgentId,
        ctx.pipelineModelOverride,
      );
      if (mdPath) {
        ctx.fulltextMdPath = mdPath;
        ctx.fulltextSourceKind = sourceKind;
      } else {
        this.log(
          pmid,
          'warn',
          'acquire: full-text markdown unavailable after retries, analysis will fall back to XML',
        );
      }
    } catch (err) {
      // Closed-access: the download failed but the landing page was saved
      // — remember it so the file step skips the doomed retry, and convert
      // the page so the analysis at least gets the abstract-level text.
      try {
        const htmlPath = await this.resolveClosedAccessHtmlPath(pmid, err);
        if (htmlPath) {
          ctx.prefetchedHtmlPath = htmlPath;
          this.log(pmid, 'warn', `acquire: no OA PDF — closed-access HTML fallback ${htmlPath}`);
          if (opts.convert) {
            const mdPath = await this.convertWithRetries(
              pmid,
              htmlPath,
              'html',
              ctx.title,
              ctx.pipelineAgentId,
              ctx.pipelineModelOverride,
            );
            if (mdPath) {
              ctx.fulltextMdPath = mdPath;
              ctx.fulltextSourceKind = 'html';
            }
          }
          return;
        }
      } catch (nestedErr) {
        this.log(
          pmid,
          'warn',
          `acquire: closed-access fallback failed: ${nestedErr instanceof Error ? nestedErr.message : 'unknown'}`,
        );
        return;
      }
      // Fully offline / unexpected failure — swallow it: the analysis runs
      // on the cached XML and the run's graceful-end gate handles the rest.
      this.log(
        pmid,
        'warn',
        `acquire: full-text acquisition failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /**
   * User-required work order (2026-09-19): the category/tag pick runs
   * FIRST — before the PDF download — so the guaranteed metadata-level
   * work is done before any potentially slow or failing download. The
   * result is held in ctx and submitted by the Categorize step (which the
   * backend state machine only allows after submitAnalysis). Never throws:
   * failures and EMPTY picks both reset `categorizePicked` so the Categorize
   * step re-picks with the extSummary and the by-then-warm pooled session;
   * if the catalogue is still unreachable there, `pickCategories` throws
   * and the run aborts visibly (user decision 2026-09-23).
   */
  private async prePickCategories(pmid: string, ctx: AdvanceContext): Promise<void> {
    ctx.categorizePicked = true;
    try {
      await this.mineXmlContext(pmid, ctx);
      const picked = await pickCategories({
        pmid,
        // The analysis does not exist yet at this point (it runs after the
        // full-text conversion in the required order); the categorize LLM
        // prompt works off the title/abstract/XML anyway.
        extSummary: ctx.extSummary ?? '',
        authors: ctx.authors,
        clientDeps: this.client.getDeps(),
        xml: ctx.xml ?? undefined,
        xmlPath: getPaperPipelineXmlPath(pmid),
        deps: this.getPdfUrlFinderDeps(),
        agentId: ctx.pipelineAgentId,
        modelOverride: ctx.pipelineModelOverride || undefined,
      });
      ctx.categoryIds = picked.categoryIds;
      ctx.tagIds = picked.tagIds;
      if (picked.categoryIds.length === 0 && picked.tagIds.length === 0) {
        // An empty pick is almost always a degraded path (LLM skipped /
        // keyword 0-hit), not a real "nothing fits" verdict — do NOT lock
        // it in. Reset so the Categorize step re-picks with the extSummary
        // and the now-warm pooled session (user decision 2026-09-23).
        ctx.categorizePicked = false;
        this.log(
          pmid,
          'warn',
          'category pre-pick returned 0 categories and 0 tags — will retry at the Categorize step',
        );
        return;
      }
      this.log(
        pmid,
        'info',
        `pre-picked ${picked.categoryIds.length} categor(ies) and ${picked.tagIds.length} tag(s)`,
      );
    } catch (err) {
      // Reset so the Categorize step falls back to the original pick path
      // (where the extSummary is available by then).
      ctx.categorizePicked = false;
      this.log(
        pmid,
        'warn',
        `category pre-pick failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /**
   * Populate `ctx.xml/authors/title/abstractText` from the cached XML when
   * missing. The categorize pre-pick and the download prompt both need
   * them, and runs starting after ParseXml skip that step.
   */
  private async mineXmlContext(pmid: string, ctx: AdvanceContext): Promise<void> {
    if (ctx.title && ctx.abstractText) return;
    ctx.xml = ctx.xml ?? (await readCachedXml(pmid)) ?? '';
    if (!ctx.xml) return;
    ctx.authors = ctx.authors.length > 0 ? ctx.authors : parseAuthors(ctx.xml);
    ctx.title = ctx.title ?? (extractTitle(ctx.xml) || null);
    ctx.abstractText = ctx.abstractText ?? (extractAbstract(ctx.xml) || null);
    ctx.doi = ctx.doi ?? (extractDoi(ctx.xml) || null);
  }

  /**
   * Convert a full-text source to Markdown with the user-required retry
   * policy (2026-09-19): three attempts total, then give up — the run
   * continues on the abstract / direct PDF reading.
   */
  private async convertWithRetries(
    pmid: string,
    sourcePath: string,
    sourceKind: 'pdf' | 'html',
    title: string | null,
    pipelineAgentId: string,
    modelOverride: string,
  ): Promise<string | null> {
    let mdPath: string | null = null;
    for (let attempt = 1; attempt <= 3 && !mdPath; attempt += 1) {
      mdPath = await convertFulltextToMarkdown({
        pmid,
        sourcePath,
        sourceKind,
        title,
        deps: this.getPdfUrlFinderDeps(),
        agentId: pipelineAgentId,
        modelOverride: modelOverride || undefined,
      });
      if (!mdPath && attempt < 3) {
        this.log(pmid, 'warn', `acquire: md conversion attempt ${attempt} failed, retrying`);
      }
    }
    return mdPath;
  }

  /**
   * Whether a full-text source exists on disk: a cached PDF (>1KB, the
   * `downloadPdf` cache threshold) or a closed-access landing page. The
   * DownloadAndUploadPdf gate uses this to end the run gracefully when
   * nothing was obtainable.
   */
  private async hasFulltextSource(pmid: string): Promise<boolean> {
    const pdfStat = await fsp.stat(getPaperPipelinePdfPath(pmid)).catch((): null => null);
    if (pdfStat && pdfStat.size > 1024) return true;
    return fsp
      .access(getPaperPipelineHtmlPath(pmid))
      .then((): boolean => true, (): boolean => false);
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
