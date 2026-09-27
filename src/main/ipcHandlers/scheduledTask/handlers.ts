import { randomUUID } from 'node:crypto';

import { ipcMain } from 'electron';

import {
  DeliveryMode as STDeliveryMode,
  IpcChannel as ScheduledTaskIpc,
  PayloadKind as STPayloadKind,
  SessionTarget as STSessionTarget,
} from '../../../scheduledTask/constants';
import type { CronJobService } from '../../../scheduledTask/cronJobService';
import type { ScheduledTaskMetaStore } from '../../../scheduledTask/metaStore';
import type {
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
} from '../../../scheduledTask/types';
import { AgentId } from '../../../shared/agent/constants';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import {
  imConversationDisplayName,
  ImPeerKind,
  type ParsedImConversationId,
  parseImConversationId,
  type Platform,
  PlatformRegistry,
} from '../../../shared/platform';
import {
  dedupeConversationMappings,
  filterConversationMappingsForSelectedAccount,
  listScheduledTaskChannels,
  resolveConversationAgentIdFromMappings,
  resolveGroupDeliveryTargetFromSessions,
  resolveImDeliveryHintsFromSessions,
} from './helpers';

/** Matches auto-generated channel session titles, e.g. "[TG] group:123". */
const AUTO_CHANNEL_TITLE_RE = /^\[[^\]]*\]\s/;
const DINGTALK_PLATFORM: Platform = 'dingtalk';
const WECOM_PLATFORM: Platform = 'wecom';
const CASE_SENSITIVE_GROUP_TARGET_PLATFORMS = new Set<Platform>([
  DINGTALK_PLATFORM,
  WECOM_PLATFORM,
]);

type ConversationMappingForList = {
  imConversationId: string;
  platform: string;
  coworkSessionId: string;
  agentId: string;
  lastActiveAt: string;
};

type AnnounceNormalizationContext = {
  platform: Platform;
  rawTo: string;
  parsedConversation: ParsedImConversationId;
};

function normalizeImAnnounceDeliveryTo(
  rawTo: string,
  mappings: readonly ConversationMappingForList[],
  platform: Platform,
): string {
  const parsed = parseImConversationId(rawTo);
  if (
    parsed.peerKind === ImPeerKind.Direct ||
    parsed.peerKind === ImPeerKind.Group ||
    parsed.peerKind === ImPeerKind.Channel
  ) {
    return parsed.peerId;
  }

  // Bare targets for case-sensitive group-id providers are already native ids.
  // Do not replace their case from a lowercased OpenClaw session mapping.
  if (CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(platform) && !rawTo.includes(':')) {
    return rawTo;
  }

  const peer = parsed.peerId.trim().toLowerCase();
  if (peer) {
    for (const mapping of mappings) {
      const mappingParsed = parseImConversationId(mapping.imConversationId);
      if (mappingParsed.peerId.trim().toLowerCase() !== peer) continue;
      return mappingParsed.peerId;
    }
  }

  const colonIdx = rawTo.lastIndexOf(':');
  if (colonIdx > 0) {
    return rawTo.slice(colonIdx + 1);
  }
  return rawTo;
}

export interface ScheduledTaskHandlerDeps {
  getCronJobService: () => CronJobService;
  getIMGatewayManager: () => {
    getIMStore: () =>
      | {
          getSessionMapping: (
            conversationId: string,
            platform: string,
          ) =>
            | {
                coworkSessionId: string;
              }
            | undefined;
          getIMSettings?: () => {
            platformAgentBindings?: Record<string, string>;
          };
          listSessionMappings: (
            platform: string,
            accountId?: string,
          ) => ConversationMappingForList[];
        }
      | undefined;
    primeConversationReplyRoute: (
      platform: string,
      conversationId: string,
      coworkSessionId: string,
    ) => Promise<void>;
  } | null;
  /** Resolve a Cowork session title for conversation display names. */
  getCoworkSessionTitle: (sessionId: string) => string | null;
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => unknown;
    getEngineStatusSnapshot: () => { phase: OpenClawEnginePhase };
    connectGatewayIfNeeded: () => Promise<void>;
    fetchSessionByKey: (
      sessionKey: string,
      options?: { sessionId?: string | null },
    ) => Promise<unknown>;
  } | null;
  /**
   * Local scheduled-task metadata (origin/binding + per-task skills
   * selection backing the synthetic agent). Never null in production.
   */
  getMetaStore: () => ScheduledTaskMetaStore;
  /**
   * Fire an OpenClaw config sync when the synthetic agents list changes
   * (same pattern the agent CRUD handlers use).
   */
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<{ success: boolean; changed: boolean }>;
}

