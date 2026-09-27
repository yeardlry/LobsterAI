/**
 * Local metadata store for scheduled task origin/binding.
 * OpenClaw gateway cron.* API doesn't support custom fields,
 * so we persist origin/binding locally in SQLite.
 */
import type Database from 'better-sqlite3';

/**
 * Per-task synthetic agent config (skills picked in the task form).
 * OpenClaw's cron schema has no per-job skills field, so a task with
 * selected skills runs as a derived agent whose `agents.list` entry
 * carries the skill allowlist. The agent exists ONLY in the config-sync
 * view (never in the LobsterAI `agents` table / UI).
 */
export interface TaskAgentMeta {
  /** Stable agent id injected into OpenClaw `agents.list`. */
  agentId: string;
  /** Task display name (used as the agent name in the gateway config). */
  taskName: string;
  /** Selected skill ids → `agents.list[].skills` allowlist. */
  skillIds: string[];
}

export interface TaskMeta {
  taskId: string;
  origin: string; // JSON.stringify(TaskOrigin)
  binding: string; // JSON.stringify(ExecutionBinding)
  /** JSON.stringify(TaskAgentMeta) — present iff the task has skills selected. */
  agent?: string;
}

export class ScheduledTaskMetaStore {
  constructor(private db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL)'
    );
    // The agent column was added after the first release of this table;
    // existing installs need the ALTER (same PRAGMA pattern as sqliteStore).
    const columns = this.db
      .prepare('PRAGMA table_info(scheduled_task_meta)')
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'agent')) {
      this.db.exec('ALTER TABLE scheduled_task_meta ADD COLUMN agent TEXT');
    }
  }

  get(taskId: string): TaskMeta | null {
    const row = this.db
      .prepare('SELECT task_id, origin, binding, agent FROM scheduled_task_meta WHERE task_id = ?')
      .get(taskId) as { task_id: string; origin: string; binding: string; agent?: string | null } | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      origin: row.origin,
      binding: row.binding,
      ...(row.agent ? { agent: row.agent } : {}),
    };
  }

  set(taskId: string, origin: unknown, binding: unknown, agent?: TaskAgentMeta): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO scheduled_task_meta (task_id, origin, binding, agent) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, JSON.stringify(origin), JSON.stringify(binding), agent ? JSON.stringify(agent) : null);
  }

  /** Upsert ONLY the agent column, leaving origin/binding untouched. */
  setAgent(taskId: string, agent: TaskAgentMeta | null): void {
    const existing = this.get(taskId);
    if (!existing && agent) {
      this.db
        .prepare(
          'INSERT INTO scheduled_task_meta (task_id, origin, binding, agent) VALUES (?, ?, ?, ?)',
        )
        .run(taskId, JSON.stringify({ kind: 'manual' }), JSON.stringify({ kind: 'new_session' }), JSON.stringify(agent));
      return;
    }
    if (!existing) return;
    this.db
      .prepare('UPDATE scheduled_task_meta SET agent = ? WHERE task_id = ?')
      .run(agent ? JSON.stringify(agent) : null, taskId);
  }

  /** Parsed agent meta for a task, null when the task has no skills selected. */
  getAgent(taskId: string): TaskAgentMeta | null {
    const row = this.db
      .prepare('SELECT agent FROM scheduled_task_meta WHERE task_id = ?')
      .get(taskId) as { agent?: string | null } | undefined;
    if (!row?.agent) return null;
    try {
      const parsed = JSON.parse(row.agent) as TaskAgentMeta;
      return Array.isArray(parsed.skillIds) && typeof parsed.agentId === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  delete(taskId: string): void {
    this.db.prepare('DELETE FROM scheduled_task_meta WHERE task_id = ?').run(taskId);
  }

  list(): TaskMeta[] {
    const rows = this.db
      .prepare('SELECT task_id, origin, binding, agent FROM scheduled_task_meta')
      .all() as Array<{ task_id: string; origin: string; binding: string; agent?: string | null }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      origin: row.origin,
      binding: row.binding,
      ...(row.agent ? { agent: row.agent } : {}),
    }));
  }

  /** All tasks with a synthetic agent — feeds the config-sync agents list. */
  listAgents(): TaskAgentMeta[] {
    return this.list()
      .map((meta) => {
        if (!meta.agent) return null;
        try {
          const parsed = JSON.parse(meta.agent) as TaskAgentMeta;
          return Array.isArray(parsed.skillIds) && typeof parsed.agentId === 'string' ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter((meta): meta is TaskAgentMeta => meta !== null);
  }
}
