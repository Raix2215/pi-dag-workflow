import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGoal } from '../src/goal/register.ts';
import { registerAgents, AGENTS_TYPE } from '../src/agents/register.ts';
import { emptyGoalState, GOAL_TYPE } from '../src/goal/state.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { fragmentContext } from '../src/agents/context.ts';
import { readConfigText, readConfigTextSync } from '../src/shared/config-file.ts';
import { defaultConfig } from '../src/shared/config.ts';
import { emptyState, newlyReady, type Todo } from '../src/todos/state.ts';

function host() {
  const events = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  let entries: any[] = []; const notifications: string[] = [];
  const pi: any = { on(n: string, f: Function) { events.set(n, [...events.get(n) ?? [], f]); }, registerTool(t: any) { tools.set(t.name, t); }, registerCommand(n: string, c: any) { commands.set(n, c); }, registerFlag() {}, getFlag() {}, appendEntry(t: string, d: unknown) { entries.push({ type: 'custom', customType: t, data: d }); }, sendMessage() {}, sendUserMessage() {} };
  const ctx: any = { hasUI: true, cwd: '.', isIdle: () => false, sessionManager: { getBranch: () => entries }, modelRegistry: { find: () => undefined }, ui: { notify: (message: string) => notifications.push(message), confirm: async () => true } };
  const fire = async (n: string, event: any = {}) => { for (const f of events.get(n) ?? []) await f(event, ctx); };
  return { pi, ctx, commands, tools, notifications, fire, entries: () => entries, setEntries: (next: any[]) => { entries = next; } };
}
const goalRecord = (title: string) => ({ type: 'custom', customType: GOAL_TYPE, data: { ...emptyGoalState(), nextId: 2, goals: [{ id: 1, title, status: 'paused', maxTurns: 32, createdAt: 1 }] } });

test('old Goal reset confirmation cannot clear the newly selected branch', async (t) => {
  const h = host(); const controller = registerGoal(h.pi, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {}, loadConfig: async () => defaultConfig() });
  t.after(() => h.fire('session_shutdown'));
  let answer!: (value: boolean) => void; h.ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; });
  const resetting = h.commands.get('goal').handler('reset', h.ctx);
  h.setEntries([goalRecord('New branch objective')]); await h.fire('session_tree');
  answer(true); await resetting;
  assert.equal(controller.snapshot().goals[0]!.title, 'New branch objective');
  h.ctx.ui.confirm = async () => true; await h.commands.get('goal').handler('reset', h.ctx);
  assert.deepEqual(controller.snapshot().goals, [], 'a current confirmation still resets');
});

test('Goal reset dialogs are invalidated before navigation can change the branch', async (t) => {
  for (const navigation of ['session_before_switch', 'session_before_fork', 'session_before_tree']) {
    const h = host(); const controller = registerGoal(h.pi, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {}, loadConfig: async () => defaultConfig() });
    t.after(() => h.fire('session_shutdown'));
    h.setEntries([goalRecord('Keep objective')]); await h.fire('session_tree');
    let answer!: (value: boolean) => void; h.ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; });
    const reset = h.commands.get('goal').handler('reset', h.ctx); await h.fire(navigation); answer(true); await reset;
    assert.equal(controller.snapshot().goals[0]!.title, 'Keep objective', navigation);
  }
});

test('obsolete Goal config restore errors cannot replace newer branch state', async (t) => {
  const h = host(); let rejectOld!: (error: Error) => void; let calls = 0;
  const controller = registerGoal(h.pi, { state: emptyState, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {}, loadConfig: () => ++calls === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(defaultConfig()) });
  t.after(() => h.fire('session_shutdown'));
  h.setEntries([goalRecord('Old')]); const old = h.fire('session_tree'); await Promise.resolve();
  h.setEntries([goalRecord('New')]); await h.fire('session_tree');
  rejectOld(new Error('obsolete config error')); await old;
  assert.equal(controller.snapshot().goals[0]!.title, 'New'); assert.equal(h.notifications.some((text) => text.includes('obsolete config error')), false);
});