/** Structural view of the OpenClaw gateway client needed for session lookups. */
interface GatewayRpcClient {
  request: <T>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<T>;
}

function asGatewayRpcClient(value: unknown): GatewayRpcClient | null {
  if (value && typeof (value as GatewayRpcClient).request === 'function') {
    return value as GatewayRpcClient;
  }
  return null;
}

function summarizeAccountId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function summarizeGroupMappings(
  mappings: readonly ConversationMappingForList[],
): Array<{ peerId: string; agentId: string }> {
  return mappings
    .map((mapping) => {
      const parsed = parseImConversationId(mapping.imConversationId);
      if (parsed.accountId || parsed.peerKind !== 'group') return null;
      return {
        peerId: summarizeAccountId(parsed.peerId) ?? parsed.peerId,
        agentId: mapping.agentId,
      };
    })
    .filter((entry): entry is { peerId: string; agentId: string } => Boolean(entry))
    .slice(0, 8);
}

function summarizeRelevantBindings(
  platformAgentBindings: Record<string, string> | undefined,
  platform: string,
  selectedAccountId: string | undefined,
): Array<{ key: string; agentId: string }> {
  if (!platformAgentBindings) return [];
  const selectedPrefix = selectedAccountId ? `${platform}:${selectedAccountId}` : null;
  return Object.entries(platformAgentBindings)
    .filter(([key]) => (
      key === platform ||
      (selectedPrefix ? key.startsWith(selectedPrefix) : key.startsWith(`${platform}:`))
    ))
    .map(([key, agentId]) => ({ key: summarizeAccountId(key) ?? key, agentId }))
    .slice(0, 8);
}

function logChannelConversationList(params: {
  channel: string;
  platform: string;
  accountId?: string;
  filterAccountId?: string;
  selectedAccountId?: string;
  platformAgentBindings?: Record<string, string>;
  rawMappings: readonly ConversationMappingForList[];
  filteredMappings: readonly ConversationMappingForList[];
  dedupedMappings: readonly ConversationMappingForList[];
}): void {
  const filteredSet = new Set(params.filteredMappings);
  const droppedMappings = params.rawMappings.filter(mapping => !filteredSet.has(mapping));
  console.debug(
    '[ScheduledTask] listed channel conversations:',
    JSON.stringify({
      channel: params.channel,
      platform: params.platform,
      accountId: summarizeAccountId(params.accountId),
      filterAccountId: summarizeAccountId(params.filterAccountId),
      selectedAccountId: summarizeAccountId(params.selectedAccountId),
      rawCount: params.rawMappings.length,
      filteredCount: params.filteredMappings.length,
      dedupedCount: params.dedupedMappings.length,
      bindingCount: Object.keys(params.platformAgentBindings ?? {}).length,
      rawGroups: summarizeGroupMappings(params.rawMappings),
      filteredGroups: summarizeGroupMappings(params.filteredMappings),
      dedupedGroups: summarizeGroupMappings(params.dedupedMappings),
      droppedGroups: summarizeGroupMappings(droppedMappings),
      relevantBindings: summarizeRelevantBindings(
        params.platformAgentBindings,
        params.platform,
        params.selectedAccountId,
      ),
    }),
  );
}

