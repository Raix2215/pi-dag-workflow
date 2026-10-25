import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { registerTeam } from '../src/team/commands/register.ts';
import { TEAM_MEMBERSHIP_MESSAGE } from '../src/shared/message-types.ts';
import { configPaths } from '../src/shared/config.ts';
import { assignLead, createTeam, joinTeam, renameMember, teamsRoot } from '../src/team/io/registry.ts';

const pointerType = 'pi-dag-workflow.team-pointer';

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'team-membership-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(configPaths().directory, join(root, 'pi-dag-workflow'));
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'));
  const manager = SessionManager.inMemory(root);
  const team = await createTeam({ name: 'Fixture', workspaceRoot: root });
  const sid = manager.getSessionId();
  await joinTeam(team.id, { sessionId: sid, sessionName: 'Self', pid: process.pid, now: 1 });
  await joinTeam(team.id, { sessionId: 'peer', sessionName: 'Peer', pid: process.pid, now: 1 });
  manager.appendCustomEntry(pointerType, { teamId: team.id, memberName: 'Self' });
  return { root, manager, team, sid };
}

// Real branch projection and registered Team assembly. Like Pi, a context-only send during a run
// waits until the assistant and all tool results have been persisted, not the current request.
function host(manager: SessionManager) {
  const handlers = new Map<string, Function[]>(), pending: any[] = [], sent: any[] = [];
  let clock = 100;
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerFlag() {}, getFlag() {}, registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
    sendMessage(message: any, options: any) {
      assert.equal(options.triggerTurn, false, 'membership must not start a model turn');
      pending.push(message); sent.push(message);
    },
  };
  const ctx: any = { cwd: manager.getCwd(), isIdle: () => false, sessionManager: manager, ui: { notify() {}, setWidget() {} } };
  registerTeam(pi, { now: () => ++clock, alive: () => true });
  const request = async () => {
    let messages = manager.buildSessionProjection().messages;
    for (const handler of handlers.get('context') ?? []) messages = (await handler({ messages }, ctx))?.messages ?? messages;
    return structuredClone(messages) as any[];
  };
  const flush = () => {
    for (const message of pending.splice(0)) manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  };
  const roundtrip = (index: number) => {
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { path: 'fixture' } }], api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1_000 + index * 2 });
    manager.appendMessage({ role: 'toolResult', toolCallId: `call-${index}`, toolName: 'read', content: [{ type: 'text', text: `result-${index}` }], isError: false, timestamp: 1_001 + index * 2 });
    flush();
  };
  const tree = async () => { for (const handler of handlers.get('session_tree') ?? []) await handler({}, ctx); };
  return { request, roundtrip, flush, sent, tree };
}

const snapshots = (messages: any[]) => messages.filter(message => message.role === 'custom' && message.customType === TEAM_MEMBERSHIP_MESSAGE);
const identity = (messages: any[]) => { const text = snapshots(messages).at(-1)!.content; return JSON.parse(text.slice(text.indexOf('{'))); };
const prefix = (before: any[], after: any[]) => assert.deepEqual(after.slice(0, before.length), before, 'actual registered context output must be a JSON-equal prefix after a tool roundtrip');

