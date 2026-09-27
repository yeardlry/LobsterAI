import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
import { PRESET_AGENTS, type PresetAgent,presetToCreateRequest } from './presetAgents';

/**
 * AgentManager handles CRUD operations for agents and preset agent installation.
 * Agents are stored in the SQLite `agents` table via CoworkStore.
 */
export class AgentManager {
  private store: CoworkStore;

  constructor(store: CoworkStore) {
    this.store = store;
  }

  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  getAgent(agentId: string): Agent | null {
    return this.store.getAgent(agentId);
  }

  getDefaultAgent(): Agent {
    const agents = this.store.listAgents();
    return agents.find(a => a.isDefault) || agents[0];
  }

  createAgent(request: CreateAgentRequest, defaultModel?: string): Agent {
    return this.store.createAgent({
      ...request,
      model: request.model?.trim() || defaultModel?.trim() || '',
      workingDirectory: request.workingDirectory?.trim() || '',
    });
  }

  updateAgent(agentId: string, updates: UpdateAgentRequest): Agent | null {
    return this.store.updateAgent(agentId, {
      ...updates,
      ...(updates.workingDirectory !== undefined
        ? { workingDirectory: updates.workingDirectory.trim() }
        : {}),
    });
  }

  reorderAgents(agentIds: string[]): Agent[] {
    return this.store.reorderAgents(agentIds);
  }

  deleteAgent(agentId: string): boolean {
    return this.store.deleteAgent(agentId);
  }

  // --- Preset agents ---

  getPresetAgents(): PresetAgent[] {
    const existingAgents = this.store.listAgents();
    const existingPresetIds = new Set(
      existingAgents.filter(a => a.source === 'preset').map(a => a.presetId)
    );
    // Only return presets that haven't been added yet
    return PRESET_AGENTS.filter(p => !existingPresetIds.has(p.id));
  }

  getAllPresetAgents(): PresetAgent[] {
    return PRESET_AGENTS;
  }

  addPresetAgent(presetId: string, defaultModel?: string): Agent | null {
    const preset = PRESET_AGENTS.find(p => p.id === presetId);
    if (!preset) return null;

    // Check if already installed
    const existing = this.store.getAgent(preset.id);
    if (existing) return existing;

    return this.store.createAgent({
      ...presetToCreateRequest(preset),
      model: defaultModel?.trim() || '',
      workingDirectory: '',
    });
  }

  /**
   * Install every preset listed in {@link DEFAULT_PRESET_IDS}. Designed to
   * run on every app startup so freshly-packaged installs ship with the
   * default expert suite out of the box.
   *
   * `addPresetAgent` is already idempotent — it short-circuits when the
   * preset agent already exists. So re-running this on every startup is
   * safe: first launch installs, later launches are no-ops. If the user
   * explicitly deletes a default preset agent, the next startup will
   * re-install it (the user accepted that behaviour for the bio-research
   * preset; to permanently suppress a default preset the user must remove
   * its id from {@link DEFAULT_PRESET_IDS} in code).
   *
   * Returns the agents that were touched — for a default preset that is
   * already installed this is the existing record (not null), so callers
   * can log "1 preset present" but should not assume it was just created.
   * Use {@link getPresetAgents} before/after to detect actual new installs.
   */
  installDefaultPresets(defaultModel?: string): Agent[] {
    const installed: Agent[] = [];
    for (const presetId of DEFAULT_PRESET_IDS) {
      const agent = this.addPresetAgent(presetId, defaultModel);
      if (agent) installed.push(agent);
    }
    return installed;
  }
}

/**
 * Preset IDs that ship with the packaged app and are installed
 * automatically on first launch. Other presets stay opt-in via the
 * "专家套件 → 已安装" UI.
 *
 * Update this list (and add a matching entry to `PRESET_AGENTS`) to make
 * a new preset ship by default.
 */
export const DEFAULT_PRESET_IDS: readonly string[] = ['bio-research'];