/**
 * Fast, local-only announce normalization. It never queries gateway session
 * history, so it is safe for background migration and manual-run repair.
 */
function applyLocalAnnounceDeliveryNormalization(
  normalizedInput: Record<string, any>,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager'>,
): AnnounceNormalizationContext | null {
  const { getIMGatewayManager } = deps;
  const delivery = normalizedInput.delivery;
  if (!(delivery && delivery.mode === STDeliveryMode.Announce && delivery.channel && delivery.to)) {
    return null;
  }
  const platform = PlatformRegistry.platformOfChannel(delivery.channel);
  if (!platform) return null;
  const imStore = getIMGatewayManager()?.getIMStore();
  const mappings = imStore?.listSessionMappings(platform) ?? [];
  const imSettings = imStore?.getIMSettings?.();

  normalizedInput.sessionTarget = STSessionTarget.Isolated;
  if (normalizedInput.payload?.kind === STPayloadKind.SystemEvent) {
    normalizedInput.payload = {
      kind: STPayloadKind.AgentTurn,
      message: normalizedInput.payload.text || '',
    };
  }

  // Strip conversation-id prefixes (e.g. "acc:direct:ou_xxx" -> "ou_xxx").
  // Outbound delivery targets must stay channel-native ids. For Feishu groups
  // this is the raw chat id (oc_xxx), not the OpenClaw session peer kind
  // marker (group:oc_xxx).
  const rawTo: string = delivery.to;
  const parsedConversation = parseImConversationId(rawTo);
  delivery.to = normalizeImAnnounceDeliveryTo(rawTo, mappings, platform);
  if (delivery.to !== rawTo) {
    console.debug(
      '[ScheduledTask] normalized IM delivery.to:',
      rawTo,
      '->',
      delivery.to,
    );
  }

  // IM conversations can be bound to a non-main agent. Run the job under that
  // agent so the gateway mirrors the delivered result into the conversation
  // session the LobsterAI record maps to, instead of a main-agent shadow
  // session that stays invisible in the UI.
  const existingAgentId = typeof normalizedInput.agentId === 'string'
    ? normalizedInput.agentId.trim()
    : '';
  if (!existingAgentId || existingAgentId === AgentId.Main) {
    try {
      const boundAgentId = resolveConversationAgentIdFromMappings(
        mappings,
        rawTo,
        parsedConversation.accountId ?? delivery.accountId,
        {
          platform,
          platformAgentBindings: imSettings?.platformAgentBindings,
        },
      );
      if (boundAgentId && boundAgentId !== AgentId.Main) {
        normalizedInput.agentId = boundAgentId;
        console.log(
          '[ScheduledTask] bound delivery job to conversation agent:',
          boundAgentId,
        );
      }
    } catch (error) {
      console.warn('[ScheduledTask] failed to resolve conversation agent binding:', error);
    }
  }

  return { platform, rawTo, parsedConversation };
}

