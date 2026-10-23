import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chinese } from '../src/shared/i18n.ts';
import { claimOwnership, createTeam, joinTeam, noteMemberEvent, readMembers } from '../src/team/io/registry.ts';
import { registerTeam } from '../src/team/commands/register.ts';
import { teamMenu } from '../src/team/commands/menu.ts';
import { recordPanels } from './fixtures/public-host.ts';
import { closePanel as closeMountedPanel } from '../src/shared/ui/menu.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { fileURLToPath } from 'node:url';

const workspace = '/tmp/team-workspace';

function host(root: string, sessionId = 'self-1') {
  const handlers = new Map<string, Function[]>(), notices: { message: string; level: string }[] = [], tools: string[] = [];
  const branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool: { name: string }) { tools.push(tool.name); }, registerCommand() {}, registerMessageRenderer() {}, registerFlag() {}, getFlag() { return undefined; },
    appendEntry(type: string, data: unknown) { if (data === undefined) { const last = [...branch].reverse().find(entry => entry.customType === type); if (last) branch.splice(branch.indexOf(last), 1); } else branch.push({ customType: type, data }); },
    sendMessage() {}, setSessionName() {},
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: 'tui',
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch, getSessionFile: () => undefined },
    ui: { notify: (message: string, level = 'info') => notices.push({ message, level }), setWidget() {}, theme: new Proxy({}, { get: () => (text: string) => text }) },
  };
  return { pi, ctx, notices, tools, branch };
}

async function agentDir(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'team-rebuild-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/** A real started child: it records how it was invoked and stays up, like an RPC member would. */
function fakeSpawn(record: { command: string; args: string[]; options: any }[]) {
  return ((command: string, args: string[], options: any) => {
    record.push({ command, args, options });
    return { pid: 9_100_001, exitCode: null, signalCode: null, unref() {}, on() {}, kill() { return true; } };
  }) as any;
}

const launchDeps = (record: { command: string; args: string[]; options: any }[]) => ({
  spawn: fakeSpawn(record),
  adapters: { tmux: true, graphical: false } as any,
  mkfifo: (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ''); },
  openFifo: () => 'ignore' as const,
  settleMs: 20,
  ownedRuntimeFile: async () => true,
});

/**
 * A team whose `Probe` member is a confirmed-exited record with a recorded file fact, plus the current
 * session joined so the panel has a writer. Everything is written through the production writers.
 */
async function world(t: { after(fn: () => unknown): void }, file: 'null' | 'present' | 'unknown' | string, options: { pid?: number; alive?: (pid: number) => boolean } = {}) {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const pid = options.pid ?? 9_000_001;
  await joinTeam(team.id, { sessionId: 'sid-probe', sessionName: 'Probe', pid, now: 1_000 });
  let sessionFile: string | null | undefined;
  if (file === 'null') sessionFile = null;
  else if (file === 'unknown') sessionFile = undefined;
  else sessionFile = file;
  // The boundary writer is the only thing that may record the fact, and only under the holder pid.
  await noteMemberEvent(team.id, 'sid-probe', { ownerPid: pid, alive: false, background: true, ...(sessionFile === undefined ? {} : { sessionFile }) });
  const h = host(workspace);
  const spawns: { command: string; args: string[]; options: any }[] = [];
  const registration = registerTeam(h.pi, {
    msg: chinese,
    ...(options.alive ? { alive: options.alive } : { alive: () => false }),
    launchDeps: launchDeps(spawns),
    wait: async () => {},
  });
  await registration.join(h.ctx, 'Alpha');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: (await readMembers(team.id)).find(member => member.sessionId === 'self-1')!.name });
  return { root, team, h, registration, spawns };
}

