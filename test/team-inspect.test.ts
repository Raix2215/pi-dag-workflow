/**
 * Ticket 51 — the live snapshot, the real finish boundary and the bounded activity attachment.
 *
 * Every wait assertion drives the registered tool through `registerTeam(...)` and a `hooks.wait` that edits
 * the *real* member file, so the "old closed-over member" bug (which returned `timedOut` on a real turn end)
 * could only pass by reading the file again. Activity is read from a real session file written by the real
 * `SessionManager`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chinese } from '../src/shared/i18n.ts';
import { configPaths } from '../src/shared/config.ts';
import { createTeam, joinTeam, readMember, teamsRoot } from '../src/team/io/registry.ts';
import { sessionFileFor } from '../src/team/io/session-tail.ts';
import { activityFromTail, activityLimit, readActivity } from '../src/team/io/session-activity.ts';
import { registerTeam } from '../src/team/commands/register.ts';
import { sendToMember } from '../src/team/io/inbox.ts';

const workspace = '/tmp/team-workspace';

async function agentDir(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'team-inspect-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  assert.equal(configPaths().directory.startsWith(root), true, `config lives in this run: ${configPaths().directory}`);
  assert.equal(teamsRoot().startsWith(root), true, `team data lives in this run: ${teamsRoot()}`);
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function host(root: string, sessionId = 's1') {
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>(), branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerFlag() {}, getFlag() { return undefined; },
    appendEntry(type: string, data: unknown) { branch.push({ customType: type, data }); },
    sendMessage() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {},
  };
  const ctx: any = { cwd: root, isIdle: () => false, sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch }, ui: { notify() {}, setWidget() {} } };
  return { pi, ctx, tools, handlers };
}

/** Write one member record field directly, the way another process would. */
async function patchMember(teamId: string, sessionId: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(teamsRoot(), teamId, 'members', `${sessionId}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify({ ...record, ...patch }, null, 2)}\n`);
}

test('team overview pages the joined roster within its byte budget without changing self-query semantics', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  for (let index = 0; index < 28; index++) await joinTeam(team.id, { sessionId: `s${index}`, sessionName: `成员-${String(index).padStart(2, '0')}-${'名'.repeat(30)}`, role: '角'.repeat(120), pid: index + 10, now: 1_000 });
  await patchMember(team.id, 's14', { lastActivityAt: 'malformed-timestamp'.repeat(400) } as never);
  const h = host(workspace, 's0');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'self' });
  registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: () => true });
  const inspect = h.tools.get('team_inspect'), seen: string[] = [];
  const contextual = await h.handlers.get('context')![0]!({ messages: [] }, h.ctx);
  const membershipText = contextual.messages.at(-1).content;
  const membership = JSON.parse(membershipText.slice(membershipText.indexOf('{')));
  assert.ok(Buffer.byteLength(membershipText) <= 2048, 'large automatic rosters stay inside the whole-context budget');
  assert.ok(membership.roster.length <= 12);
  assert.equal(membership.total, 28); assert.equal(membership.omitted, 28 - membership.roster.length);
  let offset: number | null = 0;
  for (let pages = 0; offset !== null && pages < 28; pages++) {
    const result: any = await inspect.execute('probe', { scope: 'team', offset }, undefined, undefined, h.ctx);
    assert.notEqual(result.isError, true);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 4096);
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.team, 'Alpha'); assert.equal(page.total, 28);
    assert.ok(page.members.length > 0 && page.members.length <= 20);
    seen.push(...page.members.map((member: any) => member.sessionId));
    assert.ok(page.nextOffset === null || page.nextOffset > offset, 'a bounded page cannot stall pagination');
    offset = page.nextOffset;
  }
  assert.equal(new Set(seen).size, 28, 'pagination exposes every member once');
  assert.equal(seen.length, 28);
  const self = JSON.parse((await inspect.execute('probe', {}, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(self.member.sessionId, 's0', 'omitting scope still inspects this session, not the entire team');
  assert.equal((await inspect.execute('probe', { scope: 'team', until: 'finish' }, undefined, undefined, h.ctx)).isError, true);
  // Four-byte Unicode makes the whole response exceed 2 KiB even when individual fields meet their limits.
  const directory = join(configPaths().directory, '..', 'sessions', 'budget');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 's0.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 's0', cwd: workspace }) + '\n' + JSON.stringify({ type: 'message', id: 'reply', message: { role: 'assistant', content: '𐐀'.repeat(240) } }) + '\n');
  await patchMember(team.id, 's0', { name: '𐐀'.repeat(80), role: '𐐀'.repeat(60), sessionFile: file });
  const bounded = await inspect.execute('probe', { name: 'session:s0', activity: { limit: 10 } }, undefined, undefined, h.ctx);
  assert.ok(Buffer.byteLength(bounded.content[0].text) <= 2048, 'member fields, reply and requested activity share one response budget');
  const detail = JSON.parse(bounded.content[0].text);
  assert.equal(detail.member.sessionId, 's0');
  assert.ok(detail.activityTruncated === true || detail.lastReplyTruncated === true, 'budget omissions are explicit');
});

test('ticket51 finish returns on a real turn end instead of waiting out the timeout', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  let waits = 0;
  registerTeam(h.pi, {
    msg: chinese, pid: () => 10, alive: () => true,
    // The member stays busy the whole time, so only a real turn end can end this wait.
    wait: async () => { await new Promise(resolve => setImmediate(resolve));
      waits += 1;
      if (waits === 1) await patchMember(team.id, 's2', { lastActivityAt: 1_500, busy: true });
      if (waits === 2) await patchMember(team.id, 's2', { lastTurnAt: 2_000, lastActivityAt: 2_000, busy: true });
    },
  });
  const inspect = h.tools.get('team_inspect');
  const started = Date.now();
  const result = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 5 }, undefined, undefined, h.ctx)).content[0].text);
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, undefined, 'a real turn end is not a timeout');
  assert.equal(result.lastActiveAt, 2_000, 'the snapshot carries the re-read turn end');
  assert.equal(result.busy, true, 'and the member is still busy: only the turn end released the wait');
  assert.ok(elapsed < 3_000, `it returned on the boundary, not on the clock: ${elapsed}ms`);
});