// These unconditional comparisons kill both floating-tail injection and activity fields leaking into identity.
test('ticket77 registered membership is append-stable across delayed persistence and volatile roster updates', async t => {
  const f = await fixture(t), h = host(f.manager);
  f.manager.appendCustomMessageEntry(TEAM_MEMBERSHIP_MESSAGE, 'Joined obsolete team as Obsolete', false);
  f.manager.appendMessage({ role: 'user', content: 'start', timestamp: 10 });
  let before = await h.request();
  assert.equal(snapshots(before).length, 1, 'old join notifications are never current identity');
  assert.equal(identity(before).member, 'Self');
  for (let index = 0; index < 6; index++) {
    const path = join(teamsRoot(), f.team.id, 'members', `${f.sid}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...record, busy: index % 2 === 0, retrying: index % 2 === 1, lastActivityAt: 20_000 + index, state: index % 2 === 0 ? 'headless' : 'attached' }));
    h.roundtrip(index);
    const after = await h.request();
    prefix(before, after);
    assert.equal(snapshots(after).length, 1);
    assert.equal(h.sent.length, 1, 'unchanged identity is persisted only once');
    before = after;
  }
  const roster = identity(before).roster;
  assert.deepEqual(Object.keys(roster[0]).sort(), ['name', 'sessionId']);
});

test('ticket77 identity changes append exactly one snapshot, including departure and stale pointers', async t => {
  const f = await fixture(t), h = host(f.manager);
  f.manager.appendMessage({ role: 'user', content: 'start', timestamp: 10 });
  let before = await h.request();
  h.roundtrip(0);
  before = await h.request();
  for (const change of [
    async () => { await renameMember(f.team.id, f.sid, 'Renamed'); },
    async () => { await assignLead(f.team.id, 'Peer'); },
    async () => { await joinTeam(f.team.id, { sessionId: 'new', sessionName: 'New', pid: process.pid, now: 2 }); },
    async () => { f.manager.appendCustomEntry(pointerType, undefined); },
    async () => { f.manager.appendCustomEntry(pointerType, { teamId: 'missing', memberName: 'ghost' }); },
  ]) {
    const count = snapshots(before).length;
    await change();
    const changed = await h.request();
    prefix(before, changed);
    const expected = identity(before).team === null ? count : count + 1;
    assert.equal(snapshots(changed).length, expected);
    h.roundtrip(expected);
    const stable = await h.request();
    prefix(changed, stable);
    assert.equal(snapshots(stable).length, expected, 'the next request does not add the same identity again');
    before = stable;
  }
  assert.equal(identity(before).team, null);
  assert.equal(identity(before).member, null);
});

test('ticket77 repeated identical anchors keep their original occurrence across append and reload', async t => {
  const f = await fixture(t), h = host(f.manager);
  const repeated = { role: 'user' as const, content: 'identical', timestamp: 10 };
  f.manager.appendMessage(repeated);
  f.manager.appendMessage(repeated);
  const first = await h.request();
  assert.equal(first[2].customType, TEAM_MEMBERSHIP_MESSAGE, 'anchor is the second original occurrence, not the first');
  f.manager.appendMessage(repeated);
  h.flush();
  const second = await h.request();
  prefix(first, second);
  const reloaded = host(f.manager);
  assert.deepEqual(await reloaded.request(), second, 'durable occurrence survives extension reconstruction');
  assert.equal(reloaded.sent.length, 0);
});

test('ticket77 compaction never lets an appended duplicate reclaim an expired anchor or resurrect an old identity', async t => {
  const f = await fixture(t), h = host(f.manager);
  const repeated = { role: 'user' as const, content: 'expired anchor', timestamp: 10 };
  f.manager.appendMessage(repeated);
  await h.request();
  const kept = f.manager.appendMessage({ role: 'user', content: 'retained anchor', timestamp: 20 });
  h.flush(); // Native custom persistence can lag behind the next anchor.
  await renameMember(f.team.id, f.sid, 'Renamed');
  await h.request();
  h.flush();
  f.manager.appendCompaction('summary', kept, 100);
  const compacted = await h.request();
  assert.equal(identity(compacted).member, 'Renamed', 'compaction keeps snapshot chronology, even when an older anchor was removed');
  f.manager.appendMessage(repeated);
  const appended = await h.request();
  prefix(compacted, appended);
  assert.equal(identity(appended).member, 'Renamed', 'a new identical message cannot resurrect the expired old identity');
  assert.equal(h.sent.length, 2, 'surviving snapshots need no replacement');
  const reloaded = host(f.manager);
  assert.deepEqual(await reloaded.request(), appended, 'expired-anchor fallback remains stable after reload');
});

test('ticket77 compaction preserves snapshot chronology when persistence lagged across newer anchors', async t => {
  const f = await fixture(t), h = host(f.manager);
  f.manager.appendMessage({ role: 'user', content: 'removed', timestamp: 10 });
  await h.request();
  const kept = f.manager.appendMessage({ role: 'user', content: 'newer anchor', timestamp: 20 });
  await renameMember(f.team.id, f.sid, 'Renamed');
  await h.request();
  f.manager.appendMessage({ role: 'user', content: 'before native flush', timestamp: 30 });
  h.flush();
  f.manager.appendCompaction('summary', kept, 100);
  const compacted = await h.request();
  assert.deepEqual(snapshots(compacted).map(message => JSON.parse(message.content.slice(message.content.indexOf('{'))).member), ['Self', 'Renamed']);
  h.roundtrip(0);
  prefix(compacted, await h.request());
});

test('ticket77 compaction recovers a missing snapshot once, without restoring a removed anchor', async t => {
  const f = await fixture(t), h = host(f.manager);
  f.manager.appendMessage({ role: 'user', content: 'discarded anchor', timestamp: 10 });
  await h.request();
  h.roundtrip(0);
  const kept = f.manager.appendMessage({ role: 'user', content: 'kept', timestamp: 20 });
  f.manager.appendCompaction('summary', kept, 100);
  const compacted = await h.request();
  assert.equal(identity(compacted).member, 'Self', 'snapshot in the discarded branch region is not considered model-visible');
  assert.equal(snapshots(compacted).length, 1);
  h.roundtrip(1);
  prefix(compacted, await h.request());
  assert.equal(h.sent.length, 2, 'only one replacement snapshot after native compaction');
});

test('ticket77 reload and real branch navigation reconcile the first request without resurrecting old identity', async t => {
  const f = await fixture(t), first = host(f.manager);
  const fork = f.manager.appendMessage({ role: 'user', content: 'fork', timestamp: 10 });
  const initial = await first.request();
  first.roundtrip(0);
  const persisted = await first.request();
  prefix(initial, persisted);
  const resumed = host(f.manager);
  assert.deepEqual(await resumed.request(), persisted, 'reload reuses the durable snapshot, including its original position');
  assert.equal(resumed.sent.length, 0);
  await renameMember(f.team.id, f.sid, 'Restored');
  const restored = await resumed.request();
  assert.equal(identity(restored).member, 'Restored', 'resume sees current directory identity immediately');
  resumed.roundtrip(1);
  prefix(restored, await resumed.request());
  f.manager.branch(fork);
  await resumed.tree();
  const branched = await resumed.request();
  assert.equal(identity(branched).member, 'Restored', 'first request after tree does not reuse the abandoned branch snapshot');
  assert.equal(snapshots(branched).length, 1);
  resumed.roundtrip(2);
  prefix(branched, await resumed.request());
  f.manager.appendCustomEntry(pointerType, undefined);
  await resumed.tree();
  const departed = await resumed.request();
  assert.equal(identity(departed).team, null, 'old member snapshots cannot claim current membership after branch departure');
});