/** Mount the real panel and return its row list, driven through the recorded component. */
async function panelRows(w: Awaited<ReturnType<typeof world>>) {
  const memory = new Map();
  const panel = { register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => memory } as any;
  const panels = recordPanels(w.h.ctx);
  const opening = teamMenu(w.h.ctx, {
    msg: chinese, panel, currentTeamId: () => w.team.id, setCurrentTeam: () => {},
    pointer: w.registration.pointer, join: w.registration.join, leave: w.registration.leave, takeover: w.registration.takeover, switchTo: w.registration.switchTo,
    create: w.registration.create, launch: w.registration.launch, evict: w.registration.evict, stop: w.registration.stop, deleteSession: w.registration.deleteSession,
    rebuild: w.registration.rebuild, sessionFileState: w.registration.sessionFileState,
    desktop: w.registration.desktop, setDesktop: w.registration.setDesktop, history: w.registration.history, resumeCommand: w.registration.resumeCommand,
    pid: w.registration.pid, ...(w.registration.alive ? { alive: w.registration.alive } : {}), renameSession: () => {},
  });
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focused = () => panels.frame().find((line: string) => /^[ │]*> /.test(line)) ?? '';
  const focus = async (word: string) => {
    for (const key of ['j', 'k']) for (let step = 0; step < 80; step += 1) {
      if (focused().includes(word)) return;
      await panels.press(key);
    }
    throw new Error(`row not found: ${word}\n${frame()}`);
  };
  // Existing rebuild scenarios now reach the same actions through the member's expandable start menu.
  // The zone scrolls, so a row is docked by walking to it rather than by looking at one frame.
  const expand = async (...words: string[]) => { for (const word of words) { try { await focus(word); } catch { continue; } await panels.press('l'); return word; } return undefined; };
  if (await expand('Probe')) { await expand('会话操作'); await expand('重建空白会话', '启动会话'); }
  const close = async () => { await closeMountedPanel(w.h.ctx); await opening; };
  return { panels, frame, focus, close };
}

test('ticket52 a confirmed-exited member with no file gets the five rebuild rows instead of pull-ups', async t => {
  const w = await world(t, 'null');
  const rows = await panelRows(w);
  // The member and its start menu are already expanded by panelRows above.
  for (const mode of ['后台', '分屏', 'tmux 新窗口', '桌面窗口', '复制']) {
    await rows.focus(`重建空白 · ${mode}`);
    assert.equal(rows.frame().includes('找不到它的会话文件'), true, `${mode}: the confirmation names the missing file`);
    assert.equal(rows.frame().includes('再按一次确认重建'), true, `${mode}: it is a two-press row`);
  }
  // Every launch row for that member is a rebuild row; the plain pull-up label only survives inside it.
  assert.equal(rows.frame().split('\n').filter(line => line.includes('后台拉起')).every(line => line.includes('重建空白')), true, 'no plain pull-up row is left for that member');
  await rows.close();
});