test('ticket51 an ordinary tool event advances update but never finish', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  let waits = 0;
  registerTeam(h.pi, {
    msg: chinese, pid: () => 10, alive: () => true,
    wait: async () => { await new Promise(resolve => setImmediate(resolve));
      waits += 1;
      // The first event is a tool call: activity, not the end of a turn. The turn ends two waits later.
      if (waits === 1) await patchMember(team.id, 's2', { lastActivityAt: 1_500, busy: true });
      if (waits === 2) await patchMember(team.id, 's2', { lastTurnAt: 3_000, lastActivityAt: 3_000, busy: true });
      // The second call (update) needs its own real event to return on.
      if (waits === 3) await patchMember(team.id, 's2', { lastActivityAt: 4_000, busy: true });
    },
  });
  const inspect = h.tools.get('team_inspect');
  const finished = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 5 }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(finished.timedOut, undefined, `the wait ended on the real turn end (waits=${waits})`);
  assert.equal(finished.lastActiveAt, 3_000, 'the tool event at 1500 did not release it');
  // update answers on the event itself.
  const updated = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'update', timeout: 5 }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(updated.timedOut, undefined, 'update answers on the next real event');
  assert.equal(updated.lastActiveAt, 4_000);
});

test('ticket51 the wait follows the registry, not a closed-over member', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  let waits = 0;
  registerTeam(h.pi, {
    msg: chinese, pid: () => 10, alive: () => true,
    wait: async () => { await new Promise(resolve => setImmediate(resolve));
      waits += 1;
      if (waits === 1) {
        // Rename and change the holder mid-wait: the next snapshot must report the record, not the name.
        await patchMember(team.id, 's2', { name: 'Renamed', holder: { pid: 4242, since: 5 } });
      }
      if (waits === 2) await patchMember(team.id, 's2', { lastTurnAt: 9_000, busy: false });
    },
  });
  const inspect = h.tools.get('team_inspect');
  const result = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 5 }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(result.member.sessionId, 's2', 'the wait stays on the resolved session id');
  assert.equal(result.member.name, 'Renamed', 'and reports the name the record now has');
  assert.equal(result.member.pid, 4242, 'and the holder the record now has');
  assert.equal(result.timedOut, undefined);
});

