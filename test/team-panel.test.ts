import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname as dirnameP, join } from 'node:path';
import { join as joinPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chinese } from '../src/shared/i18n.ts';
import { bindMemberRuntime, claimOwnership, createTeam, dissolveTeam, joinTeam, listTeams, noteMemberEvent, readMembers, renameMember, readTeam, setMemberRuntime, teamsRoot } from '../src/team/io/registry.ts';
import { cleanupRuntimeFiles, runtimePairFor, writeRuntimePid } from '../src/team/io/runtime.ts';
import { memberState } from '../src/team/domain/teams.ts';
import { sendToMember } from '../src/team/io/inbox.ts';
import { registerTeam } from '../src/team/commands/register.ts';
import { piLaunchTarget } from '../src/shared/pi-cli.ts';
import { teamExtensionPath } from '../src/team/io/launcher.ts';
import { recordPanels } from './fixtures/public-host.ts';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { closePanel as closeMountedPanel, withMenuScope } from '../src/shared/ui/menu.ts';

const workspace = '/tmp/team-workspace';
function host(root: string, sessionId = 's1') {
  const handlers = new Map<string, Function[]>(), flags = new Map<string, unknown>(), appends: { type: string; data: unknown }[] = [], sent: { message: unknown; options: unknown }[] = [], notices: { message: string; level: string }[] = [], tools = new Map<string, any>(), commands = new Map<string, any>(), renames: string[] = [];
  const branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {},
    registerFlag(name: string, options: unknown) { flags.set(name, options); },
    getFlag(name: string) { return flags.get(`value:${name}`); },
    appendEntry(type: string, data: unknown) { appends.push({ type, data }); if (data === undefined) { const last = [...branch].reverse().find(entry => entry.customType === type); if (last) branch.splice(branch.indexOf(last), 1); } else branch.push({ customType: type, data }); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
    setSessionName(name: string) { renames.push(name); },
  };
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch }, ui: { notify: (message: string, level = 'info') => notices.push({ message, level }), setWidget() {}, theme: { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text } } };
  const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  return { pi, ctx, appends, sent, notices, tools, commands, renames, fire };
}

async function agentDir(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'team-panel-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  return root;
}
const panelHost = async (t: { after(fn: () => unknown): void }, workspaceRoot: string) => {
  const root = await mkdtemp(joinPath(tmpdir(), 'team-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = host(workspaceRoot);
  h.ctx.hasUI = true; h.ctx.mode = 'tui';
  h.ctx.cwd = workspaceRoot;
  return h;
};

test('Team idle refresh paints a changed PID verdict without a key or remount', { timeout: 10000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Helper', pid: 222, now: 1_000 });
  const h = await panelHost(t, workspace), panel = menuPanel();
  let alive = true;
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 111, alive: () => alive });
  const panels = recordPanels(h.ctx), painted: string[] = [];
  const custom = h.ctx.ui.custom;
  // Capture only host-requested paints: calling panels.frame() after the verdict changed would itself
  // rebuild the upper zone and falsely pass even if the periodic refresh had been removed.
  h.ctx.ui.custom = (factory: any, options: any) => custom((tui: any, ...args: any[]) => {
    let component: any;
    const requestRender = tui.requestRender;
    component = factory({ ...tui, requestRender(force: boolean) {
      requestRender(force);
      painted.push(component.render(96).map(stripTerminalSequences).join('\n'));
    } }, ...args);
    return component;
  }, options);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  try {
    await panels.wait(() => panels.live() === 1);
    assert.match(painted.at(-1)!, /Helper.*终端/);
    const paints = painted.length;
    alive = false;
    assert.equal(painted.length, paints);
    t.mock.timers.tick(1000);
    assert.ok(painted.length > paints, 'the real one-second menu timer requested a new frame');
    assert.match(painted.at(-1)!, /Helper.*离线/);
    assert.doesNotMatch(painted.at(-1)!, /Helper.*终端/);
    assert.equal(panels.mounts(), 1);
  } finally { panels.finish(); await opening; }
});

test('the team panel renders two collapsible groups, current marker, states and unread badges', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await createTeam({ name: 'Beta', workspaceRoot: workspace });
  await createTeam({ name: 'Other workspace', workspaceRoot: '/tmp/other' });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Helper', pid: 11, now: 1_000 });
  await sendToMember(alpha.id, { from: 'Lead', fromId: 's1', to: 'Helper', body: 'hello', now: Date.now() });
  // The Retry flag is written by a real member event, exactly as a boundary would write it.
  await noteMemberEvent(alpha.id, 's2', { retrying: true, ownerPid: 11 });
  const h = await panelHost(t, workspace);
  const flightMemory = new Map();
  const panel = { register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => flightMemory } as any;
  let currentTeamId: string | undefined;
  const registration = registerTeam(h.pi, { msg: chinese, panel, alive: () => true });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, { msg: chinese, panel, currentTeamId: () => currentTeamId, setCurrentTeam: id => { currentTeamId = id; }, pointer: registration.pointer, join: registration.join, leave: registration.leave, takeover: registration.takeover, create: registration.create, launch: registration.launch, switchTo: registration.switchTo, evict: registration.evict, stop: registration.stop, deleteSession: registration.deleteSession, rebuild: registration.rebuild, sessionFileState: registration.sessionFileState, desktop: registration.desktop, setDesktop: registration.setDesktop, history: registration.history, resumeCommand: registration.resumeCommand, pid: registration.pid, ...(registration.alive ? { alive: registration.alive } : {}), renameSession: name => h.pi.setSessionName(name) });
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const reveal = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 80; step++) { if (panels.frame().join('\n').includes(word)) return; await panels.press(key); } throw new Error(`row not found: ${word}`); };
  await reveal('团队 (');
  assert.match(frame(), /团队 \(\d\)/, 'the teams group heading carries its count');
  await reveal('成员 (');
  assert.match(frame(), /成员 \(\d\)/, 'the members group heading carries its count');
  await reveal('Alpha');
  assert.match(frame(), /Alpha.*已加入/, 'the joined team is marked as joined, not merely viewed');
  await reveal('Helper');
  assert.match(frame(), /Helper.*(终端|后台|离线)/);
  await reveal('1 条未读');
  assert.match(frame(), /1 条未读/);
  // The band is the first upper row: scroll back to it rather than assuming it stays on screen.
  await panels.press('g');
  assert.match(frame(), /领队/, 'the info band shows the lead line, and no goal or progress line');
  // fold one group and reopen: state persists in PanelMemory
  await panels.press('g');
  for (let step = 0; step < 40; step++) { const row = panels.frame().find(l => /^[ │]*> /.test(l) && /团队 \(/.test(l)); if (row) break; await panels.press('j'); }
  await panels.press('h');
  for (let attempt = 0; attempt < 50 && panels.frame().some(l => /Alpha/.test(l)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  // The band still names the current team; the folded group must leave no team row behind.
  assert.equal(panels.frame().some(l => /Alpha \.{3,}/.test(l)), false, 'the teams group folded');
  await closePanel(panels, opening);
  const reopening = teamMenu(h.ctx, { msg: chinese, panel, currentTeamId: () => currentTeamId, setCurrentTeam: id => { currentTeamId = id; }, pointer: registration.pointer, join: registration.join, leave: registration.leave, takeover: registration.takeover, create: registration.create, launch: registration.launch, switchTo: registration.switchTo, evict: registration.evict, stop: registration.stop, deleteSession: registration.deleteSession, rebuild: registration.rebuild, sessionFileState: registration.sessionFileState, desktop: registration.desktop, setDesktop: registration.setDesktop, history: registration.history, resumeCommand: registration.resumeCommand, pid: registration.pid, ...(registration.alive ? { alive: registration.alive } : {}), renameSession: name => h.pi.setSessionName(name) });
  await panels.wait(() => panels.live() === 1);
  assert.equal(panels.frame().some(l => /Alpha \.{3,}/.test(l)), false, 'the fold state survives a reopen');
  await panels.press('\x1b'); await reopening;
  // The goal editor left the product with the shared task list: an old goal value is history, not a row.
  assert.equal(frame().includes('编辑团队目标'), false, 'no goal editor is offered');
});

test('ticket13 the member row names why it is offline and what to press, and every row keeps its icon', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Gone', pid: 222, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  // This host can see that pid 222 is gone and that 111 is itself.
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 111, alive: candidate => candidate !== 222 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const reveal = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 60; step++) { if (frame().includes(word)) return; await panels.press(key); } throw new Error(`row not found: ${word}\n${frame()}`); };
  await reveal('Gone');
  assert.match(frame(), /Gone[^\n]*离线 · 持有进程已退出；按 Enter 发起接管/, `the offline row names the cause and the action\n${frame()}`);
  assert.doesNotMatch(frame(), /请检查|请查看|请设置|请确认/);
  // Every dockable module row keeps a table glyph; the band row is the documented exemption.
  const rows = panels.frame().filter(line => /^[ │]*[> ] ?\S/.test(line) && /新建|收信策略|解散|加入|切换|Gone|Lead|Alpha/.test(line) && !/^[ │]*(?:领队|本会话团队)[ ·.]/.test(line));
  assert.ok(rows.length >= 4, `rows found: ${rows.length}`);
  for (const line of rows) assert.match(line, /[\u{f0000}-\u{ffffd}]/u, `every dockable row keeps an icon: ${line}`);
  await closePanel(panels, opening);
});

test('a session outside the team sees a read-only board with join actions', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = { register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => undefined } as any;
  const registration = registerTeam(h.pi, { msg: chinese, panel });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, { msg: chinese, panel, currentTeamId: () => alpha.id, setCurrentTeam: () => {}, pointer: registration.pointer, join: registration.join, leave: registration.leave, takeover: registration.takeover, create: registration.create, launch: registration.launch, switchTo: registration.switchTo, evict: registration.evict, stop: registration.stop, deleteSession: registration.deleteSession, rebuild: registration.rebuild, sessionFileState: registration.sessionFileState, desktop: registration.desktop, setDesktop: registration.setDesktop, history: registration.history, resumeCommand: registration.resumeCommand, pid: registration.pid, ...(registration.alive ? { alive: registration.alive } : {}), renameSession: name => h.pi.setSessionName(name) });
  await panels.wait(() => panels.live() === 1);
  const focusRow = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 60; step++) { if (panels.frame().find(l => /^[ │]*> /.test(l) && l.includes(word))) return; await panels.press(key); } return; };
  assert.match(panels.frame().join('\n'), /成员/, 'the board is readable without joining');
  await panels.focus('Alpha .'); await panels.press('l');
  await focusRow('加入当前会话');
  assert.match(focused(panels), /加入当前会话/, 'the team row owns the only current-session join entry');
  await assert.rejects(panels.focus('团队管理'), /No selectable panel row/, 'non-empty teams still require membership to dissolve');
  await closePanel(panels, opening);
});