async function restoreAnnounceDeliveryHintsFromGateway(
  normalizedInput: Record<string, any>,
  context: AnnounceNormalizationContext,
  deps: Pick<ScheduledTaskHandlerDeps, 'getOpenClawRuntimeAdapter'>,
  options?: { casingOnly?: boolean },
): Promise<void> {
  const { getOpenClawRuntimeAdapter } = deps;
  const delivery = normalizedInput.delivery;
  if (!(delivery && delivery.mode === STDeliveryMode.Announce && delivery.channel && delivery.to)) {
    return;
  }

  // Conversation ids are lowercased session-key derivatives; case-sensitive
  // channels (e.g. weixin) silently drop sends to a wrong-case peer id, and a
  // missing accountId makes the cron delivery route into a fresh "default"
  // account session instead of the existing conversation. Restore both from
  // the gateway's session store, which keeps the original casing.
  try {
    if (await ensureScheduledTaskGatewayClient(getOpenClawRuntimeAdapter)) {
      const client = asGatewayRpcClient(getOpenClawRuntimeAdapter()?.getGatewayClient());
      if (client) {
        const result = await client.request<{ sessions?: unknown[] }>(
          'sessions.list',
          { includeGlobal: true, includeUnknown: true, limit: 500 },
          { timeoutMs: 10_000 },
        );
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        const selectedAccountId = typeof delivery.accountId === 'string'
          ? delivery.accountId
          : undefined;
        if (!options?.casingOnly) {
          const hints = resolveImDeliveryHintsFromSessions({
            sessions,
            channel: delivery.channel,
            peerId: delivery.to,
            preferredAccountId: context.parsedConversation.accountId,
          });
          if (hints) {
            if (hints.to !== delivery.to) {
              console.log(
                '[ScheduledTask] restored delivery.to casing from gateway session:',
                delivery.to,
                '->',
                hints.to,
              );
              delivery.to = hints.to;
            }
            if (!delivery.accountId && hints.accountId) {
              delivery.accountId = hints.accountId;
            }
          }
        }

        if (CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(context.platform)) {
          const nativeGroupTarget = resolveGroupDeliveryTargetFromSessions({
            sessions,
            platform: context.platform,
            peerId: delivery.to,
            preferredAccountId: selectedAccountId,
          });
          if (nativeGroupTarget && nativeGroupTarget !== delivery.to) {
            console.log(
              `[ScheduledTask] restored ${context.platform} group delivery.to casing from gateway origin:`,
              delivery.to,
              '->',
              nativeGroupTarget,
            );
            delivery.to = nativeGroupTarget;
          }
        }
      }
    }
  } catch (error) {
    console.warn('[ScheduledTask] failed to restore IM delivery target from gateway sessions:', error);
  }
}

async function primeAnnounceReplyRoute(
  context: AnnounceNormalizationContext,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager'>,
): Promise<void> {
  if (context.platform === 'dingtalk') {
    const { getIMGatewayManager } = deps;
    const imStore = getIMGatewayManager()?.getIMStore();
    const mapping = imStore?.getSessionMapping(context.rawTo, context.platform);
    if (mapping) {
      await getIMGatewayManager()!.primeConversationReplyRoute(
        context.platform,
        context.rawTo,
        mapping.coworkSessionId,
      );
    }
  }
}

/**
 * Normalizes an announce-mode delivery payload for OpenClaw native delivery.
 * Mutates `normalizedInput` in place: sets sessionTarget, converts SystemEvent
 * payloads to AgentTurn, strips IM subtype prefixes from delivery.to, restores
 * the channel-native target casing/account from gateway sessions, and primes
 * the DingTalk reply route when needed.
 */
async function applyAnnounceDeliveryNormalization(
  normalizedInput: Record<string, any>,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'>,
): Promise<void> {
  const context = applyLocalAnnounceDeliveryNormalization(normalizedInput, deps);
  if (!context) return;
  await restoreAnnounceDeliveryHintsFromGateway(normalizedInput, context, deps);
  await primeAnnounceReplyRoute(context, deps);
}

function cloneDelivery(delivery?: ScheduledTaskDelivery): ScheduledTaskDelivery | undefined {
  return delivery ? { ...delivery } : undefined;
}