test('ticket51 a removed member ends the wait, an unknown pid is not an exit, timeout 0 is honest', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  let waits = 0;
  registerTeam(h.pi, {
    msg: chinese, pid: () => 10,
    // No probe on this host at all: an unasked question must never read as an exit.
    wait: async () => { await new Promise(resolve => setImmediate(resolve));
      waits += 1;
      if (waits === 1) await rm(join(teamsRoot(), team.id, 'members', 's2.json'));
    },
  });
  const inspect = h.tools.get('team_inspect');
  const gone = await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 5 }, undefined, undefined, h.ctx);
  assert.equal(gone.isError, true, 'a removed record ends the wait with a clear failure');
  assert.match(gone.content[0].text, /没有该成员记录/, 'and names what happened');
  // Unknown state without a probe: still not offline.
  await joinTeam(team.id, { sessionId: 's3', sessionName: 'Blind', pid: 33, now: 1_000 });
  const blind = JSON.parse((await inspect.execute('probe', { name: 'Blind', until: 'finish', timeout: 0 }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(blind.member.reason, 'unknown', 'an unprobeable pid is unknown');
  assert.notEqual(blind.member.state, 'offline', 'and never a claimed exit');
  assert.equal(blind.timedOut, true, 'timeout 0 answers immediately instead of waiting');
});

test('ticket51 an aborted call stops waiting instead of blocking to the cap', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: () => true, wait: async () => { await new Promise(resolve => setImmediate(resolve));} });
  const inspect = h.tools.get('team_inspect');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  const result = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 300 }, controller.signal, undefined, h.ctx)).content[0].text);
  assert.equal(result.cancelled, true, 'the caller cancels the wait');
  assert.ok(Date.now() - started < 5_000, 'and it returns promptly, not at the 300 s cap');
});