test('dissolve takes two Enters, archives the team, keeps its data and clears stale pointers', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  // A historic goal, written directly into the manifest as an older version left it.
  const manifestFile = join(teamsRoot(), alpha.id, 'team.json');
  await writeFile(manifestFile, `${JSON.stringify({ ...JSON.parse(await readFile(manifestFile, 'utf8')), goal: 'ship it later' }, null, 2)}\n`);
  const h = await panelHost(t, workspace);
  const panel = { register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => undefined } as any;
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, { msg: chinese, panel, currentTeamId: () => alpha.id, setCurrentTeam: () => {}, pointer: registration.pointer, join: registration.join, leave: registration.leave, takeover: registration.takeover, create: registration.create, launch: registration.launch, switchTo: registration.switchTo, evict: registration.evict, stop: registration.stop, deleteSession: registration.deleteSession, rebuild: registration.rebuild, sessionFileState: registration.sessionFileState, desktop: registration.desktop, setDesktop: registration.setDesktop, history: registration.history, resumeCommand: registration.resumeCommand, pid: registration.pid, ...(registration.alive ? { alive: registration.alive } : {}), renameSession: name => h.pi.setSessionName(name) });
  await panels.wait(() => panels.live() === 1);
  const focusRow = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 80; step++) { if (panels.frame().find(l => /^[ │]*> /.test(l) && l.includes(word))) return; await panels.press(key); } throw new Error(`row not found: ${word}`); };
  await panels.press('G');
  await focusRow('Alpha .');
  await panels.press('l');
  await teamFocus(panels, '解散团队');
  await panels.press('\r');
  assert.match(panels.frame().join('\n'), /再次 Enter 解散/);
  assert.ok((await listTeams(workspace)).some(team => team.id === alpha.id), 'one Enter dissolves nothing');
  await panels.press('\r');
  // Dissolving archives the manifest, then leaves and notifies, so the file can be gone a moment before
  // the notice exists. Both observations get a bounded wait; the assertions below still run. The leave
  // inside the dissolve notifies too, so the dissolution notice is the one that names the team.
  const dissolvedNotice = () => h.notices.some(n => /已解散/.test(n.message) && n.message.includes('Alpha'));
  for (let attempt = 0; attempt < 50; attempt++) { if (!(await readTeam(alpha.id))) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  for (let attempt = 0; attempt < 100; attempt++) { if (dissolvedNotice()) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(await readTeam(alpha.id), undefined, 'the second Enter dissolves the team');
  assert.deepEqual(await listTeams(workspace), []);
  assert.ok(dissolvedNotice(), 'the notice names the team it dissolved');
  // De-registration happens in place: the carrier sits in the same directory, the members stay, nothing moves.
  const carrier = await readFile(join(teamsRoot(), alpha.id, 'team.archived.json'), 'utf8').then(text => JSON.parse(text));
  assert.equal(carrier.name, 'Alpha', 'the manifest is kept as the inactive carrier');
  assert.equal(carrier.goal, 'ship it later', 'and the historic goal survives in it');
  assert.equal(await readFile(join(teamsRoot(), alpha.id, 'team.json'), 'utf8').then(() => true, () => false), false, 'the active manifest is gone');
  assert.equal((await readMembers(alpha.id)).length >= 1, true, 'the member records stay in the same directory');
  await panels.press('\x1b'); await opening.catch(() => {});
  // A stale pointer is cleared on the next session_start with an actionable notice.
  const stale = host(workspace);
  registerTeam(stale.pi, { msg: chinese });
  stale.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: 't-gone', memberName: 'Lead' });
  await stale.fire('session_start');
  assert.equal(stale.appends.at(-1)!.data, undefined, 'the pointer is cleared');
  assert.match(stale.notices.at(-1)!.message, /原团队 t-gone 已解散/);
});

for (const elsewhere of [false, true]) test(`an empty team can be dissolved without joining it (joined elsewhere: ${elsewhere})`, { timeout: 6000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const beta = await createTeam({ name: 'Beta', workspaceRoot: workspace });
  const h = await panelHost(t, workspace), panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 111 });
  if (elsewhere) {
    await joinTeam(beta.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: 1_000 });
    h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: beta.id, memberName: 'Lead' });
  }
  const before = JSON.stringify(await readMembers(beta.id)), pointer = registration.pointer(h.ctx), appends = h.appends.length;
  let current: string | undefined = alpha.id, joins = 0, leaves = 0;
  const panels = recordPanels(h.ctx);
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const opening = teamMenu(h.ctx, { ...launchHooks(h, panel, registration, () => current, id => { current = id; }), join: async (ctx: any, name: string) => { joins++; return registration.join(ctx, name); }, leave: async (ctx: any, options?: { authorized?: boolean }) => { leaves++; await registration.leave(ctx, options); } });
  try {
    await panels.wait(() => panels.live() === 1);
    await panels.focus('Alpha .'); await panels.press('l');
    await teamFocus(panels, '解散团队');
    await panels.press('\r');
    assert.ok(await readTeam(alpha.id), 'the first Enter only arms confirmation');
    await panels.press('\x1b');
    assert.ok(await readTeam(alpha.id), 'Escape cancels without archiving');
    await panels.press('\r'); await panels.press('\r');
    await panels.wait(() => h.notices.some(notice => /Alpha 已解散/.test(notice.message)));
    assert.equal(await readTeam(alpha.id), undefined);
    assert.equal(JSON.parse(await readFile(join(teamsRoot(), alpha.id, 'team.archived.json'), 'utf8')).name, 'Alpha');
    assert.deepEqual(await readMembers(alpha.id), [], 'no temporary member is created to authorize deletion');
    assert.equal(joins, 0); assert.equal(leaves, 0, 'deleting another team must not call leave on this session');
    assert.deepEqual(registration.pointer(h.ctx), pointer); assert.equal(h.appends.length, appends);
    assert.equal(JSON.stringify(await readMembers(beta.id)), before); assert.ok(await readTeam(beta.id));
  } finally { await closePanel(panels, opening); }
});

test('an empty-team confirmation cannot archive members that join before confirmation', { timeout: 6000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const h = await panelHost(t, workspace), panel = menuPanel(), registration = registerTeam(h.pi, { msg: chinese, panel });
  let current: string | undefined = alpha.id;
  const panels = recordPanels(h.ctx);
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => current, id => { current = id; }));
  try {
    await panels.wait(() => panels.live() === 1);
    await panels.focus('Alpha .'); await panels.press('l'); await teamFocus(panels, '解散团队');
    await panels.press('\r');
    await joinTeam(alpha.id, { sessionId: 'new-peer', sessionName: 'Peer', pid: 222, now: 1_000 });
    await panels.press('\r');
    await panels.wait(() => h.notices.some(notice => notice.level === 'error'));
    assert.match(h.notices.find(notice => notice.level === 'error')!.message, /加入团队/, 'the refusal tells this viewer how to gain membership rather than claiming success');
    assert.ok(await readTeam(alpha.id), 'new members invalidate the empty-only action');
    assert.deepEqual((await readMembers(alpha.id)).map(member => member.sessionId), ['new-peer']);
    assert.ok(!h.notices.some(notice => /已解散/.test(notice.message)), 'refusal is never reported as successful deletion');
    assert.equal(registration.pointer(h.ctx), undefined);
  } finally { await closePanel(panels, opening); }
});

test('empty-only dissolution serializes concurrent joins and retains unreadable member records', { timeout: 6000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const folder = join(teamsRoot(), alpha.id), manifest = join(folder, 'team.json');
  await writeFile(join(folder, 'members', 'unreadable.json'), '{invalid');
  assert.equal(await dissolveTeam(alpha.id, { onlyIfEmpty: true }), false, 'invalid member JSON is not proof of an empty team');
  assert.ok(await readTeam(alpha.id));
  await rm(join(folder, 'members', 'unreadable.json'));
  const missing = await createTeam({ name: 'Missing members directory', workspaceRoot: workspace });
  await rm(join(teamsRoot(), missing.id, 'members'), { recursive: true });
  assert.equal(await dissolveTeam(missing.id, { onlyIfEmpty: true }), true, 'a missing members directory proves no member files exist');
  let entered!: () => void, release!: () => void, attempted!: (result: string) => void, joiningStarted = false;
  const archiveEntered = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const joinAttempt = new Promise<string>(resolve => { attempted = resolve; });
  const rename = fsPromises.rename, open = fsPromises.open;
  t.mock.method(fsPromises, 'rename', async (...[from, to]: Parameters<typeof fsPromises.rename>) => {
    if (String(from) === manifest) { entered(); await released; }
    return rename(from, to);
  });
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
    const joining = joiningStarted && String(args[0]) === join(folder, 'names.lock');
    try { const handle = await open(...args); if (joining) attempted('acquired'); return handle; }
    catch (cause) { if (joining) attempted((cause as NodeJS.ErrnoException).code ?? 'unknown'); throw cause; }
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const archiving = dissolveTeam(alpha.id, { onlyIfEmpty: true });
  let joining: ReturnType<typeof joinTeam> | undefined;
  try {
    await archiveEntered;
    joiningStarted = true;
    joining = joinTeam(alpha.id, { sessionId: 'late-peer', sessionName: 'Peer', pid: 222, now: 1_000 });
    assert.equal(await joinAttempt, 'EEXIST', 'the real join cannot acquire the name lock while archival is in progress');
    release();
    assert.equal(await archiving, true);
    assert.equal(await joining, undefined, 'a queued join rechecks the active manifest and creates no orphan member');
    assert.deepEqual(await readMembers(alpha.id), []);
    assert.equal(await readTeam(alpha.id), undefined);
  } finally { release(); await archiving; await joining; }
});

const launchHooks = (h: any, panel: any, registration: any, current: () => string | undefined, set: (id: string | undefined) => void) => ({
  msg: chinese, panel, currentTeamId: current, setCurrentTeam: set,
  pointer: registration.pointer, join: registration.join, leave: registration.leave, takeover: registration.takeover,
  create: registration.create, launch: registration.launch, switchTo: registration.switchTo, evict: registration.evict, stop: registration.stop, deleteSession: registration.deleteSession, rebuild: registration.rebuild, sessionFileState: registration.sessionFileState, desktop: registration.desktop, setDesktop: registration.setDesktop, history: registration.history, resumeCommand: registration.resumeCommand, pid: registration.pid, ...(registration.alive ? { alive: registration.alive } : {}), renameSession: (name: string) => h.pi.setSessionName(name),
});
const menuPanel = (memory: Map<string, unknown> = new Map()) => ({ register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => memory }) as any;
const focused = (panels: any) => panels.frame().find((line: string) => /^[ │]*> /.test(line)) ?? '';
/** Navigate authored accordion paths using the same keys a person uses. */
const teamFocus = async (panels: any, word: string) => {
  const needle = word === '移出名册' ? '移出团队' : word;
  const session = ['启动会话', '接管会话', '强制接管', '停止此成员进程'];
  const pull = ['后台拉起', '分屏拉起', 'tmux 新窗口拉起', '桌面窗口拉起', '复制拉起命令'];
  const member = ['移出团队', '重命名成员', '重命名会话', '收信策略', '移交领队', '删除会话与信箱'];
  const path = session.includes(needle) || pull.includes(needle) ? ['会话操作', ...(pull.includes(needle) ? ['启动会话'] : [])]
    : member.includes(needle) ? ['成员管理'] : needle === '解散团队' ? ['团队管理']
    : ['桌面终端', '自定义命令'].includes(needle) ? ['启动设置'] : [];
  const focus = async (label: string) => {
    const paints = panels.forces.length;
    try { await panels.focus(label); }
    catch (cause) {
      // Notices/file writes can precede choose re-entry. Wait for a real repaint, not an arbitrary sleep.
      await panels.wait(() => panels.forces.length > paints);
      try { await panels.focus(label); } catch { throw cause; }
    }
  };
  for (const parent of path) { await focus(parent); await panels.press('l'); }
  await focus(needle);
};
/** Every action row remounts the panel, so closing means pressing Esc on whatever is live now. */
const closePanel = async (panels: any, opening: Promise<void>) => {
  for (let step = 0; step < 6; step++) {
    const raced = await Promise.race([opening.then(() => 'closed' as const), panels.wait(() => panels.live() === 1).then(() => 'live' as const).catch(() => 'timeout' as const)]);
    if (raced === 'closed') return;
    await panels.press('\x1b');
  }
  await opening;
};