test('old Agent reset confirmation cannot clear newly restored job records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-reset-guard-')); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = host(); h.ctx.cwd = root;
  const controller = registerAgents(h.pi, { state: emptyState, mutate() {}, paint() {}, protected: () => false });
  t.after(async () => { await h.fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await h.fire('session_start'); let answer!: (value: boolean) => void;
  h.ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; }); const resetting = h.commands.get('agents').handler('reset', h.ctx);
  h.setEntries([{ type: 'custom', customType: AGENTS_TYPE, data: { version: 1, nextId: 8, jobs: [{ id: 'a7', profile: 'inherit', model: { provider: 'fixture', id: 'model' }, thinking: 'off', tools: ['read'], status: 'completed', startedAt: 1, endedAt: 2, pendingRequests: 0, output: 'New branch report' }] } }]);
  await h.fire('session_tree'); answer(true); await resetting;
  assert.equal(controller.summaries()[0]!.id, 'a7');
  h.ctx.ui.confirm = async () => true; await h.commands.get('agents').handler('reset', h.ctx); assert.deepEqual(controller.summaries(), []);
});

test('obsolete Agent journal imports cannot replace a newer Agent restoration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-restore-guard-')); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const original = AgentRuntime.prototype.importSummaries; let release!: () => void; let calls = 0;
  AgentRuntime.prototype.importSummaries = async function (...args) { if (++calls === 1) await new Promise<void>((resolve) => { release = resolve; }); return original.apply(this, args); };
  const h = host(); h.ctx.cwd = root; let paints = 0; registerAgents(h.pi, { state: emptyState, mutate() {}, paint() { paints++; }, protected: () => false });
  t.after(async () => { AgentRuntime.prototype.importSummaries = original; await h.fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const old = h.fire('session_start'); const deadline = Date.now() + 1000;
  while (!release) { assert.ok(Date.now() < deadline, 'restore must reach journal import'); await new Promise((resolve) => setTimeout(resolve, 1)); }
  await h.fire('session_tree'); const paintsBefore = paints;
  release(); await old;
  assert.equal(paints, paintsBefore, 'an obsolete restore cannot paint or replace the current runtime');
  assert.equal((await h.tools.get('subagent_inspect').execute('probe', {}, undefined, undefined, h.ctx)).isError, undefined);
});

test('Profile save limits match load limits and preserve an existing file on rejection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-profile-limits-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'profiles.json'); const profiles = new ProfileStore({ path, registry: { find: () => ({}) } });
  profiles.set({ name: 'p0' }); await profiles.save(); const before = await readFile(path);
  for (let i = 1; i < 64; i++) profiles.set({ name: `p${i}` });
  assert.throws(() => profiles.set({ name: 'p64' }), /at most 64/); assert.equal(profiles.list().length, 64);
  profiles.set({ name: 'p63', instructions: 'replacement' });
  for (let i = 0; i < 40; i++) profiles.set({ name: `p${i}`, instructions: 'x'.repeat(2000) });
  await assert.rejects(profiles.save(), /64 KiB/); assert.deepEqual(await readFile(path), before);
  await profiles.load(); assert.deepEqual(profiles.list(), [{ name: 'p0' }]);
});

test('configuration readers enforce byte boundaries, UTF-8 and native missing-file errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-config-limit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  for (const source of ['x'.repeat(32), '中文'.repeat(5)]) {
    await writeFile(path, source); const size = Buffer.byteLength(source);
    assert.equal(await readConfigText(path, size, 'too large'), source); assert.equal(readConfigTextSync(path, size, 'too large'), source);
    await assert.rejects(readConfigText(path, size - 1, 'too large'), /too large/); assert.throws(() => readConfigTextSync(path, size - 1, 'too large'), /too large/);
  }
  await writeFile(path, Buffer.alloc(32, 255)); await assert.rejects(readConfigText(path, 32, 'too large'), /too large/); assert.throws(() => readConfigTextSync(path, 32, 'too large'), /too large/);
  await assert.rejects(readConfigText(join(root, 'missing'), 32, 'too large'), { code: 'ENOENT' });
});