test('ticket51 native records: tool names, ISO times, no successful output, bounded error text', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  // A real session file, written through the real SessionManager in the native shape Pi uses.
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const directory = join(configPaths().directory, '..', 'sessions', 'team-inspect-project');
  await mkdir(directory, { recursive: true });
  const file = join(directory, '2026-01-01T00-00-00-000Z_s2.jsonl');
  const manager = SessionManager.open(file);
  const rootId = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'please run it' }] } as never);
  // The native tool call lives in assistant.content[]: a call with no text must still be summarised.
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'nativeTool', arguments: { secret: 'ARGUMENT-SECRET' } }] } as never);
  manager.appendMessage({ role: 'toolResult', toolCallId: 'call_1', toolName: 'nativeTool', isError: false, content: [{ type: 'text', text: 'SUCCESS-BODY-SHORT' }] } as never);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call_2', name: 'nativeTool', arguments: {} }] } as never);
  manager.appendMessage({ role: 'toolResult', toolCallId: 'call_2', toolName: 'nativeTool', isError: true, content: [{ type: 'text', text: 'FAILED-' + 'x'.repeat(400) }] } as never);
  manager.appendMessage({ role: 'assistant', content: Array.from({ length: 8 }, (_, index) => ({ type: 'toolCall', id: `multi-${index}`, name: `parallelTool${index}-${'wide'.repeat(12)}`, arguments: {} })) } as never);
  manager.branch(rootId);
  manager.appendContextEdit(rootId, null);
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  // Deliberately oppose file order and wall-clock order, so a timestamp sort cannot pass vacuously.
  for (let index = 1; index < rows.length; index++) rows[index].timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, rows.length - index)).toISOString();
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = createHash('sha256').update(await readFile(file)).digest('hex');
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: () => true });
  const inspect = h.tools.get('team_inspect');
  const plain = JSON.parse((await inspect.execute('probe', { name: 'Worker' }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(plain.activity, undefined, 'an unrequested snapshot reads no history');
  const withActivity = JSON.parse((await inspect.execute('probe', { name: 'Worker', activity: { limit: 10 } }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(withActivity.activitySource, 'tail', 'the answer names where the window came from');
  const events = withActivity.activity.map((entry: any) => entry.event);
  assert.equal(events.at(-1), 'context_edit', 'saved order spans branches; an edit never erases saved facts');
  assert.ok(events.includes('tool_call nativeTool'), `the native tool call keeps its name: ${JSON.stringify(events)}`);
  const call = withActivity.activity.find((entry: any) => entry.event === 'tool_call nativeTool');
  assert.equal(typeof call.at, 'string', 'a legal ISO timestamp is kept as a string');
  assert.equal(Number.isNaN(Date.parse(call.at)), false, 'and it really parses as a time');
  // A successful result reports its outcome only: its body is never the summary, however short.
  const ok = withActivity.activity.find((entry: any) => entry.event === 'tool_result nativeTool' && entry.status === 'ok');
  assert.ok(ok, 'the successful result is recorded');
  assert.equal(ok.text, undefined, 'a successful tool body is never returned');
  assert.equal(ok.truncated, undefined);
  const failed = withActivity.activity.find((entry: any) => entry.status === 'error');
  assert.ok(failed, 'the failed result reports its explicit error state');
  assert.ok([...failed.text ?? ''].length <= 160, 'an error summary stays within 160 characters');
  assert.equal(failed.truncated, true, 'and says it was truncated');
  const parallel = withActivity.activity.find((entry: any) => entry.event.includes('parallelTool'));
  assert.ok(parallel);
  assert.ok([...parallel.event].length <= 160, 'a native multi-tool batch cannot bypass the summary budget');
  assert.equal(parallel.truncated, true);
  // No full arguments or bodies anywhere in the payload.
  const payload = JSON.stringify(withActivity);
  assert.equal(payload.includes('ARGUMENT-SECRET'), false, 'tool arguments are never returned');
  assert.equal(payload.includes('SUCCESS-BODY-SHORT'), false, 'a successful body is never returned');
  assert.equal(payload.includes('x'.repeat(200)), false, 'and an error body is capped');
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), before, 'the session file is untouched');
  // An out-of-range limit is refused, not clamped into a different question.
  assert.throws(() => activityLimit(0), /1-10/);
  assert.throws(() => activityLimit(11), /1-10/);
  assert.equal(activityLimit(undefined), 3);
  assert.equal((await inspect.execute('probe', { name: 'Worker', activity: { limit: 11 } }, undefined, undefined, h.ctx)).isError, true, 'the tool refuses it too');
  assert.ok(Buffer.byteLength(payload) <= 2048, 'the whole member snapshot, not just each field, is bounded');
});

test('ticket51 a record without a holder reads unknown and is never called an exit', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  // A record damaged by another writer: no holder object, no state.
  const recordPath = join(teamsRoot(), team.id, 'members', 's2.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  delete record.holder;
  delete record.state;
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  registerTeam(h.pi, { msg: chinese, pid: () => 10 });
  const inspect = h.tools.get('team_inspect');
  // Even with a host that cannot probe, this is "unknown": no TypeError, no exit, no fabricated offline.
  const result = JSON.parse((await inspect.execute('probe', { name: 'Worker' }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(result.member.reason, 'unknown', 'a damaged holder reads unknown');
  assert.notEqual(result.member.state, 'offline', 'and is never reported as an exit');
  assert.equal(result.timedOut, undefined);
  // finish does not treat it as finished either.
  const waited = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 0 }, undefined, undefined, h.ctx)).content[0].text);
  assert.notEqual(waited.cancelled === true && waited.lastActiveAt === undefined, true, 'the wait still answers with a snapshot');
  assert.equal(waited.member.reason, 'unknown');
});

test('ticket51 a missing or damaged session is reported by name, never invented or scanned whole', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  // A host with no sessions directory at all cannot locate anything, and says so.
  assert.equal(readActivity('s2', 10).source, 'unlocatable', 'no sessions root is "unlocatable"');
  // With the root present but no file for this session, the answer is "unsaved", not empty saved history.
  await mkdir(join(configPaths().directory, '..', 'sessions', 'some-project'), { recursive: true });
  const unsaved = readActivity('s2', 10);
  assert.equal(unsaved.source, 'unsaved', 'an unsaved session is named as such');
  assert.deepEqual(unsaved.entries, []);
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  registerTeam(h.pi, { msg: chinese, pid: () => 10, alive: () => true });
  const tool = h.tools.get('team_inspect');
  const status = JSON.parse((await tool.execute('probe', { name: 'Worker', activity: {} }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(status.activitySource, 'unsaved', 'the tool shows the reason, not a pretend empty window');
  assert.deepEqual(status.activity, []);
  // A located file that cannot be read is "unreadable", not empty history.
  const broken = readActivity('s2', 10, { file: 'x', read: () => { throw new Error('EACCES'); } });
  assert.equal(broken.source, 'unreadable');
  assert.match(broken.reason ?? '', /EACCES/);
  // A tail that begins mid-line and ends without a newline is incomplete on both ends.
  const partial = activityFromTail('{"type":"mess\n{"type":"message","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"ok"}]}}\n{"type":"message","message":{"role":"assistant","content":"half', 10);
  assert.equal(partial.incomplete, 'both', 'both cut ends are reported');
  assert.deepEqual(partial.entries.map(entry => entry.event), ['message user'], 'only the whole line becomes a record');
  assert.equal(partial.entries[0]!.at, '2026-01-01T00:00:00.000Z', 'and its ISO time survives');
  // A null line and a bare string are skipped like any malformed line.
  const noisy = activityFromTail('null\n"just text"\n{"type":"message","timestamp":5,"message":{"role":"user","content":[{"type":"text","text":"ok"}]}}\n', 10);
  assert.deepEqual(noisy.entries.map(entry => entry.at), [5], 'a legacy numeric time is kept');
  assert.equal(noisy.incomplete, undefined);
  void sessionFileFor;
  void readMember;
});

test('ticket51 the wait does not re-read the session tail, and activity reads it at most once', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Worker', pid: 22, now: 1_000 });
  // A real saved session for s2, so a tail read would really hit the file system.
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const directory = join(configPaths().directory, '..', 'sessions', 'team-inspect-project');
  await mkdir(directory, { recursive: true });
  const file = join(directory, '2026-01-01T00-00-00-000Z_s2.jsonl');
  const manager = SessionManager.open(file);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] } as never);
  await sendToMember(team.id, { from: 'Lead', fromId: 's1', to: 'Worker', body: 'unchanged mailbox', now: 1_500 });
  const mailbox = join(teamsRoot(), team.id, 'inboxes', 's2.json');
  // Count physical reads, not calls to a hand-written predicate.
  const nativeFs = (await import('node:fs')).default as any;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = nativeFs.readSync;
  let reads = 0, mailboxReads = 0;
  const readFileOriginal = nativeFs.promises.readFile;
  nativeFs.readSync = (...args: any[]) => { reads += 1; return (original as any).apply(nativeFs, args); };
  nativeFs.promises.readFile = (...args: any[]) => { if (String(args[0]) === mailbox) mailboxReads += 1; return readFileOriginal.apply(nativeFs.promises, args); };
  syncBuiltinESMExports();
  t.after(() => { nativeFs.readSync = original; nativeFs.promises.readFile = readFileOriginal; syncBuiltinESMExports(); });
  const h = host(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  let waits = 0;
  let abortNext: AbortController | undefined;
  registerTeam(h.pi, {
    msg: chinese, pid: () => 10, alive: () => true,
    wait: async () => { waits += 1; if (abortNext) abortNext.abort(); else if (waits === 2) await patchMember(team.id, 's2', { lastTurnAt: 2_000, busy: true }); },
  });
  const inspect = h.tools.get('team_inspect');
  const result = JSON.parse((await inspect.execute('probe', { name: 'Worker', until: 'finish', timeout: 5, activity: { limit: 5 } }, undefined, undefined, h.ctx)).content[0].text);
  assert.equal(result.timedOut, undefined, 'the wait ended on the real boundary');
  assert.ok(waits >= 2, 'the wait really ran several rounds');
  assert.equal(reads, 1, `one bounded tail read for the whole response, not one per round (reads=${reads})`);
  assert.equal(mailboxReads, 1, 'an unchanged mailbox is parsed once across several snapshots');
  assert.equal(result.activitySource, 'tail', 'the window came from a real tail read');
  assert.ok(result.activity.some((entry: any) => /reply/.test(entry.text ?? '')), 'and the saved reply is in it');
  reads = 0;
  abortNext = new AbortController();
  const cancelled = await inspect.execute('cancel', { name: 'Worker', until: 'finish', timeout: 5, activity: {} }, abortNext.signal, undefined, h.ctx);
  assert.equal(cancelled.details.cancelled, true);
  assert.equal(reads, 0, 'cancellation returns its existing snapshot without scanning the session tail');
  assert.equal(cancelled.details.activity, undefined, 'a cancelled query does not pretend to attach newly-read activity');
});