test('ticket09 an empty workspace makes 新建团队 the only usable row and creates the team in place', async t => {
  await agentDir(t);
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const spawns: unknown[] = [];
  const registration = registerTeam(h.pi, { msg: chinese, panel, launchDeps: { spawn: ((...args: unknown[]) => { spawns.push(args); return { unref() {} }; }) as any, adapters: { tmux: false, graphical: false } } });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  let currentTeamId: string | undefined;
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => currentTeamId, id => { currentTeamId = id; }));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  // No team: every other lower row explains the gate, and only 新建团队 stays usable.
  // The lower zone scrolls, so collect the frames while walking it instead of expecting one screen.
  await panels.press('G');
  const seen: string[] = [];
  for (let step = 0; step < 10; step += 1) { seen.push(...panels.frame()); await panels.press('j'); }
  // Dissolving belongs to a team row, so an empty workspace has nothing to dissolve: the row does not
  // exist at all instead of sitting in the lower zone with a gate nobody can satisfy.
  assert.equal(seen.some(row => row.includes('解散团队')), false, 'no team, no dissolve row');
  await panels.press('G');
  assert.match(focused(panels), /新建团队/, 'G lands on the only usable row');
  await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press('Alpha'); await panels.press('\r');
  for (let attempt = 0; attempt < 80; attempt++) { if ((await listTeams(workspace)).length === 1) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const created = await listTeams(workspace);
  assert.equal(created.length, 1, 'the panel created the team through createTeam');
  assert.equal(created[0]!.name, 'Alpha');
  assert.equal(currentTeamId, created[0]!.id, 'the new team becomes the current one');
  // The panel repaints on its next loop turn: wait for that, the assertion itself is unchanged.
  await panels.wait(() => /Alpha.*正在查看/.test(frame()));
  assert.match(frame(), /Alpha.*正在查看/, 'viewing a new team does not claim this session has joined it');
  // Expanding the team row offers the join action; the member rows never carry it.
  await panels.focus('Alpha .'); // Match the team entity, not the new-session target value.
  await panels.press('l');
  await panels.wait(() => frame().includes('加入当前会话'));
  assert.equal(panels.frame().filter(line => line.includes('加入当前会话') && !line.includes('当前值')).length, 1, 'the team row explicitly joins the current session');
  for (let step = 0; step < 6 && !focused(panels).includes('加入当前会话'); step++) await panels.press('j');
  await panels.press('\r');
  for (let attempt = 0; attempt < 80; attempt++) { if ((await readMembers(created[0]!.id)).length === 1) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const joinedMember = (await readMembers(created[0]!.id))[0]!;
  assert.equal(joinedMember.sessionId, 's1', 'joining writes the member record for this session');
  assert.equal(registration.pointer(h.ctx)?.teamId, created[0]!.id, 'the pointer follows the join');
  assert.equal(spawns.length, 0, 'creating and joining never spawns a process');
  await closePanel(panels, opening);
});

test('ticket09 empty and duplicate team names are refused with actionable guidance', async t => {
  await agentDir(t);
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel });
  assert.equal(await registration.create(h.ctx, '   '), undefined);
  assert.match(h.notices.at(-1)!.message, /团队名不能为空/);
  const alpha = await registration.create(h.ctx, 'Alpha');
  assert.ok(alpha);
  assert.equal(await registration.create(h.ctx, 'Alpha'), undefined);
  assert.match(h.notices.at(-1)!.message, /团队 Alpha 已存在/);
  assert.equal((await listTeams(workspace)).length, 1, 'the duplicate never creates a second team');
  assert.equal(await registration.create(h.ctx, 'x'.repeat(41)), undefined);
  assert.match(h.notices.at(-1)!.message, /团队名过长/);
});

test('ticket26 the root entry starts a new session: six hosts, never a --session', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const beta = await createTeam({ name: 'Beta', workspaceRoot: workspace });
  await joinTeam(beta.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const spawns: { command: string; args: string[]; options?: { env?: Record<string, string> } }[] = [];
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, wait: async () => {}, launchDeps: { spawn: ((command: string, args: string[], options?: { env?: Record<string, string> }) => { spawns.push({ command, args, ...(options ? { options } : {}) }); return { pid: 4321, exitCode: null, signalCode: null, unref() {}, on() {} }; }) as any, adapters: { tmux: false, graphical: false, terminal: 'kitty' }, mkfifo: () => {}, openFifo: () => 'ignore' as const, wait: async () => {}, alive: () => true } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: beta.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focus = (word: string) => teamFocus(panels, word);
  await focus('Alpha .'); await panels.press('l');
  await focus('新建会话');
  assert.match(focused(panels), /Alpha/, 'the root shows the viewed target even though this session belongs to Beta');
  assert.match(frame(), /新会话加入团队 Alpha/);
  await panels.press('l');
  await focus('启动方式'); await panels.press('l');
  assert.doesNotMatch(frame(), /启动与接管/, 'the old root entity is gone');
  for (const label of ['自动检测', '分屏启动', 'tmux 新窗口', '桌面窗口', '后台启动', '复制启动命令']) { await focus(label); assert.match(focused(panels), new RegExp(label), label); }
  // Copy: the command reaches the notice and nothing spawns; a root launch never continues a session.
  await focus('复制启动命令'); await panels.press('\r');
  await panels.wait(() => h.notices.some(notice => /复制这条命令新建会话/.test(notice.message)));
  const copied = h.notices.at(-1)!.message;
  assert.match(copied, /--team 'Alpha'/, 'the pasted command targets viewed Alpha, not joined Beta');
  assert.equal(registration.pointer(h.ctx)!.teamId, beta.id, 'starting a new member never moves this session to the viewed team');
  assert.doesNotMatch(copied, /--session/, 'the root entry starts a new session');
  assert.match(copied, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the pasted command uses the running executable');
  assert.equal(spawns.length, 0, 'copy never spawns');
  // The row truncates the tail, so assert what a frame really shows: the interpreter head the command starts
  // with, a row that stays inside its frame, and a tail that is cut rather than wrapped. The full command is
  // already pinned by the notice above; the narrow frame is what makes the cut unconditional.
  const interpreterHead = `'${process.execPath.slice(0, Math.min(24, process.execPath.length))}`;
  await panels.wait(() => frame().includes(interpreterHead));
  const commandRow = frame().split('\n').find(line => line.includes(interpreterHead))!;
  assert.ok(visibleWidth(commandRow) <= 96, `the command row stays inside the frame: ${commandRow}`);
  const narrow = panels.frame(40).filter((line: string) => line.includes(interpreterHead));
  assert.equal(narrow.length, 1, `the command keeps one row in a narrow frame: ${JSON.stringify(narrow)}`);
  assert.ok(visibleWidth(narrow[0]!) <= 40, `the narrow row stays inside its frame: ${narrow[0]}`);
  assert.match(narrow[0]!, /…\s*$/, 'a command too long for the row is cut, not wrapped');
  // Split without tmux degrades to the copyable command.
  await focus('分屏启动'); await panels.press('\r');
  await panels.wait(() => h.notices.filter(notice => /复制这条命令新建会话/.test(notice.message)).length === 2);
  assert.equal(spawns.length, 0, 'a bare shell degrades split to copy');
  // The desktop window really opens the terminal emulator, not tmux.
  await focus('桌面窗口'); await panels.press('\r');
  await panels.wait(() => spawns.length === 1);
  assert.equal(spawns[0]!.command, 'kitty', 'the desktop row launches the terminal emulator');
  assert.deepEqual(spawns[0]!.args.slice(0, 2), [process.execPath, piLaunchTarget().cli], 'the same interpreter plus CLI entry');
  assert.ok(!spawns[0]!.args.includes('--session'), 'a root launch starts a new session');
  // A window launch is a start *request*: the terminal may not honour it, so it is never called ready.
  await panels.wait(() => h.notices.some(notice => /已提交启动请求/.test(notice.message)));
  assert.match(h.notices.at(-1)!.message, /实际状态为准/,  'the panel says the member is not confirmed');
  // Background really launches, with the headless marker in the child environment.
  await focus('后台启动'); await panels.press('\r');
  await panels.wait(() => spawns.length === 2);
  assert.deepEqual(spawns[1]!.args.slice(1), ['--team', 'Alpha', '--team-bootstrap', '-e', teamExtensionPath(), '--mode', 'rpc'], 'a background member runs as an RPC process');
  assert.equal(spawns[1]!.options!.env!.PI_TEAM_BACKGROUND, '1');
  assert.ok(!spawns[1]!.args.includes('--session'), 'background from the root starts a new session too');
  // The fake child never joins the team, so the row must say the launch failed — not claim a member.
  await panels.wait(() => /派发失败/.test(h.notices.at(-1)!.message));
  assert.match(h.notices.at(-1)!.message, /未在 5 秒内确认加入团队/, 'a background launch that never joined is reported as a failure');
  await closePanel(panels, opening);
  // A viewer need not join first: the new process, not the viewer, joins the viewed team.
  await registration.leave(h.ctx, { authorized: true });
  const outside = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  await focus('Alpha .'); await panels.press('l');
  await focus('新建会话'); await panels.press('l');
  await focus('启动方式'); await panels.press('l');
  await focus('复制启动命令'); await panels.press('\r');
  await panels.wait(() => /--team 'Alpha'/.test(h.notices.at(-1)!.message));
  assert.equal(registration.pointer(h.ctx), undefined, 'an unjoined viewer remains unjoined after creating a launch command');
  await closePanel(panels, outside);
  // A tmux host uses the adapter instead of degrading, and the two windows differ.
  const hosts: { command: string; args: string[] }[] = [];
  const tmuxed = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), launchDeps: { spawn: ((command: string, args: string[]) => { hosts.push({ command, args }); return { unref() {} }; }) as any, adapters: { tmux: true, graphical: true, terminal: 'kitty' } } });
  const split = await tmuxed.launch(h.ctx, 'split', 'Alpha');
  assert.equal(split.plan!.mode, 'split'); assert.equal(split.spawned, true); assert.equal(hosts[0]!.command, 'tmux');
  const window = await tmuxed.launch(h.ctx, 'window', 'Alpha');
  assert.equal(window.plan!.mode, 'window'); assert.equal(hosts[1]!.command, 'tmux');
  const desktop = await tmuxed.launch(h.ctx, 'desktop', 'Alpha');
  assert.equal(desktop.plan!.mode, 'desktop'); assert.equal(hosts[2]!.command, 'kitty', 'the desktop window is not a tmux command');
  assert.notEqual(hosts[1]!.args[1], hosts[2]!.args[0], 'a tmux window and a desktop window are different hosts');
  const auto = await tmuxed.launch(h.ctx, 'auto', 'Alpha');
  assert.equal(auto.plan!.mode, 'split', 'auto picks split when tmux is available');
});