function clonePayload(payload: ScheduledTaskPayload): ScheduledTaskPayload {
  return { ...payload };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function buildAnnounceNormalizationPatch(
  task: ScheduledTask,
  deps: Pick<
    ScheduledTaskHandlerDeps,
    'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'
  >,
): Promise<Partial<ScheduledTaskInput> | null> {
  const normalizedInput: Record<string, any> = {
    sessionTarget: task.sessionTarget,
    payload: clonePayload(task.payload),
    delivery: cloneDelivery(task.delivery),
    agentId: task.agentId ?? undefined,
    sessionKey: task.sessionKey ?? undefined,
  };
  const context = applyLocalAnnounceDeliveryNormalization(normalizedInput, deps);
  if (!context) return null;
  const normalizedTo = typeof normalizedInput.delivery?.to === 'string'
    ? normalizedInput.delivery.to.trim()
    : '';
  if (
    CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(context.platform) &&
    normalizedTo &&
    normalizedTo === normalizedTo.toLowerCase()
  ) {
    // Historical repair must only restore the case-sensitive native group id;
    // it must not infer or change account routing from gateway metadata.
    await restoreAnnounceDeliveryHintsFromGateway(normalizedInput, context, deps, {
      casingOnly: true,
    });
  }

  const patch: Partial<ScheduledTaskInput> = {};
  if (normalizedInput.sessionTarget !== task.sessionTarget) {
    patch.sessionTarget = normalizedInput.sessionTarget;
  }
  if (stableJson(normalizedInput.payload) !== stableJson(task.payload)) {
    patch.payload = normalizedInput.payload;
  }
  if (stableJson(normalizedInput.delivery) !== stableJson(task.delivery)) {
    patch.delivery = normalizedInput.delivery;
  }
  if (
    normalizedInput.agentId !== undefined &&
    normalizedInput.agentId !== (task.agentId ?? undefined)
  ) {
    patch.agentId = normalizedInput.agentId;
  }
  if (
    normalizedInput.sessionKey !== undefined &&
    normalizedInput.sessionKey !== (task.sessionKey ?? undefined)
  ) {
    patch.sessionKey = normalizedInput.sessionKey;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

async function migrateScheduledTaskAnnounceJob(
  task: ScheduledTask,
  deps: Pick<
    ScheduledTaskHandlerDeps,
    'getCronJobService' | 'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'
  >,
): Promise<boolean> {
  const patch = await buildAnnounceNormalizationPatch(task, deps);
  if (!patch) return false;
  await deps.getCronJobService().updateJob(task.id, patch);
  console.log(
    '[ScheduledTask] migrated IM announce job:',
    JSON.stringify({
      id: task.id,
      deliveryChannel: task.delivery?.channel,
      deliveryTo: task.delivery?.to,
      patchedFields: Object.keys(patch),
    }),
  );
  return true;
}

export async function migrateScheduledTaskAnnounceJobs(
  deps: Pick<
    ScheduledTaskHandlerDeps,
    'getCronJobService' | 'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'
  >,
): Promise<{ checked: number; updated: number }> {
  const tasks = await deps.getCronJobService().listJobs();
  let updated = 0;
  for (const task of tasks) {
    if (await migrateScheduledTaskAnnounceJob(task, deps)) {
      updated += 1;
    }
  }
  const result = { checked: tasks.length, updated };
  if (updated > 0) {
    console.log('[ScheduledTask] migrated existing IM announce jobs:', JSON.stringify(result));
  }
  return result;
}

async function ensureScheduledTaskGatewayClient(
  getOpenClawRuntimeAdapter: ScheduledTaskHandlerDeps['getOpenClawRuntimeAdapter'],
): Promise<boolean> {
  const adapter = getOpenClawRuntimeAdapter();
  if (!adapter) return false;
  if (adapter.getGatewayClient()) return true;

  // While the engine is still installing/starting, report not-ready instead
  // of blocking on gateway startup; the renderer reloads via the refresh
  // event after the first successful cron poll.
  if (adapter.getEngineStatusSnapshot().phase !== OpenClawEnginePhase.Running) {
    return false;
  }

  await adapter.connectGatewayIfNeeded();
  return Boolean(adapter.getGatewayClient());
}

/**
 * Pull `skillIds` out of a create/update input. Returns `undefined` when the
 * request does not manage skills (leave existing meta untouched) so older
 * callers / programmatic flows stay unaffected.
 */
export function extractSkillIds(input: Record<string, any>): string[] | undefined {
  const skillIds = input.skillIds;
  if (!Array.isArray(skillIds)) return undefined;
  delete input.skillIds;
  return skillIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '');
}

/** Stable slug for the per-task synthetic agent. */
function buildSyntheticAgentId(): string {
  return `task-agent-${randomUUID().slice(0, 8)}`;
}

/**
 * Bind a task's skills selection to a derived synthetic agent and persist it
 * in the local meta store. Must run BEFORE addJob/updateJob so the agentId
 * lands in the same gateway call.
 *
 * Returns `configChanged` (the OpenClaw config needs a re-sync) and, on
 * create, the minted `pendingSkillAgent` to persist once the gateway
 * assigns the job id.
 *
 * Precedence: an explicit skills selection overrides any auto-bound
 * agentId (announce normalization) — it is the user's explicit choice.
 */
function applyTaskSkillsSelection(options: {
  metaStore: ScheduledTaskMetaStore;
  input: Record<string, any>;
  /** Gateway job id; null on create (agent id is minted fresh). */
  taskId: string | null;
}): { configChanged: boolean; pendingSkillAgent?: { agentId: string; skillIds: string[] } } {
  const { metaStore, input, taskId } = options;
  const skillIds = extractSkillIds(input);
  if (skillIds === undefined) return { configChanged: false };

  if (skillIds.length > 0) {
    const existing = taskId ? metaStore.getAgent(taskId) : null;
    const agentId = existing?.agentId ?? buildSyntheticAgentId();
    input.agentId = agentId;
    if (taskId) {
      metaStore.setAgent(taskId, {
        agentId,
        taskName: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : agentId,
        skillIds,
      });
      return { configChanged: true };
    }
    return { configChanged: false, pendingSkillAgent: { agentId, skillIds } };
  }

  // Skills cleared: drop the synthetic agent. Only reset the job's agentId
  // when the user did not explicitly pick another agent in the same request.
  const existing = taskId ? metaStore.getAgent(taskId) : null;
  if (!existing) return { configChanged: false };
  metaStore.setAgent(taskId, null);
  if (!input.agentId || input.agentId === existing.agentId) {
    input.agentId = null;
  }
  return { configChanged: true };
}

/**
 * After a successful create/update: persist pending create-time skills meta
 * (the job id only exists now), then trigger a config sync when the
 * synthetic agents list changed. Also enriches the returned task with
 * `agentSkillIds` so the renderer round-trips the selection.
 */
function finalizeTaskSkills(options: {
  metaStore: ScheduledTaskMetaStore;
  syncOpenClawConfig: ScheduledTaskHandlerDeps['syncOpenClawConfig'];
  task: ScheduledTask;
  pendingSkillAgent?: { agentId: string; skillIds: string[] } | null;
  configChanged: boolean;
}): ScheduledTask {
  const { metaStore, syncOpenClawConfig, task, pendingSkillAgent, configChanged } = options;
  if (pendingSkillAgent && task?.id) {
    metaStore.setAgent(task.id, {
      agentId: pendingSkillAgent.agentId,
      taskName: task.name ?? pendingSkillAgent.agentId,
      skillIds: pendingSkillAgent.skillIds,
    });
    triggerAgentsConfigSync(syncOpenClawConfig);
    return { ...task, agentSkillIds: pendingSkillAgent.skillIds };
  }
  if (configChanged) {
    triggerAgentsConfigSync(syncOpenClawConfig);
  }
  const meta = task?.id ? metaStore.getAgent(task.id) : null;
  return meta ? { ...task, agentSkillIds: meta.skillIds } : task;
}

function triggerAgentsConfigSync(
  syncOpenClawConfig: ScheduledTaskHandlerDeps['syncOpenClawConfig'],
): void {
  syncOpenClawConfig({ reason: 'scheduled-task-agent-updated' }).catch((err: unknown) => {
    console.error('[ScheduledTask] config sync after task agent update failed:', err);
  });
}

export function registerScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps): void {
  const { getCronJobService, getIMGatewayManager, getOpenClawRuntimeAdapter, getCoworkSessionTitle } = deps;

  ipcMain.handle(ScheduledTaskIpc.List, async () => {
    try {
      if (!(await ensureScheduledTaskGatewayClient(getOpenClawRuntimeAdapter))) {
        return { success: true, ready: false, tasks: [] };
      }
      const metaStore = deps.getMetaStore();
      const tasks = await getCronJobService().listJobs();
      return {
        success: true,
        ready: true,
        tasks: tasks.map((task) => {
          const meta = metaStore.getAgent(task.id);
          return meta ? { ...task, agentSkillIds: meta.skillIds } : task;
        }),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list tasks',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Get, async (_event, id: string) => {
    try {
      const task = await getCronJobService().getJob(id);
      const meta = task ? deps.getMetaStore().getAgent(task.id) : null;
      return { success: true, task: meta && task ? { ...task, agentSkillIds: meta.skillIds } : task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Create, async (_event, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      console.debug('[ScheduledTask] create input:', JSON.stringify(normalizedInput, null, 2));
      // Skills selection first: it sets the synthetic agentId explicitly, so
      // the announce auto-binding below correctly skips (explicit wins).
      const skills = applyTaskSkillsSelection({
        metaStore: deps.getMetaStore(),
        input: normalizedInput,
        taskId: null,
      });
      await applyAnnounceDeliveryNormalization(normalizedInput, {
        getIMGatewayManager,
        getOpenClawRuntimeAdapter,
      });

      const task = await getCronJobService().addJob(normalizedInput);
      console.log('[IPC][scheduledTask:create] result task id:', task?.id, 'name:', task?.name);
      const enrichedTask = finalizeTaskSkills({
        metaStore: deps.getMetaStore(),
        syncOpenClawConfig: deps.syncOpenClawConfig,
        task,
        pendingSkillAgent: skills.pendingSkillAgent,
        configChanged: skills.configChanged,
      });
      return { success: true, task: enrichedTask };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Update, async (_event, id: string, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      console.debug(
        '[ScheduledTask] update input id:',
        id,
        JSON.stringify(normalizedInput, null, 2),
      );
      const skills = applyTaskSkillsSelection({
        metaStore: deps.getMetaStore(),
        input: normalizedInput,
        taskId: id,
      });
      await applyAnnounceDeliveryNormalization(normalizedInput, {
        getIMGatewayManager,
        getOpenClawRuntimeAdapter,
      });

      const task = await getCronJobService().updateJob(id, normalizedInput);
      console.log('[IPC][scheduledTask:update] result task id:', task?.id, 'name:', task?.name);
      const enrichedTask = finalizeTaskSkills({
        metaStore: deps.getMetaStore(),
        syncOpenClawConfig: deps.syncOpenClawConfig,
        task,
        pendingSkillAgent: null,
        configChanged: skills.configChanged,
      });
      return { success: true, task: enrichedTask };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Delete, async (_event, id: string) => {
    try {
      await getCronJobService().removeJob(id);
      // Drop the local meta (incl. the synthetic agent) with the task.
      const metaStore = deps.getMetaStore();
      const hadAgent = metaStore.getAgent(id) !== null;
      metaStore.delete(id);
      if (hadAgent) {
        triggerAgentsConfigSync(deps.syncOpenClawConfig);
      }
      return { success: true, result: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Toggle, async (_event, id: string, enabled: boolean) => {
    try {
      const task = await getCronJobService().toggleJob(id, enabled);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to toggle task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.RunManually, async (_event, id: string) => {
    try {
      const cronJobService = getCronJobService();
      const task = await cronJobService.getJob(id);
      if (task) {
        await migrateScheduledTaskAnnounceJob(task, {
          getCronJobService,
          getIMGatewayManager,
          getOpenClawRuntimeAdapter,
        });
      }
      await cronJobService.runJob(id);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Manual run failed for ${id}:`, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Stop, async (_event, _id: string) => {
    // OpenClaw doesn't expose a direct stop API for running cron jobs
    // The job will complete or timeout on its own
    return { success: true, result: false };
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListRuns,
    async (
      _event,
      taskId: string,
      limit?: number,
      offset?: number,
      filter?: import('../../../scheduledTask/types').RunFilter,
    ) => {
      try {
        const runs = await getCronJobService().listRuns(taskId, limit, offset, filter);
        return { success: true, runs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list runs',
        };
      }
    },
  );

  ipcMain.handle(ScheduledTaskIpc.CountRuns, async (_event, taskId: string) => {
    try {
      const count = await getCronJobService().countRuns(taskId);
      return { success: true, count };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to count runs',
      };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListAllRuns,
    async (
      _event,
      limit?: number,
      offset?: number,
      filter?: import('../../../scheduledTask/types').RunFilter,
    ) => {
      try {
        if (!(await ensureScheduledTaskGatewayClient(getOpenClawRuntimeAdapter))) {
          return { success: true, ready: false, runs: [] };
        }
        const runs = await getCronJobService().listAllRuns(limit, offset, filter);
        return { success: true, ready: true, runs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list all runs',
        };
      }
    },
  );

  ipcMain.handle(
    ScheduledTaskIpc.ResolveSession,
    async (
      _event,
      input: string | { sessionId?: string | null; sessionKey?: string | null },
    ) => {
      try {
        const sessionKey = typeof input === 'string' ? input : (input.sessionKey ?? '');
        const sessionId = typeof input === 'string' ? null : (input.sessionId ?? null);
        if (!sessionKey) return { success: true, session: null };
        // Fetch session history from OpenClaw (returns transient session, not persisted)
        const session = await getOpenClawRuntimeAdapter()?.fetchSessionByKey(sessionKey, {
          sessionId,
        });
        return { success: true, session: session ?? null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to resolve session',
        };
      }
    },
  );

  ipcMain.handle(ScheduledTaskIpc.ListChannels, async () => {
    try {
      return { success: true, channels: listScheduledTaskChannels() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list channels',
      };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListChannelConversations,
    async (_event, channel: string, accountId?: string, filterAccountId?: string) => {
      try {
        const platform = PlatformRegistry.platformOfChannel(channel);
        if (!platform) return { success: true, conversations: [] };
        const imStore = getIMGatewayManager()?.getIMStore();
        if (!imStore) return { success: true, conversations: [] };
        const selectedAccountId = filterAccountId ?? accountId;
        const imSettings = imStore.getIMSettings?.();
        const platformAgentBindings = imSettings
          ? (imSettings.platformAgentBindings ?? {})
          : undefined;
        const rawMappings = imStore.listSessionMappings(platform, selectedAccountId);
        const filteredMappings = filterConversationMappingsForSelectedAccount(
          rawMappings,
          platform,
          selectedAccountId,
          platformAgentBindings,
        );
        const mappings = dedupeConversationMappings(filteredMappings);
        logChannelConversationList(
          {
            channel,
            platform,
            accountId,
            filterAccountId,
            selectedAccountId,
            platformAgentBindings,
            rawMappings,
            filteredMappings,
            dedupedMappings: mappings,
          },
        );
        const conversations = mappings.map(m => {
          const parsed = parseImConversationId(m.imConversationId);
          const sessionTitle = getCoworkSessionTitle(m.coworkSessionId)?.trim();
          // Channel-synced sessions get auto titles like "[TG] group:123"; only a
          // title the user renamed (no "[...] " prefix) beats the parsed peer id.
          const customTitle =
            sessionTitle && !AUTO_CHANNEL_TITLE_RE.test(sessionTitle) ? sessionTitle : undefined;
          return {
            conversationId: m.imConversationId,
            platform: m.platform,
            coworkSessionId: m.coworkSessionId,
            lastActiveAt: m.lastActiveAt,
            ...(parsed.peerKind ? { peerKind: parsed.peerKind } : {}),
            displayName: customTitle ?? imConversationDisplayName(m.imConversationId),
          };
        });
        return { success: true, conversations };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list conversations',
        };
      }
    },
  );
}
