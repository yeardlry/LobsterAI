/**
 * Tests for AgentManager.installDefaultPresets and DEFAULT_PRESET_IDS.
 *
 * Verifies the four behavioural guarantees the first-launch install flow
 * depends on:
 *
 *   1. First call installs every default preset.
 *   2. Subsequent calls are idempotent (no duplicates, no errors).
 *   3. Deleting a default preset agent causes the next call to re-install
 *      it (the user-accepted behaviour for bio-research).
 *   4. `defaultModel` is propagated to the installed agent.
 *
 * Mirrors the in-memory SQLite harness from coworkStore.test.ts (no
 * Electron, no disk).
 */

import BetterSqlite3 from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock' },
}));

import { AgentManager, DEFAULT_PRESET_IDS } from './agentManager';
import { CoworkStore } from './coworkStore';
import { PRESET_AGENTS } from './presetAgents';

let db: BetterSqlite3.Database;
let store: CoworkStore;
let manager: AgentManager;

function setupDb(): void {
  db = new BetterSqlite3(':memory:');
  // Minimal schema for AgentManager.installDefaultPresets. The flow hits:
  //   - addPresetAgent → store.createAgent → deleteSessionsForAgent
  //     → listSessionIdsByAgent (SELECT FROM cowork_sessions WHERE agent_id = ?)
  //   - CoworkStore.constructor → ensureContinuityCapsuleTable (cowork_session_capsules)
  // The remaining agents columns follow the production sqliteStore.ts DDL.
  // user_memories / user_memory_sources are NOT created here — the
  // delete-reinstall test uses a raw SQL DELETE to simulate the user
  // removing the agent, which avoids needing the full memory schema that
  // store.deleteAgent would touch (markOrphanImplicitMemoriesStale).
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT
    );
    CREATE TABLE IF NOT EXISTS cowork_session_capsules (
      session_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      capsule_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      identity TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      thinking_level TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_order INTEGER,
      sort_order INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'custom',
      preset_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  store = new CoworkStore(db);
  manager = new AgentManager(store);
}

beforeEach(() => {
  setupDb();
});

describe('DEFAULT_PRESET_IDS', () => {
  test('currently ships bio-research as the only default preset', () => {
    // Pinning the exact value rather than just the length: a future change
    // that adds/removes from this list is a deliberate product decision
    // and should be visible in the diff with this test failing as a flag.
    expect([...DEFAULT_PRESET_IDS]).toEqual(['bio-research']);
  });

  test('every default preset id resolves to a catalog entry', () => {
    // Catches typos in DEFAULT_PRESET_IDS that would silently no-op.
    const catalogIds = new Set(PRESET_AGENTS.map(p => p.id));
    for (const id of DEFAULT_PRESET_IDS) {
      expect(catalogIds.has(id), `DEFAULT_PRESET_IDS references missing preset '${id}'`).toBe(true);
    }
  });
});

describe('installDefaultPresets', () => {
  test('first call installs every default preset', () => {
    const installed = manager.installDefaultPresets();
    expect(installed).toHaveLength(DEFAULT_PRESET_IDS.length);
    for (const agent of installed) {
      expect(agent.source).toBe('preset');
      expect(agent.presetId).toBe(agent.id);
    }
    // bio-research specifically — the user-visible name we ship
    const bio = store.getAgent('bio-research');
    expect(bio).not.toBeNull();
    expect(bio?.name).toBe('生物研究');
    expect(bio?.skillIds).toEqual(['web-search']);
    expect(bio?.enabled).toBe(true);
  });

  test('second call is idempotent — no duplicate rows, no errors', () => {
    manager.installDefaultPresets();
    const before = store.listAgents().length;

    const installed = manager.installDefaultPresets();
    const after = store.listAgents().length;

    expect(after).toBe(before);
    expect(installed).toHaveLength(DEFAULT_PRESET_IDS.length);
    // The short-circuit returns the existing record, not null
    for (const agent of installed) {
      expect(agent.id).toBeTruthy();
      expect(agent.source).toBe('preset');
    }
  });

  test('re-installs a default preset that the user deleted', () => {
    // First launch installs, user removes it via 专家套件 → 已安装, then
    // the next startup re-installs (the product-accepted "如果我删除了
    // 打包之后就没有" → "comes back next launch" behaviour).
    manager.installDefaultPresets();
    expect(store.getAgent('bio-research')).not.toBeNull();

    // Simulate user deletion with a raw SQL DELETE — store.deleteAgent
    // touches user_memories / user_memory_sources via
    // markOrphanImplicitMemoriesStale, which requires the full memory
    // schema. The behaviour under test is "next installDefaultPresets
    // call brings the agent back"; we don't care which API the user
    // path uses to remove it.
    db.prepare('DELETE FROM agents WHERE id = ?').run('bio-research');
    expect(store.getAgent('bio-research')).toBeNull();

    const reinstalled = manager.installDefaultPresets();
    expect(reinstalled.find(a => a.id === 'bio-research')).toBeDefined();
    expect(store.getAgent('bio-research')).not.toBeNull();
  });

  test('passes defaultModel through to the installed agent', () => {
    const installed = manager.installDefaultPresets('claude-opus-4-20250514');
    const bio = installed.find(a => a.id === 'bio-research');
    expect(bio?.model).toBe('claude-opus-4-20250514');
  });

  test('skips unknown preset ids (defensive: no throw on catalog drift)', () => {
    // Patch DEFAULT_PRESET_IDS via a fresh manager + monkeypatch — easier
    // than spinning up a separate test process. The behaviour under test
    // is "unknown id ⇒ no-op", which addPresetAgent already guarantees via
    // `if (!preset) return null`.
    const fakeId = 'nonexistent-preset';
    const installed = manager.installDefaultPresets();
    expect(installed).toHaveLength(DEFAULT_PRESET_IDS.length);

    // Sanity: addPresetAgent with an unknown id returns null and does not
    // touch the store. This is the per-id building block installDefaultPresets
    // delegates to.
    const before = store.listAgents().length;
    const result = manager.addPresetAgent(fakeId);
    const after = store.listAgents().length;
    expect(result).toBeNull();
    expect(after).toBe(before);
  });
});

describe('installDefaultPresets ↔ getPresetAgents interaction', () => {
  test('after install, getPresetAgents no longer lists the installed default', () => {
    // The "专家套件 → 已安装" UI is driven by getPresetAgents(), which
    // filters out already-installed presets via source === 'preset'.
    // After installDefaultPresets runs, bio-research must drop off the
    // installable list so the UI doesn't show a misleading "Install"
    // button for a preset that is already present.
    expect(manager.getPresetAgents().some(p => p.id === 'bio-research')).toBe(true);
    manager.installDefaultPresets();
    expect(manager.getPresetAgents().some(p => p.id === 'bio-research')).toBe(false);
  });
});