/** Where `sessionFileFor` looks: `<agentDir>/sessions/<project>/<id>.jsonl`. */
async function sessionFile(agentRoot: string, sessionId: string): Promise<string> {
  const directory = join(agentRoot, 'sessions', 'project');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${sessionId}.jsonl`);
  // The native header names the session, so a takeover can verify the file really belongs to this SID.
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date(1).toISOString(), cwd: workspace })}\n`);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.open(file);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved target' }] } as never);
  return file;
}

/** Count live intervals so a leaked timer (one that still holds the old ctx) is observable. */
const trackIntervals = (t: { after(fn: () => unknown): void }) => {
  const live = new Set<ReturnType<typeof setInterval>>();
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = ((handler: any, ms?: number, ...rest: any[]) => { const handle = realSet(handler, ms, ...rest); live.add(handle); return handle; }) as any;
  globalThis.clearInterval = ((handle: any) => { live.delete(handle); return realClear(handle); }) as any;
  t.after(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; });
  return { live: () => live.size };
};

/**
 * A host whose `switchSession` records the call and hands `withSession` a fresh context.
 * `livePanels` is read at the moment of the call: switching under a mounted panel is the bug.
 */
const switchingHost = (h: any, outcome: { cancelled: boolean; livePanels?: () => number; branch?: { customType?: string; data?: unknown }[]; assertBeforeSwitch?: () => void } = { cancelled: false }) => {
  const calls: { path: string; next?: any; ran?: boolean; error?: string; livePanels?: number }[] = [];
  // Pi invalidates the captured api and ctx on a switch; the stub does the same so a stale use fails here.
  let replaced = false;
  const append = h.pi.appendEntry;
  h.pi.appendEntry = (...args: unknown[]) => {
    if (replaced) throw new Error('This extension ctx is stale after session replacement');
    return append(...args);
  };
  h.ctx.switchSession = async (path: string, options?: { withSession?: (next: any) => Promise<void> }) => {
    const call: { path: string; next?: any; ran?: boolean; error?: string; livePanels?: number } = { path, ...(outcome.livePanels ? { livePanels: outcome.livePanels() } : {}) };
    calls.push(call);
    replaced = true;
    try {
      // The invariants are checked at the moment of the call, not afterwards: a switch under a mounted
      // panel, or one that leaves the old poll timer armed, must fail here for every test using the stub.
      if (outcome.livePanels) assert.equal(outcome.livePanels(), 0, 'switchSession was called while a panel was still mounted');
      outcome.assertBeforeSwitch?.();
      if (!outcome.cancelled && options?.withSession) {
        // The loaded session carries its own team pointer; the stub models that.
        const next = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => path.split('/').at(-1)!.replace(/\.jsonl$/, ''), getBranch: () => outcome.branch ?? h.ctx.sessionManager.getBranch() } };
        call.next = next;
        await options.withSession(next);
        call.ran = true;
      }
    } catch (cause) { call.error = String(cause); throw cause; }
    return { cancelled: outcome.cancelled };
  };
  return calls;
};

test('ticket32 接管 loads the member session file instead of handing over a command', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const timers = trackIntervals(t);
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: () => false, launchDeps: { spawn: (() => ({ unref() {} })) as any, adapters: { tmux: false, graphical: false } } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  // Start the real session so the mailbox poll timer exists: a timer that still holds the old ctx
  // would fire within thirty seconds of the switch and hit the stale-context guard.
  await h.fire('session_start');
  assert.ok(timers.live() > 0, 'the mailbox poll timer is running before the takeover');
  const target = await sessionFile(root, 's2');
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  // The probes are read inside the stub, so a switch that happens with a panel mounted or a timer
  // still armed fails here, at the moment of the call.
  const calls = switchingHost(h, {
    cancelled: false, livePanels: () => panels.live(),
    branch: [{ customType: 'pi-dag-workflow.team-pointer', data: { teamId: alpha.id, memberName: 'Worker' } }],
    assertBeforeSwitch: () => assert.equal(timers.live(), 0, 'the poll timer was stopped before the session switch'),
  });
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focus = (word: string) => teamFocus(panels, word);
  await focus('Worker'); await panels.press('l');
  await focus('接管会话');
  // The copy states the consequence: the old process is stopped and stops writing shared state.
  assert.match(frame(), /旧进程/, 'the row names the old process');
  assert.match(frame(), /停下/, 'and says it is stopped first');
  assert.match(frame(), /不再写共享状态/, 'and that it stops writing shared state');
  await panels.press('\r');
  // The switch enters `switchSession` and then runs `withSession`: wait for that to finish, not just for the call.
  await panels.wait(() => calls[0]?.ran === true || calls[0]?.error !== undefined);
  assert.equal(calls[0]?.error, undefined, 'the withSession callback completed');
  assert.equal(calls[0]!.path, target, 'the switch loads that member\'s session file');
  assert.ok(calls[0]!.next, 'withSession receives the replaced context');
  const members = await readMembers(alpha.id);
  assert.equal(members.find(member => member.name === 'Worker')!.holder.pid, 10, 'this process now holds the target record');
  const released = members.find(member => member.name === 'Lead')!;
  assert.equal(released.holder.pid, 0, 'the member this session used to represent lost its holder');
  assert.equal(memberState(released, true, false), 'offline', 'and reads offline even though its pid would probe alive');
  assert.ok(h.notices.some(notice => /现在是成员 Worker/.test(notice.message)), 'the new context announces the switch');
  assert.equal(h.notices.some(notice => /接着这条对话请运行/.test(notice.message)), false, 'no command hand-off on a host that can switch');
  assert.equal(calls[0]!.livePanels, 0, 'the panel was closed before the session switch');
  // No self-closing here: the takeover itself must leave the panel unmounted.
  await opening;
});

test('ticket32 takeover refuses without a session file, blocks a live holder and rolls back a cancelled switch', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 10, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const before = (await readMembers(alpha.id)).find(member => member.name === 'Worker')!;
  // No session file yet: the takeover must not touch ownership.
  await assert.rejects(registration.switchTo(h.ctx, 'Worker'), /找不到成员 Worker 的会话文件/);
  const untouched = (await readMembers(alpha.id)).find(member => member.name === 'Worker')!;
  assert.equal(untouched.holder.pid, before.holder.pid, 'pid unchanged');
  assert.equal(untouched.generation, before.generation, 'generation unchanged');
  // With the file present, a live foreign holder still blocks unless forced.
  const target = await sessionFile(root, 's2');
  const blockedCalls = switchingHost(h);
  let oldAlive = true;
  const live = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 10, alive: pid => (pid === 4242 ? oldAlive : false), wait: async () => { oldAlive = false; } });
  await assert.rejects(live.switchTo(h.ctx, 'Worker'), /旧进程（pid 4242）仍在运行/);
  assert.equal(blockedCalls.length, 0, 'a blocked takeover never switches the session');
  assert.equal((await readMembers(alpha.id)).find(member => member.name === 'Worker')!.holder.pid, 4242, 'the holder is untouched');
  // Forcing goes through, even with a live holder.
  const forcedCalls = switchingHost(h);
  assert.equal(await live.switchTo(h.ctx, 'Worker', true), 'switched');
  assert.equal(forcedCalls[0]!.path, target);
  // A cancelled switch rolls both records back.
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const claimedBefore = (await readMembers(alpha.id)).find(member => member.name === 'Worker')!;
  const leadBefore = (await readMembers(alpha.id)).find(member => member.name === 'Lead')!;
  const cancelling = switchingHost(h, { cancelled: true });
  await assert.rejects(live.switchTo(h.ctx, 'Worker', true), /会话切换被取消/);
  assert.equal(cancelling.length, 1, 'the switch was attempted');
  const after = await readMembers(alpha.id);
  const workerAfter = after.find(member => member.name === 'Worker')!;
  assert.equal(workerAfter.holder.pid, claimedBefore.holder.pid, 'the claim is rolled back to the previous holder');
  assert.equal(workerAfter.state, claimedBefore.state, 'and to the previous state');
  assert.ok(workerAfter.generation > claimedBefore.generation, 'while the generation only moves forward');
  const leadAfter = after.find(member => member.name === 'Lead')!;
  assert.equal(leadAfter.holder.pid, leadBefore.holder.pid, 'the released record is restored');
  assert.equal(leadAfter.state, leadBefore.state);
  assert.ok(leadAfter.generation > leadBefore.generation, 'and its generation only moves forward');
});

test('ticket33 a released member is never probed, reads offline and can be taken over directly', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Gone', pid: 0, now: 1_000 });
  const h = await panelHost(t, workspace);
  const probes: number[] = [];
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: candidate => { probes.push(candidate); return candidate !== 4242; } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  // The tool path reads the same rule: a released record never reaches the probe.
  const inspected = JSON.parse((await h.tools.get('team_inspect').execute('t33', { name: 'Gone' }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(inspected.member.state, 'offline', 'a released member reads offline');
  assert.equal(probes.includes(0), false, 'pid 0 is never handed to the liveness probe');
  // The panel shows it as offline, not as "held by another process".
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  // The roster scrolls: dock the member row before reading its state.
  for (let step = 0; step < 80 && !frame().includes('Gone'); step++) await panels.press('j');
  assert.match(frame(), /Gone[^\n]*离线/, 'the released member reads offline in the panel');
  assert.doesNotMatch(frame(), /Gone[^\n]*被另一进程持有/, 'a released member is not reported as held');
  assert.equal(probes.includes(0), false, 'the panel never probes pid 0 either');
  // A released record can be claimed directly: no force, no "old process still running".
  await sessionFile(root, 's2');
  const calls = switchingHost(h, { cancelled: false, livePanels: () => panels.live() });
  const switched = await registration.switchTo(h.ctx, 'Gone').catch(cause => String(cause));
  assert.equal(switched, 'switched', `a released member is taken over without force (${switched})`);
  assert.equal(calls.length, 1, 'the switch really ran');
  assert.equal(calls[0]!.livePanels, 0, 'the panel was closed before the session switch');
  assert.equal(probes.includes(0), false, 'and still never probed pid 0');
  await opening;
});

test('ticket33 a host without switchSession rolls the takeover back without rewinding generations', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 10, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  const before = await readMembers(alpha.id);
  assert.equal(h.ctx.switchSession, undefined, 'this host has no switchSession');
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'degraded');
  const after = await readMembers(alpha.id);
  for (const name of ['Lead', 'Worker']) {
    const previous = before.find(member => member.name === name)!, current = after.find(member => member.name === name)!;
    assert.equal(current.holder.pid, previous.holder.pid, `${name} gets its holder pid back`);
    assert.equal(current.state, previous.state, `${name} gets its state back`);
    assert.ok(current.generation > previous.generation, `${name} only moves its generation forward`);
  }
  const notice = h.notices.at(-1)!.message;
  assert.match(notice, /未切换/, 'the notice says the session was not switched');
  assert.match(notice, /所有权未变/, 'and that ownership is unchanged');
  assert.match(notice, /'--session' 's2'/, 'and hands over the command that would do it');
});

