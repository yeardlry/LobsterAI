import { BrowserWindow } from 'electron';

import { PaperPipelineIpcChannel } from '../../shared/paperPipeline/constants';
import type {
  PaperPipelineModelConfig,
  PaperTaskLogEvent,
  PaperTaskStatusChangedEvent,
} from '../../shared/paperPipeline/types';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { PaperPipelineClient } from './paperPipelineClient';
import {
  PaperPipelineEmitterBus,
  PaperPipelineService,
} from './paperPipelineService';

/**
 * `PaperPipelineServiceDeps` exposes every Cowork-side field as a thunk
 * so the service manager wiring in `main.ts` does not have to call
 * `getCoworkEngineRouter()` / `getCoworkStore()` before `initStore()` has
 * run. `PaperPipelineService` itself resolves the thunks when it builds
 * the default PDF URL finder deps.
 */
type MaybeThunk<T> = T | (() => T);

export interface PaperPipelineServiceDeps {
  /** lit backend base URL (see `getLitServerBaseUrl()` in libs/endpoints.ts). */
  getLitServerBaseUrl: () => string;
  /** Returns the current access token or null if the user is signed out. */
  getAccessToken: () => string | null;
  /** Gate: only enable the pipeline when lit auth is active. */
  isLitAuthSession: () => boolean;
  /**
   * Phase 7 — Cowork runtime + store for the hidden-session fallback in
   * the LLM PDF URL finder. Both are optional; when omitted the LLM PDF
   * finder falls back to the OpenClaw token-proxy only (priority-2 is
   * disabled). Tests should pass stubs.
   */
  coworkRuntime?: MaybeThunk<CoworkRuntime>;
  coworkStore?: MaybeThunk<CoworkStore>;
  /**
   * Resolves the default working directory for an agent. Mirrors
   * `resolveAgentDefaultWorkingDirectory()` in `src/main/main.ts:2194`.
   * Required iff `coworkRuntime` is provided.
   */
  resolveAgentCwd?: MaybeThunk<(agentId: string) => string>;
  /**
   * Reads the user's pipeline model config from the kv store. Thunk for
   * the same init-order reason as the fields above — the main.ts wiring
   * runs before `initStore()`. Omitted (tests) ⇒ the default
   * smart-follow config applies.
   */
  getPipelineModelConfig?: () => PaperPipelineModelConfig;
}

let singleton: PaperPipelineService | null = null;
let installedDeps: PaperPipelineServiceDeps | null = null;
let cleanupFns: Array<() => void> = [];

/**
 * Install the singleton. Wires the orchestrator's push events into
 * `BrowserWindow.webContents.send` for every live window, gated by
 * `isLitAuthSession()` so a non-lit session (OAuth) never broadcasts
 * paper-pipeline events.
 */
export function initPaperPipelineServiceManager(deps: PaperPipelineServiceDeps): void {
  if (installedDeps !== null) {
    // Allow re-init (e.g. after a re-login) but don't double-wire.
    disposePaperPipelineServiceManager();
  }
  installedDeps = deps;

  const bus = new PaperPipelineEmitterBus();
  // `PaperPipelineClient.request` owns the lit-vs-OAuth gate now
  // (isLitAuthSession check at the top of request()), so we no longer
  // wrap getAccessToken here — passing it through is safe and avoids
  // a second place where the auth state is interpreted.
  const client = new PaperPipelineClient({
    getBaseUrl: deps.getLitServerBaseUrl,
    getAccessToken: deps.getAccessToken,
    isLitAuthSession: deps.isLitAuthSession,
  });
  const service = new PaperPipelineService(client, bus, {
    coworkRuntime: deps.coworkRuntime,
    coworkStore: deps.coworkStore,
    resolveAgentCwd: deps.resolveAgentCwd,
    getPipelineModelConfig: deps.getPipelineModelConfig,
  });

  const cleanupStatus = bus.onStatusChanged((event: PaperTaskStatusChangedEvent) => {
    if (!deps.isLitAuthSession()) return;
    broadcast(PaperPipelineIpcChannel.StatusChanged, event);
  });
  cleanupFns.push(cleanupStatus);

  const cleanupLog = bus.onLog((event: PaperTaskLogEvent) => {
    if (!deps.isLitAuthSession()) return;
    broadcast(PaperPipelineIpcChannel.Log, event);
  });
  cleanupFns.push(cleanupLog);

  singleton = service;
}

/**
 * Tear down the singleton. Safe to call multiple times.
 */
export function disposePaperPipelineServiceManager(): void {
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];
  singleton = null;
  installedDeps = null;
}

/**
 * Returns the live orchestrator. Throws if `initPaperPipelineServiceManager`
 * has not been called yet.
 */
export function getPaperPipelineService(): PaperPipelineService {
  if (singleton === null) {
    throw new Error('PaperPipelineService has not been initialized');
  }
  return singleton;
}

/** Returns true if the orchestrator has been initialized. */
export function isPaperPipelineServiceInitialized(): boolean {
  return singleton !== null;
}

/**
 * Push a payload to every live, non-destroyed BrowserWindow.
 * Mirrors the pattern in `src/scheduledTask/cronJobService.ts:949-971`.
 */
function broadcast(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach(window => {
    if (window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  });
}