test('growing configurations stay readable up to the limit but never read or allocate beyond limit + 1', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-config-growth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json'); await writeFile(path, 'small');
  const probe = await open(path, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalStat = prototype.stat, originalRead = prototype.read; const allocations: number[] = []; let growTo = 8192;
  prototype.stat = async function (...args: unknown[]) { const stat = await originalStat.apply(this, args); await writeFile(path, 'x'.repeat(growTo)); return stat; };
  prototype.read = async function (...args: any[]) { allocations.push(args[0].length); return originalRead.apply(this, args); };
  t.after(() => { prototype.stat = originalStat; prototype.read = originalRead; });
  assert.equal((await readConfigText(path, 8192, 'too large')).length, 8192);
  await writeFile(path, 'small'); growTo = 8193;
  await assert.rejects(readConfigText(path, 8192, 'too large'), /too large/);
  assert.ok(allocations.length > 2); assert.ok(Math.max(...allocations) <= 8193);
});

test('unchanged Todo snapshots need no readiness scan while real completions still unlock work', () => {
  let reads = 0; const tasks: Todo[] = [{ id: 1, subject: 'Probe', get status() { reads++; return 'pending' as const; }, blockedBy: [] }];
  const state = { ...emptyState(), tasks, nextId: 2 }; assert.deepEqual(newlyReady(state, { ...state, plan: true }), []); assert.equal(reads, 0);
  const before = { ...emptyState(), tasks: [{ id: 1, subject: 'First', status: 'pending' as const, blockedBy: [] }, { id: 2, subject: 'Last', status: 'pending' as const, blockedBy: [1] }], nextId: 3 };
  const after = { ...before, tasks: before.tasks.map((task) => task.id === 1 ? { ...task, status: 'completed' as const } : task) };
  assert.deepEqual(newlyReady(before, after).map((task) => task.id), [2]);
});

test('Goal reuses readiness only for the current immutable snapshot and recomputes changed statuses', async (t) => {
  const h = host(); let reads = 0;
  const first: Todo = { id: 1, subject: 'First', status: 'completed', get blockedBy() { reads++; return []; } };
  const last: Todo = { id: 2, subject: 'Last', status: 'pending', get blockedBy() { reads++; return [1]; } };
  let state = { ...emptyState(), tasks: [first, last], nextId: 3 };
  registerGoal(h.pi, { state: () => state, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {}, loadConfig: async () => defaultConfig() });
  t.after(() => h.fire('session_shutdown'));
  const call = (params: object) => h.tools.get('goal').execute('probe', params, undefined, undefined, h.ctx);
  await call({ action: 'create', title: 'Readiness' }); await h.fire('input', { source: 'rpc', text: 'enable' }); await call({ action: 'enable', id: 1 });
  const propose = () => h.fire('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
  await propose(); const firstReads = reads; assert.ok(firstReads > 0);
  await h.fire('turn_start'); await propose(); assert.equal(reads, firstReads, 'no DAG re-read for another wake on the same task array');
  await h.fire('turn_start'); state = { ...state, tasks: [{ ...first, status: 'pending' }, last] }; const changedReads = reads;
  await propose(); assert.ok(reads > changedReads, 'changing a prerequisite status invalidates readiness');
});

test('fragment heads preserve whitespace and Unicode semantics without requiring the full report', () => {
  const tasks: Todo[] = [{ id: 1, subject: 'First', status: 'completed', blockedBy: [], metadata: { preset: 'probe', run: 1, key: 'first', step: 1 } }, { id: 2, subject: 'Last', status: 'pending', blockedBy: [1], metadata: { preset: 'probe', run: 1, key: 'last', step: 2 } }];
  for (const output of ['   short\n\ttext   ', 'a'.repeat(200) + ' '.repeat(5000), ' '.repeat(5000) + 'a '.repeat(1000), '𐐀'.repeat(1500), 'a'.repeat(199) + '𐐀tail', 'first\u00a0second ' + 'x'.repeat(10000)]) {
    const flat = output.replace(/\s+/g, ' ').trim(); let expected = flat.slice(0, 200); if (/[\uD800-\uDBFF]/.test(expected.at(-1) ?? '')) expected = expected.slice(0, -1);
    assert.ok(fragmentContext(2, tasks, [{ todoId: 1, status: 'completed', output }])!.includes(`- first (done): ${expected}${flat.length > 200 ? '…' : ''}`));
  }
  assert.doesNotMatch(fragmentContext(2, tasks, [{ todoId: 1, status: 'completed', output: '𐐀HIDDEN', outputStart: 1 }])!, /HIDDEN/);
});