test('ticket32 a host without switchSession degrades out loud', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 10, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  assert.equal(h.ctx.switchSession, undefined, 'this host has no switchSession');
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'degraded');
  const notice = h.notices.at(-1)!.message;
  assert.match(notice, /本宿主无法就地切换/, 'the degrade is stated, never silent');
  assert.match(notice, /'--session' 's2'/, 'and hands over the command that would do it');
});

test('ticket32 every root row starts a new session and every member pull-up continues one', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const spawns: { command: string; args: string[] }[] = [];
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: (pid: number) => pid !== 4242, wait: async () => {}, launchDeps: { spawn: ((command: string, args: string[]) => { spawns.push({ command, args }); return { pid: 4321, exitCode: null, signalCode: null, unref() {}, on() {} }; }) as any, adapters: { tmux: true, graphical: true, terminal: 'kitty' }, mkfifo: () => {}, openFifo: () => 'ignore' as const, wait: async () => {}, alive: () => true } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const focus = (word: string) => teamFocus(panels, word);
  /** Click a row and return the command the panel reported for it. */
  const click = async (label: string): Promise<string> => {
    await focus(label);
    const before = h.notices.length;
    await panels.press('\r');
    await panels.wait(() => h.notices.length > before);
    return h.notices.at(-1)!.message;
  };
  // Root: all six rows must start a new session. Driven through the panel, not the API, so a row that
  // quietly passes a session id is caught (that blind spot survived 90 tests before this test).
  await focus('Alpha .'); await panels.press('l');
  await focus('新建会话'); await panels.press('l');
  await focus('启动方式'); await panels.press('l');
  for (const label of ['自动检测', '分屏启动', 'tmux 新窗口', '桌面窗口', '后台启动', '复制启动命令']) {
    const seen = spawns.length;
    const notice = await click(label);
    // A background row announces a failure here because its fake child never joins: the argv it really
    // spawned is what proves the session rule, not the notice.
    const evidence = spawns.length > seen ? `${spawns.at(-1)!.command} ${spawns.at(-1)!.args.join(' ')}` : notice;
    assert.doesNotMatch(evidence, /--session/, `root ${label} starts a new session`);
  }
  for (const spawned of spawns) assert.doesNotMatch(spawned.args.join(' '), /--session/, `root ${spawned.command} never continues a session`);
  assert.ok(spawns.length >= 4, 'the spawning root rows really spawned');
  // Member: every pull-up continues that member's session.
  spawns.length = 0;
  await panels.press('h'); await panels.press('h'); await delay(150);
  await focus('Worker'); await panels.press('l');
  await focus('启动会话'); await panels.press('l');
  for (const label of ['后台拉起', '分屏拉起', 'tmux 新窗口拉起', '桌面窗口拉起', '复制拉起命令']) {
    const seen = spawns.length;
    const notice = await click(label);
    const evidence = spawns.length > seen ? `${spawns.at(-1)!.command} ${spawns.at(-1)!.args.join(' ')}` : notice;
    assert.ok(evidence.includes('--session') && evidence.includes('s2'), `member ${label} continues the session`);
  }
  for (const spawned of spawns) assert.match(spawned.args.join(' '), /--session/, `member ${spawned.command} continues the session`);
  await closePanel(panels, opening);
});

test('ticket26 a member row pulls that session and is the only place that passes --session', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Helper', pid: 999, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const spawns: { command: string; args: string[] }[] = [];
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: candidate => candidate !== 999, wait: async () => {}, launchDeps: { spawn: ((command: string, args: string[]) => { spawns.push({ command, args }); return { pid: 4321, exitCode: null, signalCode: null, unref() {}, on() {} }; }) as any, adapters: { tmux: false, graphical: false }, mkfifo: () => {}, openFifo: () => 'ignore' as const, wait: async () => {}, alive: () => true } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const focus = (word: string) => teamFocus(panels, word);
  await focus('Helper'); await panels.press('l');
  await focus('启动会话'); await panels.press('l');
  // The offline member carries the pull-ups inside its expandable start menu, in order, before any governance rows.
  const order: string[] = [];
  for (const label of ['状态', '后台拉起', '分屏拉起', 'tmux 新窗口拉起', '复制拉起命令', '接管会话', '强制接管', '发送消息', '移出名册']) { await focus(label); order.push(label); }
  assert.deepEqual(order, ['状态', '后台拉起', '分屏拉起', 'tmux 新窗口拉起', '复制拉起命令', '接管会话', '强制接管', '发送消息', '移出名册'], 'the member row groups read-only, pull-ups, takeover, governance, removal');
  // A pull-up continues that session: the notice must say so and the command must carry --session <id>.
  const noticesBefore = h.notices.length;
  await focus('复制拉起命令'); await panels.press('\r');
  await panels.wait(() => h.notices.length > noticesBefore);
  const pulled = h.notices.at(-1)!.message;
  assert.match(pulled, /接着成员会话/, 'a member pull-up is announced as continuing that session');
  assert.match(pulled, /--session 's2'/, 'a member pull-up continues that session');
  // A background pull-up really spawns with the session id.
  await focus('后台拉起'); await panels.press('\r');
  await panels.wait(() => spawns.length === 1);
  assert.deepEqual(spawns[0]!.args.slice(1), ['--team', 'Alpha', '-e', teamExtensionPath(), '--session', 's2', '--mode', 'rpc'], 'the pull-up resumes the member session');
  // The record is only bound to a process that confirms itself; this fake one never does.
  await panels.wait(() => /派发失败/.test(h.notices.at(-1)!.message));
  assert.match(h.notices.at(-1)!.message, /未在 5 秒内确认加入团队/, 'an unconfirmed background pull-up is not reported as a started member');
  // The root-versus-member boundary is asserted for every row in the ticket32 test.
  await closePanel(panels, opening);
});

test('ticket26 退出团队 lives on the team row only while 移出名册 removes the other member', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Helper', pid: 999, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: candidate => candidate !== 999, launchDeps: { spawn: (() => ({ unref() {} })) as any, adapters: { tmux: false, graphical: false }, wait: async () => {} } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focus = (word: string) => teamFocus(panels, word);
  // Leaving belongs to the team row only: your own row must not offer a second, duplicate exit.
  await focus('Lead'); await panels.press('l');
  assert.doesNotMatch(frame(), /退出团队/, 'your own member row carries no exit row');
  assert.doesNotMatch(frame(), /移出名册/, 'your own row has no evict action');
  await panels.press('h'); await delay(150);
  // Another member's row offers eviction, not leaving on their behalf.
  await focus('Helper'); await panels.press('l');
  await focus('移出名册');
  assert.match(focused(panels), /移出团队/);
  assert.doesNotMatch(focused(panels), /退出团队/);
  await panels.press('\r');
  assert.match(frame(), /移出成员 Helper/); assert.match(frame(), /仅移除名册记录/, 'an already-exited member is not described as being stopped again');
  await panels.press('\r');
  await panels.wait(() => h.notices.some(notice => /已将 Helper 移出名册/.test(notice.message)));
  assert.deepEqual((await readMembers(alpha.id)).map(member => member.name), ['Lead'], 'evicting drops the other member only');
  await closePanel(panels, opening);
});

test('ticket26 停止此成员进程 is offered only for a running member and leaves it offline', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Coder', pid: 4242, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's3', sessionName: 'Gone', pid: 999, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  let coderAlive = true;
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, kill: () => { coderAlive = false; }, wait: async () => {}, alive: candidate => candidate === 4242 ? coderAlive : candidate !== 999, launchDeps: { spawn: (() => ({ unref() {} })) as any, adapters: { tmux: false, graphical: false } } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focus = (word: string) => teamFocus(panels, word);
  // A member with a live pid can be stopped from the panel.
  await focus('Coder'); await panels.press('l');
  await focus('停止此成员进程');
  assert.match(focused(panels), /停止此成员进程/);
  // A member without a live pid has nothing to stop, so the row is absent.
  await panels.press('h'); await delay(150);
  await focus('Gone'); await panels.press('l');
  await focus('移出名册');
  assert.doesNotMatch(frame(), /停止此成员进程/, 'a member without a live pid is never offered the stop action');
  // Two Enters stop the running member; the record survives as offline so a pull-up can resume it.
  await panels.press('h'); await delay(150);
  await focus('Coder'); await panels.press('l');
  await focus('停止此成员进程'); await panels.press('\r');
  assert.match(frame(), /停止 Coder 的进程/); assert.match(frame(), /再次 Enter 停止/, 'the first Enter only arms stopping');
  await panels.press('\r');
  await panels.wait(() => h.notices.some(notice => /已停止 Coder 的进程/.test(notice.message)));
  const stopped = (await readMembers(alpha.id)).find(member => member.name === 'Coder')!;
  assert.equal(stopped.state, 'offline', 'the record stays, reading offline');
  await closePanel(panels, opening);
});