test('ticket52 a member whose file is present keeps the pull-up rows and never offers a rebuild', async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-rebuild-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'sessions', 'p', 'sid-probe.jsonl');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, sessionId: 'sid-probe' })}\n`);
  const w = await world(t, file);
  const rows = await panelRows(w);
  // The member and its start menu are already expanded by panelRows above.
  await rows.focus('后台拉起');
  assert.equal(rows.frame().includes('重建空白'), false, 'a member with a file is never offered a rebuild');
  assert.equal(rows.frame().includes('--session sid-probe'), true, 'the normal pull-up still continues the session');
  await rows.close();
});

test('ticket52 a permission error or an unknown fact errors instead of rebuilding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-rebuild-perm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sessions', 'p');
  const file = join(directory, 'sid-probe.jsonl');
  await mkdir(directory, { recursive: true });
  await writeFile(file, '{"type":"session"}\n');
  const w = await world(t, file);
  try {
    // A plain unreadable file still *is* a file: the record says it is there, so no rebuild is offered.
    await chmod(file, 0o000);
    assert.equal(await w.registration.sessionFileState(w.h.ctx, 'sid-probe'), 'present', 'the record still says the file is there');
    await assert.rejects(w.registration.rebuild(w.h.ctx, 'Alpha', 'Probe', 'copy'), /会话文件还在/);
    // An unsearchable parent directory makes the check itself fail: that is "unknown", never "gone".
    await chmod(directory, 0o000);
    assert.equal(await w.registration.sessionFileState(w.h.ctx, 'sid-probe'), 'unknown', 'a refused read is not proof of absence');
    await assert.rejects(w.registration.rebuild(w.h.ctx, 'Alpha', 'Probe', 'copy'), /无法确认这个成员的会话文件是否存在/);
    assert.deepEqual(w.spawns, [], 'nothing was spawned');
  } finally {
    await chmod(directory, 0o700);
    await chmod(file, 0o600);
  }
  // An older record without the fact is "unknown", which is also never a rebuild.
  const unknownWorld = await world(t, 'unknown');
  assert.equal(await unknownWorld.registration.sessionFileState(unknownWorld.h.ctx, 'sid-probe'), 'unknown');
  await assert.rejects(unknownWorld.registration.rebuild(unknownWorld.h.ctx, 'Alpha', 'Probe', 'copy'), /无法确认这个成员的会话文件是否存在/);
});
test('ticket52 a live old process keeps the rebuild away', async t => {
  const alivePids = new Set<number>([9_000_002]);
  const w = await world(t, 'null', { pid: 9_000_002, alive: pid => alivePids.has(pid) });
  const rows = await panelRows(w);
  // The member and its start menu are already expanded by panelRows above.
  await rows.focus('复制拉起命令');
  assert.equal(rows.frame().includes('重建空白'), false, 'a live old process is not a rebuild case');
  await rows.close();
  await assert.rejects(w.registration.rebuild(w.h.ctx, 'Alpha', 'Probe', 'copy'), /旧进程（pid 9000002）仍在运行/);
  assert.deepEqual(w.spawns, []);
});

test('ticket52 the panel rebuild really reserves the same SID and never resumes the old session', async t => {
  const w = await world(t, 'null');
  const rows = await panelRows(w);
  // The member and its start menu are already expanded by panelRows above.
  await rows.focus('重建空白 · 复制');
  // The first press only arms the row: nothing is launched yet.
  await rows.panels.press('\r');
  assert.equal(w.spawns.length, 0, 'arming launches nothing');
  await rows.panels.press('\r');
  await rows.panels.wait(() => w.h.notices.some(item => /重建/.test(item.message)));
  const notice = w.h.notices.map(item => item.message).join('\n');
  assert.match(notice, /不恢复旧上下文/, 'the copy hint says the old context is not restored');
  const result = await w.registration.rebuild(w.h.ctx, 'Alpha', 'Probe', 'copy');
  assert.match(result.plan!.command, /--session-id 'sid-probe'/, 'a rebuild reserves the member SID with --session-id');
  assert.doesNotMatch(result.plan!.command, /--session '/, 'and never resumes with --session');
  await rows.close();
});

test('ticket52 a rebuild refuses when the representative changed between the two presses', async t => {
  const alivePids = new Set<number>();
  const w = await world(t, 'null', { alive: pid => alivePids.has(pid) });
  const rows = await panelRows(w);
  // The member and its start menu are already expanded by panelRows above.
  await rows.focus('重建空白 · 后台');
  await rows.panels.press('\r');                       // arm
  // Between the presses the record changes hands: the second press must refuse, not overwrite.
  await claimOwnership(w.team.id, 'sid-probe', { pid: 9_000_009, now: 2_000, force: true });
  alivePids.add(9_000_009);
  await rows.panels.press('\r');
  for (let step = 0; step < 60 && !w.h.notices.some(item => /仍在运行/.test(item.message)); step += 1) await delay(50);
  assert.equal(w.h.notices.some(item => /仍在运行/.test(item.message)), true, 'the second press refused: ' + w.h.notices.map(item => item.message).join(' | '));
  assert.deepEqual(w.spawns, [], 'nothing spawned after the takeover');
  assert.equal((await readMembers(w.team.id)).find(member => member.sessionId === 'sid-probe')!.holder.pid, 9_000_009, 'the new representative is untouched');
  await rows.close();
});

test('ticket52 two rebuilds of one SID serialise on the SID lock and only the first one runs', async t => {
  const alivePids = new Set<number>();
  const w = await world(t, 'null', { alive: pid => alivePids.has(pid) });
  const first = w.registration.rebuild(w.h.ctx, 'Alpha', 'Probe', 'copy');
  // While the first rebuild holds the SID lock, the record gains a live holder (what a real child would do).
  await delay(20);
  await claimOwnership(w.team.id, 'sid-probe', { pid: 9_000_010, now: 3_000, force: true });
  alivePids.add(9_000_010);
  const second = w.registration.rebuild(w.h.ctx, 'Alpha', 'Probe', 'copy');
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, 'fulfilled', 'the first rebuild was allowed through');
  assert.equal(secondResult.status, 'rejected', 'the second saw the new live holder and refused');
  assert.match(String((secondResult as PromiseRejectedResult).reason), /仍在运行/);
});

test('ticket52 real Pi: a reserved SID starts empty and only writes a file after a real turn', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-rebuild-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agent'), { recursive: true });
  // The whole run lives under this temporary agent root: the record and the file both land here.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const { createTeam: create } = await import('../src/team/io/registry.ts');
  const team = await create({ name: 'Alpha', workspaceRoot: root });
  const sessionId = 'rebuild-sid';
  const entries = ['todos', 'plan', 'agents', 'goal', 'retry', 'team'].map(name => fileURLToPath(new URL(`../src/${name}/index.ts`, import.meta.url)));
  // This is exactly what a rebuild asks for: the member's SID reserved with --session-id, no --session.
  const client = await IsolatedClient.start(root, sessionId, [], ['--team', 'Alpha', '--name', 'Probe'], false, entries);
  try {
    const state = (await client.send('get_state')).data as any;
    assert.equal(state.sessionId ?? state.session?.sessionId, sessionId, 'the process reports the reserved session id');
    // Before it speaks there is no conversation: whatever file the SDK may have reserved carries no turn.
    const before = (await readMembers(team.id)).find(item => item.sessionId === sessionId);
    assert.ok(before, 'the member record exists from session_start alone');
    const reserved = before.sessionFile;
    assert.equal(reserved === null || !existsSync(reserved ?? ''), true, `an idle member has no saved conversation (${String(reserved)})`);
    assert.deepEqual(await messageCounts(root), [], 'and no saved file holds a message yet');
    await client.prompt('第一次真实对话');
    const after = (await readMembers(team.id)).find(item => item.sessionId === sessionId)!;
    assert.equal(typeof after.sessionFile, 'string', 'after a real turn the record carries the SDK session file');
    assert.equal(existsSync(after.sessionFile!), true, 'and that path really exists');
    assert.equal(after.sessionFile!.endsWith(`${sessionId}.jsonl`), true, 'the saved file belongs to the same SID');
    // The process wrote no turn of its own: exactly the test's user turn, plus the model's reply.
    const counts = await messageCounts(root);
    assert.deepEqual(counts, [{ user: 1, assistant: 1 }], 'exactly one user turn and one reply, nothing invented');
  } finally { await client.close(); }
});

/** How many user and assistant turns every saved session under the temporary root holds. */
async function messageCounts(root: string): Promise<{ user: number; assistant: number }[]> {
  const { readFile } = await import('node:fs/promises');
  const counts: { user: number; assistant: number }[] = [];
  for (const path of await readSessions(root)) {
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type?: string; message?: { role?: string } });
    counts.push({
      user: lines.filter(line => line.type === 'message' && line.message?.role === 'user').length,
      assistant: lines.filter(line => line.type === 'message' && line.message?.role === 'assistant').length,
    });
  }
  return counts;
}
async function readSessions(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const base = join(root, 'sessions');
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  // Pi may keep the file straight under the sessions root or one project directory deeper.
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(base, entry.name));
    if (entry.isDirectory()) for (const file of await readdir(join(base, entry.name)).catch(() => [])) if (file.endsWith('.jsonl')) files.push(join(base, entry.name, file));
  }
  return files;
}
