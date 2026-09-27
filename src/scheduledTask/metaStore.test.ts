import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { BindingKind, OriginKind } from './constants';
import { ScheduledTaskMetaStore } from './metaStore';

function createMetaStore() {
  const db = new Database(':memory:');
  return new ScheduledTaskMetaStore(db);
}

test('metaStore: ensureTable is idempotent (no error on double init)', () => {
  const db = new Database(':memory:');
  const store1 = new ScheduledTaskMetaStore(db);
  const store2 = new ScheduledTaskMetaStore(db);
  store1.set('t1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  expect(store2.get('t1')).toBeTruthy();
});

test('metaStore: set + get roundtrip preserves origin and binding', () => {
  const store = createMetaStore();
  const origin = { kind: OriginKind.IM, platform: 'telegram', conversationId: 'chat-123' };
  const binding = { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'chat-123', sessionId: 'sess-1' };

  store.set('task-1', origin, binding);
  const meta = store.get('task-1');

  expect(meta).toBeTruthy();
  expect(meta!.taskId).toBe('task-1');
  expect(JSON.parse(meta!.origin)).toEqual(origin);
  expect(JSON.parse(meta!.binding)).toEqual(binding);
});

test('metaStore: set overwrites existing record (upsert)', () => {
  const store = createMetaStore();
  store.set('task-1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  store.set('task-1', { kind: OriginKind.Legacy }, { kind: BindingKind.NewSession });

  const meta = store.get('task-1');
  expect(meta).toBeTruthy();
  expect(JSON.parse(meta!.origin)).toEqual({ kind: OriginKind.Legacy });
});

test('metaStore: get nonexistent returns null', () => {
  const store = createMetaStore();
  expect(store.get('nonexistent')).toBe(null);
});

test('metaStore: delete then get returns null', () => {
  const store = createMetaStore();
  store.set('task-1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  store.delete('task-1');
  expect(store.get('task-1')).toBe(null);
});

test('metaStore: delete nonexistent does not throw', () => {
  const store = createMetaStore();
  expect(() => store.delete('nonexistent')).not.toThrow();
});

test('metaStore: list returns all records', () => {
  const store = createMetaStore();
  store.set('task-1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  store.set('task-2', { kind: OriginKind.Legacy }, { kind: BindingKind.NewSession });
  const all = store.list();
  expect(all.length).toBe(2);
  const ids = all.map((m: any) => m.taskId).sort();
  expect(ids).toEqual(['task-1', 'task-2']);
});

test('metaStore: list on empty table returns empty array', () => {
  const store = createMetaStore();
  expect(store.list()).toEqual([]);
});

test('metaStore: origin/binding with special characters survives JSON roundtrip', () => {
  const store = createMetaStore();
  const origin = { kind: OriginKind.IM, platform: 'dingtalk', conversationId: 'acct:user:"peer&1"' };
  const binding = { kind: BindingKind.IMSession, platform: 'dingtalk', conversationId: 'acct:user:"peer&1"' };

  store.set('task-special', origin, binding);
  const meta = store.get('task-special');
  expect(meta).toBeTruthy();
  expect(JSON.parse(meta!.origin)).toEqual(origin);
  expect(JSON.parse(meta!.binding)).toEqual(binding);
});

test('metaStore: setAgent on an existing row keeps origin/binding untouched', () => {
  const store = createMetaStore();
  const origin = { kind: OriginKind.IM, platform: 'telegram', conversationId: 'chat-9' };
  const binding = { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'chat-9', sessionId: 'sess-9' };
  store.set('task-1', origin, binding);

  store.setAgent('task-1', { agentId: 'task-agent-abcd1234', taskName: '文献推进', skillIds: ['s1', 's2'] });

  const meta = store.get('task-1');
  expect(meta).toBeTruthy();
  expect(JSON.parse(meta!.origin)).toEqual(origin);
  expect(JSON.parse(meta!.binding)).toEqual(binding);
  expect(store.getAgent('task-1')).toEqual({
    agentId: 'task-agent-abcd1234',
    taskName: '文献推进',
    skillIds: ['s1', 's2'],
  });
});

test('metaStore: setAgent on a missing row seeds a default manual origin', () => {
  const store = createMetaStore();

  store.setAgent('task-new', { agentId: 'task-agent-00000000', taskName: 'T', skillIds: [] });

  expect(store.getAgent('task-new')?.agentId).toBe('task-agent-00000000');
  const meta = store.get('task-new');
  expect(meta).toBeTruthy();
  expect(JSON.parse(meta!.origin)).toEqual({ kind: OriginKind.Manual });
  expect(JSON.parse(meta!.binding)).toEqual({ kind: BindingKind.NewSession });
});

test('metaStore: setAgent(null) clears the agent, listAgents skips the row', () => {
  const store = createMetaStore();
  const agent = { agentId: 'task-agent-abcd1234', taskName: 'T', skillIds: ['s1'] };
  store.setAgent('task-1', agent);
  expect(store.listAgents()).toEqual([agent]);

  store.setAgent('task-1', null);

  expect(store.getAgent('task-1')).toBeNull();
  expect(store.listAgents()).toEqual([]);
  // The base meta row survives the agent clear.
  expect(store.get('task-1')).toBeTruthy();
});

test('metaStore: listAgents returns every task with a synthetic agent', () => {
  const store = createMetaStore();
  store.setAgent('task-1', { agentId: 'task-agent-aaaaaaaa', taskName: 'A', skillIds: ['s1'] });
  store.setAgent('task-2', { agentId: 'task-agent-bbbbbbbb', taskName: 'B', skillIds: [] });
  store.set('task-3', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });

  const agents = store.listAgents().map(a => a.agentId).sort();
  expect(agents).toEqual(['task-agent-aaaaaaaa', 'task-agent-bbbbbbbb']);
});

test('metaStore: legacy table without the agent column is migrated on construct', () => {
  // Simulate an install created before the agent column existed.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL)');
  db.prepare('INSERT INTO scheduled_task_meta VALUES (?, ?, ?)').run(
    'task-legacy',
    JSON.stringify({ kind: OriginKind.Manual }),
    JSON.stringify({ kind: BindingKind.NewSession }),
  );

  const store = new ScheduledTaskMetaStore(db);

  // Existing data survived the ALTER, and agent methods work post-migration.
  expect(store.get('task-legacy')).toBeTruthy();
  expect(store.getAgent('task-legacy')).toBeNull();
  store.setAgent('task-legacy', { agentId: 'task-agent-cccccccc', taskName: 'L', skillIds: ['s9'] });
  expect(store.getAgent('task-legacy')?.skillIds).toEqual(['s9']);
});