test('ticket26 the current team row leaves and another team row joins', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await createTeam({ name: 'Beta', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: () => true, launchDeps: { spawn: (() => ({ unref() {} })) as any, adapters: { tmux: false, graphical: false } } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focus = (word: string) => teamFocus(panels, word);
  // Viewing another team is separate from changing this session's membership.
  await focus('Alpha .'); await panels.press('l');
  await focus('退出团队');
  assert.match(focused(panels), /退出团队/);
  assert.doesNotMatch(frame(), /加入当前会话/, 'the joined team offers leaving rather than joining itself again');
  await panels.press('h'); await delay(150);
  await focus('Beta .'); await panels.press('l');
  await focus('查看成员');
  assert.match(focused(panels), /查看成员/);
  // This session already belongs to Alpha, so Beta's join row is present but refused with the reason.
  for (let step = 0; step < 8 && !panels.frame().join('\n').includes('加入当前会话'); step++) await panels.press('j');
  assert.match(panels.frame().join('\n'), /加入当前会话/, 'another team keeps an explicit current-session join entry');
  await panels.press('h'); await delay(150);
  // Two Enters leave the team instead of evicting some other session.
  await focus('Alpha .'); await panels.press('l');
  await focus('退出团队'); await panels.press('\r');
  assert.match(frame(), /退出团队 Alpha/); assert.doesNotMatch(frame(), /不可撤销|确认删除/);
  await panels.press('\r');
  await panels.wait(() => h.notices.some(notice => /已退出团队/.test(notice.message)));
  assert.equal(registration.pointer(h.ctx), undefined, 'leaving clears the pointer');
  await closePanel(panels, opening);
});

test('ticket14 the custom desktop command row keeps its leading icon instead of losing it to the tail marker', async t => {
  await agentDir(t);
  const icon = String.fromCodePoint(0xf0208);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const row = () => panels.frame().find(line => line.includes('自定义命令'));
  const focus = (word: string) => teamFocus(panels, word);
  await focus('自定义命令');
  const line = row()!;
  assert.match(line, new RegExp(`${icon} 自定义命令`), `the icon leads the label: ${line}`);
  assert.equal([...line].filter(char => char === icon).length, 1, `exactly one icon: ${line}`);
  await closePanel(panels, opening);
});

test('the two renames are independent: member rename never touches the session name', { timeout: 30000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await renameMember(alpha.id, 's1', 'Renamed');
  assert.equal((await readMembers(alpha.id))[0]!.name, 'Renamed');
  const h = await panelHost(t, workspace);
  const panel = { register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => undefined } as any;
  const registration = registerTeam(h.pi, { msg: chinese, panel });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Renamed' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, { msg: chinese, panel, currentTeamId: () => alpha.id, setCurrentTeam: () => {}, pointer: registration.pointer, join: registration.join, leave: registration.leave, takeover: registration.takeover, create: registration.create, launch: registration.launch, switchTo: registration.switchTo, evict: registration.evict, stop: registration.stop, deleteSession: registration.deleteSession, rebuild: registration.rebuild, sessionFileState: registration.sessionFileState, desktop: registration.desktop, setDesktop: registration.setDesktop, history: registration.history, resumeCommand: registration.resumeCommand, pid: registration.pid, ...(registration.alive ? { alive: registration.alive } : {}), renameSession: name => h.pi.setSessionName(name) });
  await panels.wait(() => panels.live() === 1);
  // Rename member directly through IO and rename session via the Pi API callback.
  h.pi.setSessionName('New Session');
  assert.deepEqual(h.renames, ['New Session'], 'setSessionName is called directly without touching members');
  assert.equal((await readMembers(alpha.id))[0]!.name, 'Renamed', 'the session rename does not touch the roster name');
  await closePanel(panels, opening);
});

test('ticket31 the panel edits the desktop terminal and rejects a template without {command}', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, launchDeps: { spawn: (() => ({ unref() {} })) as any, adapters: { tmux: false, graphical: false } } });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const { loadConfig } = await import('../src/shared/config.ts');
  const { readFile } = await import('node:fs/promises');
  const configFile = join(root, 'pi-dag-workflow', 'pi-dag-workflow-config.json');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  const focus = (word: string) => teamFocus(panels, word);
  // The cycle row writes the flat key and takes effect on the next read.
  await focus('桌面终端');
  assert.match(focused(panels), /自动探测/, 'the row shows the stored value');
  await panels.press('\r');
  for (let attempt = 0; attempt < 40; attempt += 1) { if ((await loadConfig(chinese, 'team')).desktopTerminal === 'kitty') break; await delay(20); }
  assert.equal((await loadConfig(chinese, 'team')).desktopTerminal, 'kitty', 'cycling the row persists desktopTerminal');
  // An invalid template is refused in place: the hint names the rule and nothing is written.
  await focus('自定义命令'); await panels.press('\r');
  await panels.press('\x01'); await panels.press('\x0b'); await panels.press('kitty');
  await panels.press('\r');
  assert.match(frame(), /必须包含 \{command\}/, 'the panel says why the template was refused');
  assert.equal((await loadConfig(chinese, 'team')).desktopCommand, '', 'the invalid template never reached the config');
  // A rejected submit keeps the draft and the cursor: fix it in place instead of re-entering the row.
  // The engine keeps the draft when its validator rejects, so fixing it in place is enough.
  await panels.press('\x01'); await panels.press('\x0b'); await panels.press('kitty {command}');
  await panels.press('\r');
  for (let attempt = 0; attempt < 40; attempt += 1) { if ((await loadConfig(chinese, 'team')).desktopCommand === 'kitty {command}') break; await delay(20); }
  assert.equal((await loadConfig(chinese, 'team')).desktopCommand, 'kitty {command}', 'a valid template is saved');
  assert.match(await readFile(configFile, 'utf8'), /"desktopCommand": "kitty \{command\}"/, 'it is the flat config key on disk');
  await closePanel(panels, opening);
});

test('ticket37 a loaded session without the member pointer warns instead of pretending to be that member', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 10, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  // The stub hands `withSession` a session whose branch has no team pointer.
  const calls = switchingHost(h, { cancelled: false, branch: [] });
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  assert.equal(calls.length, 1, 'the switch still happens');
  const notice = h.notices.at(-1)!;
  assert.match(notice.message, /没有成员 Worker 的团队指针/, 'the missing pointer is reported');
  assert.equal(notice.level, 'warning', 'and reported as a warning, not as success');
  assert.equal(h.notices.some(item => /现在是成员 Worker/.test(item.message)), false, 'it never claims to be the member');
  // The record is still claimed: the switch did load that session file.
  assert.equal((await readMembers(alpha.id)).find(member => member.name === 'Worker')!.holder.pid, 10);
});

test('ticket27 a long turn reads as 后台 in the panel and as ok from team_inspect', async t => {
  const agentRoot = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const threeMinutesAgo = Date.now() - 3 * 60_000;
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: Date.now() });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Writer', pid: 222, now: threeMinutesAgo });
  // A background launch is the only source of headless: the record says so from its first second.
  const memberFile = join(agentRoot, 'pi-dag-workflow', 'teams', alpha.id, 'members', 's2.json');
  await writeFile(memberFile, JSON.stringify({ ...JSON.parse(await readFile(memberFile, 'utf8')), state: 'headless' }));
  const inspect = async (h: ReturnType<typeof host>) => JSON.parse((await h.tools.get('team_inspect').execute('t27', { name: 'Writer' }, undefined, undefined, h.ctx)).content[0].text).member;
  const renderRow = async (h: ReturnType<typeof host>, registration: ReturnType<typeof registerTeam>) => {
    const { teamMenu } = await import('../src/team/commands/menu.ts');
    const panels = recordPanels(h.ctx);
    const opening = teamMenu(h.ctx, launchHooks(h, menuPanel(), registration, () => alpha.id, () => {}));
    await panels.wait(() => panels.live() === 1);
    const frame = () => panels.frame().join('\n');
    for (const key of ['j', 'k']) for (let step = 0; step < 60; step++) { if (/Writer/.test(frame())) break; await panels.press(key); }
    const row = frame().split('\n').find(line => line.includes('Writer')) ?? '';
    await closePanel(panels, opening);
    return row;
  };

  // A probeable, live process: the heartbeat is three minutes old because the turn is long, not because it died.
  const alive = await panelHost(t, workspace);
  const aliveRegistration = registerTeam(alive.pi, { msg: chinese, panel: menuPanel(), pid: () => 111, alive: pid => pid === 222 });
  alive.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const aliveRow = await renderRow(alive, aliveRegistration);
  assert.match(aliveRow, /后台/, `a live background member reads as working: ${aliveRow}`);
  assert.doesNotMatch(aliveRow, /心跳已/, `a live process is never labelled stale: ${aliveRow}`);
  const aliveInspect = await inspect(alive);
  assert.equal(aliveInspect.state, 'headless', 'team_inspect agrees on the state');
  assert.equal(aliveInspect.reason, 'ok', 'team_inspect agrees on the reason');

  // A host that cannot probe reports unknown on both sides: silence is not an exit and not a stale beat.
  const blind = await panelHost(t, workspace);
  const blindRegistration = registerTeam(blind.pi, { msg: chinese, panel: menuPanel(), pid: () => 111 });
  blind.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const blindRow = await renderRow(blind, blindRegistration);
  assert.match(blindRow, /无法确认进程（pid 222）/, `an unprobeable pid reads unknown: ${blindRow}`);
  const blindInspect = await inspect(blind);
  assert.equal(blindInspect.reason, 'unknown', 'team_inspect agrees on the unknown reason');
});

test('ticket47 only the process that holds its own record releases it during a takeover', async t => {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 222, now: 1_000 });
  const now = Date.now();
  // Another process took the Lead record over: this session no longer represents it.
  await claimOwnership(team.id, 's1', { pid: 333, now, force: true, probe: () => true });
  const leadBefore = (await readMembers(team.id)).find(member => member.name === 'Lead')!;
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 111, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  const switching = switchingHost(h);
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  assert.equal(switching.length, 1, 'the switch happened');
  const leadAfter = (await readMembers(team.id)).find(member => member.name === 'Lead')!;
  assert.equal(leadAfter.holder.pid, leadBefore.holder.pid, 'the record this session does not hold is left alone');
  assert.equal(leadAfter.generation, leadBefore.generation);
});

test('ticket47 the leaving session is refused when a live process took its record', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: 1_000 });
  // A live foreign process now holds this session's record.
  await claimOwnership(alpha.id, 's1', { pid: 222, now: Date.now(), force: true, probe: () => true });
  const taken = (await readMembers(alpha.id))[0]!;
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 111, alive: pid => pid === 222 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  // A refused departure is an error, not a silent “nothing happened”.
  await assert.rejects(registration.leave(h.ctx, { authorized: true }), /已被另一进程接管：未退出，成员记录未变/);
  const record = (await readMembers(alpha.id))[0]!;
  assert.equal(record.holder.pid, 222, 'the new holder keeps its record');
  assert.equal(record.generation, taken.generation, 'and its generation');
  assert.match(h.notices.map(notice => notice.message).join('\n'), /已被另一进程接管：未退出，成员记录未变/, `the session is told why\n${JSON.stringify(h.notices)}`);
  // The pointer is written with data === undefined to clear it; a refused departure must not clear it.
  assert.notEqual(h.appends.filter(entry => entry.type === 'pi-dag-workflow.team-pointer').at(-1)?.data, undefined, 'and its pointer is kept');
});

test('ticket47 an evict that loses the record to a takeover keeps it', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 222, now: 1_000 });
  const h = await panelHost(t, workspace);
  let signalled!: () => void;
  const signalledP = new Promise<void>(resolve => { signalled = resolve; });
  // The stop never lands, so the grace loop is still running when the takeover happens.
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 111, alive: pid => pid === 222, kill: () => { signalled(); }, wait: async () => {} });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const evicting = registration.evict(h.ctx, 'Worker').then(() => undefined, (error: unknown) => error as Error);
  await Promise.race([signalledP, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the evict never signalled the old process')), 5000))]);
  // A live process takes the record over while the evict is still in its stop grace loop.
  await claimOwnership(alpha.id, 's2', { pid: 333, now: Date.now(), force: true, probe: () => true });
  // The process never exited, so the eviction is reported as a failure instead of a claimed stop.
  const refusal = await evicting;
  assert.match(String(refusal?.message), /未移出，记录与信箱保留/);
  const record = (await readMembers(alpha.id)).find(member => member.name === 'Worker')!;
  assert.equal(record.holder.pid, 333, 'the record now belongs to the new holder and is kept');
});

/** Pause the first read of one member record: the caller sees the bytes as they were before the pause. */
async function pauseFirstRecordRead(t: { after(fn: () => unknown): void }, teamId: string, sessionId: string) {
  const original = fsPromises.readFile;
  const target = join(teamsRoot(), teamId, 'members', `${sessionId}.json`);
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  let heldSignal!: () => void;
  const held = new Promise<void>(resolve => { heldSignal = resolve; });
  let paused = false;
  fsPromises.readFile = (async (...args: any[]) => {
    const bytes = await (original as any).apply(fsPromises, args);
    if (!paused && String(args[0]) === target) { paused = true; heldSignal(); await resume; }
    return bytes;
  }) as typeof fsPromises.readFile;
  syncBuiltinESMExports();
  const restore = () => { fsPromises.readFile = original; syncBuiltinESMExports(); };
  t.after(restore);
  return { held, release: () => release(), restore };
}

test('ticket49 a cancelled takeover rolls back to the record its claim replaced', async t => {
  const root = await agentDir(t);
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'), 'the record under test lives in this run');
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 111, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 222, now: 1_000 });
  await sessionFile(root, 's2');
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 111, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const reader = await pauseFirstRecordRead(t, alpha.id, 's2');
  const cancelling = switchingHost(h, { cancelled: true });
  let switching: Promise<string> | undefined;
  try {
    // switchTo reads the roster (Worker is pid 222) and waits inside that read.
    switching = registration.switchTo(h.ctx, 'Worker', true);
    await Promise.race([reader.held, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the takeover never read the record')), 5000))]);
    // A third party takes the record over while that stale read is still held.
    await claimOwnership(alpha.id, 's2', { pid: 333, now: Date.now(), force: true, probe: () => true });
    reader.release();
    await assert.rejects(switching, /会话切换被取消/);
    switching = undefined;
    assert.equal(cancelling.length, 1, 'the switch was attempted');
    const worker = (await readMembers(alpha.id)).find(member => member.name === 'Worker')!;
    // The claim replaced pid 333, so the rollback restores 333 — not the pid 222 from before the lock.
    assert.equal(worker.holder.pid, 333, 'the rollback returns the holder the claim actually replaced');
    assert.equal(worker.state, 'attached', 'and the state it replaced');
    assert.equal(worker.generation, 4, 'with a forward-only generation (222→333→111→333)');
    const lead = (await readMembers(alpha.id)).find(member => member.name === 'Lead')!;
    assert.equal(lead.holder.pid, 111, 'the source record is restored to this process');
    assert.equal(lead.state, 'attached');
  } finally {
    reader.release();
    reader.restore();
    if (switching) await switching.catch(() => {});
  }
});

test('ticket49b a takeover carries the physical channel to the member this process now represents', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const runtimeDir = join(teamsRoot(), alpha.id, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  // This process's own RPC channel: the record's PID is this pid and the sidecar agrees.
  const channel = runtimePairFor(teamsRoot(), alpha.id);
  await writeFile(channel.fifo, ''); await writeFile(channel.log, '');
  await writeRuntimePid(channel.pidFile, 10);
  await bindMemberRuntime(alpha.id, 's1', { ...channel, pid: 10 }, 10);
  // The target's own pair belongs to the process it used to run: it must not become this pid's channel.
  const oldWorker = runtimePairFor(teamsRoot(), alpha.id);
  await writeFile(oldWorker.fifo, ''); await writeFile(oldWorker.log, '');
  await writeRuntimePid(oldWorker.pidFile, 4242);
  await bindMemberRuntime(alpha.id, 's2', { ...oldWorker, pid: 4242 }, 4242);
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: pid => pid === 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  switchingHost(h, { cancelled: false, branch: [{ customType: 'pi-dag-workflow.team-pointer', data: { teamId: alpha.id, memberName: 'Worker' } }] });
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  const members = await readMembers(alpha.id);
  const worker = members.find(member => member.sessionId === 's2')!;
  const lead = members.find(member => member.sessionId === 's1')!;
  assert.deepEqual(worker.runtime, { ...channel, pid: 10 }, 'the member this process now represents owns the real channel');
  assert.notEqual(worker.runtime!.fifo, oldWorker.fifo, 'the old target pair is not read as the new physical PID');
  assert.equal(lead.holder.pid, 0, 'the member this process used to represent lost its holder');
  // The live channel is old enough that the preparation window cannot be what saves it: only the sidecar
  // PID being this running process keeps a stop or a cleanup away from it.
  const old = new Date(Date.now() - 120_000);
  for (const path of [channel.fifo, channel.log, channel.pidFile]) await utimes(path, old, old);
  const report = await cleanupRuntimeFiles(teamsRoot(), alpha.id, await readMembers(alpha.id), { alive: pid => pid === 10, now: Date.now(), prepareMs: 30_000 });
  assert.equal(report.removed, 3, 'the pair whose process is gone is cleaned');
  const present = async (path: string) => readFile(path).then(() => true, () => false);
  assert.equal(await present(channel.fifo), true, 'the live channel FIFO stays');
  assert.equal(await present(channel.log), true, 'and its log');
  assert.equal(await present(channel.pidFile), true, 'and its sidecar');
  assert.equal(await present(oldWorker.fifo), false, 'the dead old target pair is gone');
});

test('ticket56 a spliced runtime cannot carry a channel into a takeover', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const runtimeDir = join(teamsRoot(), alpha.id, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  // Launch A belongs to another process; its sidecar names 777, which is alive.
  const foreign = runtimePairFor(teamsRoot(), alpha.id);
  await writeFile(foreign.fifo, ''); await writeFile(foreign.log, '');
  await writeRuntimePid(foreign.pidFile, 777);
  // Launch B is this process's own: its sidecar names this pid, and the record splices the two.
  const own = runtimePairFor(teamsRoot(), alpha.id);
  await writeFile(own.pidFile, `${'10'}\n`);
  await setMemberRuntime(alpha.id, 's1', { fifo: foreign.fifo, log: foreign.log, pidFile: own.pidFile, pid: 10 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: pid => pid === 10 || pid === 777 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  switchingHost(h, { cancelled: false, branch: [{ customType: 'pi-dag-workflow.team-pointer', data: { teamId: alpha.id, memberName: 'Worker' } }] });
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  const worker = (await readMembers(alpha.id)).find(member => member.sessionId === 's2')!;
  // The same narrow rule as a deletion: a spliced record proves no single launch, so no channel moves.
  assert.equal(worker.runtime, undefined, 'the spliced channel is not adopted by the member this process now holds');
  assert.equal(await readFile(foreign.fifo).then(() => true, () => false), true, 'and the foreign pair is untouched');
  assert.equal(await readFile(foreign.pidFile).then(() => true, () => false), true, 'including its sidecar');
});

test('ticket58 a leaf symlink in the source stem is never adopted as the channel', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  const runtimeDir = join(teamsRoot(), alpha.id, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  // A real launch set except the FIFO: its stem is right, its leaf is a symlink to a file outside the team.
  const pair = runtimePairFor(teamsRoot(), alpha.id);
  const sentinel = join(root, 'outside-sentinel.fifo');
  await writeFile(sentinel, 'precious channel\n');
  await symlink(sentinel, pair.fifo, 'file');
  await writeFile(pair.log, '');
  await writeRuntimePid(pair.pidFile, 10);
  await setMemberRuntime(alpha.id, 's1', { ...pair, pid: 10 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: pid => pid === 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  switchingHost(h, { cancelled: false, branch: [{ customType: 'pi-dag-workflow.team-pointer', data: { teamId: alpha.id, memberName: 'Worker' } }] });
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  const worker = (await readMembers(alpha.id)).find(member => member.sessionId === 's2')!;
  assert.equal(worker.runtime, undefined, 'a symlinked FIFO is not a launch channel');
  assert.equal(await readFile(sentinel, 'utf8'), 'precious channel\n', 'the sentinel bytes are untouched');
  // The human hears that the channel did not follow, instead of silently losing it.
  assert.match(h.notices.map(notice => notice.message).join('\n'), /源通道未采用/, 'the switch reports the declined channel');
});

test('ticket58 repeated roles are never adopted as the channel', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  await mkdir(join(teamsRoot(), alpha.id, 'runtime'), { recursive: true });
  // The same PID file named as all three roles: three copies of one file are not a launch.
  const pair = runtimePairFor(teamsRoot(), alpha.id);
  await writeRuntimePid(pair.pidFile, 10);
  await setMemberRuntime(alpha.id, 's1', { fifo: pair.pidFile, log: pair.pidFile, pidFile: pair.pidFile, pid: 10 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: pid => pid === 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  switchingHost(h, { cancelled: false, branch: [{ customType: 'pi-dag-workflow.team-pointer', data: { teamId: alpha.id, memberName: 'Worker' } }] });
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's2')!.runtime, undefined, 'one file cannot fill three roles');
  assert.match(h.notices.map(notice => notice.message).join('\n'), /源通道未采用/, 'and the switch says so');
});

test('ticket58 swapped roles are never adopted as the channel', async t => {
  const root = await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 4242, now: 1_000 });
  await mkdir(join(teamsRoot(), alpha.id, 'runtime'), { recursive: true });
  // Both files are real and share the stem, but each is named for the other role.
  const pair = runtimePairFor(teamsRoot(), alpha.id);
  await writeFile(pair.fifo, ''); await writeFile(pair.log, '');
  await writeRuntimePid(pair.pidFile, 10);
  await setMemberRuntime(alpha.id, 's1', { fifo: pair.log, log: pair.fifo, pidFile: pair.pidFile, pid: 10 });
  const h = await panelHost(t, workspace);
  const registration = registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: pid => pid === 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await sessionFile(root, 's2');
  switchingHost(h, { cancelled: false, branch: [{ customType: 'pi-dag-workflow.team-pointer', data: { teamId: alpha.id, memberName: 'Worker' } }] });
  assert.equal(await registration.switchTo(h.ctx, 'Worker'), 'switched');
  assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's2')!.runtime, undefined, 'a swapped role is not the channel');
});

test('ticket45 the panel renames this member without losing its identity or hold', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  // A fresh heartbeat: the panel's own redraw reclaims a silent member, and this test is about the rename.
  const now = Date.now();
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now });
  // A legacy shared-task file from an older team directory: the panel must never read or write it.
  const legacyPath = join(teamsRoot(), alpha.id, 'todos', '1.json');
  await mkdir(dirnameP(legacyPath), { recursive: true });
  await writeFile(legacyPath, '{"id":1,"title":"legacy","state":"in_progress","owner":"Lead","blockedBy":[],"generation":3}\n');
  const legacyBytes = await readFile(legacyPath, 'utf8');
  const beforeHold = (await readMembers(alpha.id)).find(member => member.sessionId === 's1')!;
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  const registration = registerTeam(h.pi, { msg: chinese, panel, pid: () => 10 });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const { teamMenu } = await import('../src/team/commands/menu.ts');
  const panels = recordPanels(h.ctx);
  const opening = teamMenu(h.ctx, launchHooks(h, panel, registration, () => alpha.id, () => {}));
  await panels.wait(() => panels.live() === 1);
  const focusRow = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 80; step++) { if (panels.frame().find(line => /^[ │]*> /.test(line) && line.includes(word))) return; await panels.press(key); } throw new Error(`row not found: ${word}`); };
  await focusRow('Lead'); await panels.press('l');
  await teamFocus(panels, '重命名成员');
  await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press('Lead Two'); await panels.press('\r');
  for (let attempt = 0; attempt < 80; attempt++) { if ((await readMembers(alpha.id)).find(member => member.sessionId === 's1')?.name === 'Lead Two') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const renamed = (await readMembers(alpha.id)).find(member => member.sessionId === 's1')!;
  assert.equal(renamed.name, 'Lead Two', 'the panel renamed this session');
  assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's2')!.name, 'Worker', 'and nobody else');
  // The panel still belongs to the same session: holder and generation did not move.
  assert.equal(renamed.holder.pid, beforeHold.holder.pid, 'the holder is untouched by a rename');
  assert.equal(renamed.generation, beforeHold.generation, 'and so is the generation');
  // A rename never touches the legacy task file either: the shared list is not a product surface any more.
  assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes, 'the legacy task file keeps its bytes');
  await closePanel(panels, opening);
});



test('ticket57 a peer policy row writes the addressed session, and a lost holder cannot', { timeout: 5_000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Helper', pid: 22, now: 1_000 });
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  let open: ((ctx: any) => Promise<void>) | undefined;
  panel.register = (factory: (ctx: any) => Promise<void>) => { open = factory; };
  registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: () => true });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const panels = recordPanels(h.ctx);
  assert.ok(open, 'the production registration supplies its own menu hooks');
  await h.fire('session_start');
  const opening = withMenuScope(h.ctx, () => open!(h.ctx));
  try {
    await panels.wait(() => panels.live() === 1);
    await panels.focus('Helper'); await panels.press('l');
    await teamFocus(panels, '收信策略');
    await panels.press('\r');
    for (let attempt = 0; attempt < 200 && (await readMembers(alpha.id)).find(member => member.sessionId === 's2')!.autoMessages !== 'all'; attempt++) await delay(2);
    assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's2')!.autoMessages, 'all', 'the real row writes the peer by SID');
    assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's1')!.autoMessages ?? 'background', 'background', 'the actor policy is untouched');
    await noteMemberEvent(alpha.id, 's2', { ownerPid: 22, instanceId: 'peer-runtime' });
    const edit = async (label: string, value: string) => {
      const notices = h.notices.length;
      await panels.focus(label); await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press(value);
      const paints = panels.forces.length;
      await panels.press('\r');
      await panels.wait(() => h.notices.length > notices && panels.forces.length > paints);
      assert.match(h.notices.at(-1)!.message, /设置请求已提交/);
    };
    await panels.press('h'); await panels.focus('会话操作'); await panels.press('l'); await panels.focus('运行配置'); await panels.press('l');
    const chosenModel = ['dag-test', 'reasoned'].join('/');
    await edit('模型', chosenModel); await edit('思考等级', 'high');
    await panels.press('h'); await panels.press('h'); await panels.focus('成员管理'); await panels.press('l');
    await edit('重命名成员', 'Peer label'); await edit('重命名会话', 'Peer session');
    const target = (await readMembers(alpha.id)).find(member => member.sessionId === 's2')!;
    assert.deepEqual(target.control?.patch, { model: chosenModel, thinking: 'high', memberName: 'Peer label', sessionName: 'Peer session' }, 'all real panel inputs address the peer SID');
    assert.equal(target.control?.status, 'pending', 'submitted is not falsely reported as applied');
    assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's1')!.control, undefined, 'the acting session receives no peer settings');
    await panels.focus('收信策略');
    // Keep the allowed frame mounted, then replace its actor before Enter: the runtime guard must reject it.
    await claimOwnership(alpha.id, 's1', { pid: 999, now: Date.now(), force: true, probe: () => true });
    await panels.press('\r');
    await panels.wait(() => h.notices.some(notice => /已被接管/.test(notice.message)));
    assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 's2')!.autoMessages, 'all', 'an old frame grants no write after takeover');
  } finally {
    await h.fire('session_shutdown');
    h.ctx.hasUI = false;
    await closeMountedPanel(h.ctx);
    await opening;
  }
});

test('ticket58 the real member accordion previews all pages and requests only the selected peer', { timeout: 8_000 }, async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Helper', pid: 22, now: 1_000 });
  // Message #2 is as recent as #10: time order differs from arrival/id order, and a tie must use id.
  for (let id = 1; id <= 11; id++) await sendToMember(alpha.id, { from: 'Lead', fromId: 's1', toSessionId: 's2', body: `PAGE-BODY-${id}`, now: id === 2 ? 100 : id * 10 });
  const inboxPath = join(teamsRoot(), alpha.id, 'inboxes', 's2.json');
  const before = await readFile(inboxPath, 'utf8');
  const h = await panelHost(t, workspace);
  const panel = menuPanel();
  let open: ((ctx: any) => Promise<void>) | undefined;
  panel.register = (factory: (ctx: any) => Promise<void>) => { open = factory; };
  registerTeam(h.pi, { msg: chinese, panel, pid: () => 10, alive: () => true });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  const panels = recordPanels(h.ctx);
  assert.ok(open);
  const opening = withMenuScope(h.ctx, () => open!(h.ctx));
  try {
    await panels.wait(() => panels.live() === 1);
    await panels.focus('Helper'); await panels.press('l');
    // The mailbox is a second inline level: the member stays open, the messages stay closed until asked.
    await panels.focus('信箱');
    assert.match(panels.frame().join('\n'), /信箱/, 'the member shows one mailbox row');
    assert.doesNotMatch(panels.frame().join('\n'), /#11 成员|PAGE-BODY/, 'messages are not expanded by default');
    await panels.press('l');
    await panels.focus('页码');
    assert.match(focused(panels), /第 1\/2 页/, 'the page number is visible inside the mailbox');
    // Reading order is newest first: #11 comes first and #10 follows it, while #1 waits on the next page.
    await panels.focus('#11 成员');
    assert.match(focused(panels), /#11 成员/);
    await panels.press('j');
    assert.match(focused(panels), /投递并处理 #11/, 'the delivery row belongs to the message it acts on');
    await panels.press('j');
    assert.match(focused(panels), /#10 成员/, 'equal timestamps put the higher id first');
    await panels.press('j'); await panels.press('j');
    assert.match(focused(panels), /#2 成员/, 'the next row follows time, not reverse arrival/id order');
    await panels.focus('#11 成员'); await panels.press('\r');
    await panels.wait(() => panels.frame().join('\n').includes('消息正文'));
    assert.match(panels.frame().join('\n'), /PAGE-BODY-11/, 'Enter opens the real full-body reader, not just the row hint');
    assert.equal(await readFile(inboxPath, 'utf8'), before, 'preview changes no read state or requests');
    assert.equal(h.sent.length, 0, 'the browser receives no injected message');
    const beforeClose = panels.forces.length;
    await panels.press('\x1b');
    await panels.wait(() => panels.forces.length > beforeClose && !panels.frame().join('\n').includes('消息正文'));
    // Esc peels one layer: the mailbox closes while the member and its other rows stay.
    await panels.press('\x1b');
    await panels.wait(() => !panels.frame().join('\n').includes('#11 成员'));
    assert.match(panels.frame().join('\n'), /信箱/, 'closing the mailbox keeps the member open');
    await panels.focus('信箱'); await panels.press('l');
    await panels.focus('下一页');
    const beforePage = panels.forces.length;
    await panels.press('\r');
    await panels.wait(() => panels.forces.length > beforePage && panel.memory().get('team:inbox:s2')?.index === 10);
    assert.equal(panel.memory().get('team:inbox:s2')?.index, 10, 'next page committed the second window');
    await panels.focus('页码');
    assert.match(focused(panels), /第 2\/2 页/, 'the page number follows the window');
    await panels.focus('#1 成员');
    assert.match(panels.frame().join('\n'), /#1 成员/, 'the oldest retained message is reachable on the second page');
    await panels.focus('上一页');
    const beforeBack = panels.forces.length;
    await panels.press('\r');
    await panels.wait(() => panels.forces.length > beforeBack && panel.memory().get('team:inbox:s2')?.index === 0);
    await panels.focus('#11 成员');
    await panels.focus('投递并处理 #11');
    const beforeRequest = panels.forces.length;
    await panels.press('\r');
    const { readInbox } = await import('../src/team/io/inbox.ts');
    for (let attempt = 0; attempt < 200 && !(await readInbox(alpha.id, 's2')).some(message => message.request === 'deliver'); attempt++) await delay(2);
    const messages = await readInbox(alpha.id, 's2');
    assert.deepEqual(messages.find(message => message.request === 'deliver')!.deliverIds, [11]);
    assert.equal(messages.find(message => message.id === 11)!.sourceKind, 'agent', 'clicking delivery does not upgrade provenance');
    assert.equal(messages.find(message => message.id === 11)!.readAt, undefined, 'a request is not a read');
    assert.deepEqual(await readInbox(alpha.id, 's1'), [], 'the request targets the peer, not the browser');
    await panels.wait(() => panels.forces.length > beforeRequest && h.notices.some(notice => /已请求 Helper/.test(notice.message)));
    await panels.focus('投递最早未读'); await panels.press('\r');
    for (let attempt = 0; attempt < 200 && !(await readInbox(alpha.id, 's2')).some(message => message.deliverIds?.length === 10); attempt++) await delay(2);
    const fifoRequest = (await readInbox(alpha.id, 's2')).find(message => message.deliverIds?.length === 10);
    assert.deepEqual(fifoRequest?.deliverIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'delivery still takes stored FIFO, not the newest-first reading order');
  } finally {
    h.ctx.hasUI = false;
    await closeMountedPanel(h.ctx);
    await opening;
  }
});

test('ticket57 a stop keeps every file outside the team runtime root and says so', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(alpha.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  // A member record whose runtime pair points outside the team runtime root: a sentinel the launcher
  // must never touch. The names look like real runtime files so a basename rule would delete them.
  const outside = await mkdtemp(joinPath(tmpdir(), 'team-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinels = ['launch-under-test.fifo', 'launch-under-test.log', 'launch-under-test.pid'].map(name => joinPath(outside, name));
  for (const path of sentinels) await writeFile(path, 'do not delete\n', { mode: 0o600 });
  const before = await Promise.all(sentinels.map(path => readFile(path, 'utf8')));
  await setMemberRuntime(alpha.id, 's2', { fifo: sentinels[0]!, log: sentinels[1]!, pidFile: sentinels[2]!, pid: 22 });
  const h = await panelHost(t, workspace);
  // The member's process is gone, so the stop takes the record-offline path and reaches the cleanup.
  const registration = registerTeam(h.pi, { msg: chinese, panel: menuPanel(), pid: () => 10, alive: () => false });
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  await registration.stop(h.ctx, 'Worker');
  assert.deepEqual(await Promise.all(sentinels.map(path => readFile(path, 'utf8'))), before, 'every out-of-team file keeps its bytes');
  assert.match(h.notices.map(notice => notice.message).join('\n'), /3 个运行文件不在本团队运行目录内：已保留未删除/, `the human is told, with the count\n${JSON.stringify(h.notices)}`);
  // Eviction is not a mail shredder either: the record goes, the mailbox keeps its bytes.
  const { readInbox } = await import('../src/team/io/inbox.ts');
  await sendToMember(alpha.id, { from: 'Lead', fromId: 's1', to: 'Worker', body: 'keep me', now: 1_500 });
  const inboxPath = joinPath(teamsRoot(), alpha.id, 'inboxes', 's2.json');
  const inboxBytes = await readFile(inboxPath, 'utf8');
  assert.ok(inboxBytes.includes('keep me'));
  await registration.evict(h.ctx, 'Worker');
  assert.equal((await readMembers(alpha.id)).some(member => member.sessionId === 's2'), false, 'the record is gone');
  assert.equal(await readFile(inboxPath, 'utf8'), inboxBytes, 'and its mail is untouched');
  assert.deepEqual((await readInbox(alpha.id, 's2')).map(message => message.body), ['keep me']);
  assert.deepEqual(await Promise.all(sentinels.map(path => readFile(path, 'utf8'))), before, 'the evict kept the out-of-team files too');
});
