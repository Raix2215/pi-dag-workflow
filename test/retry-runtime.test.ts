import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRetry } from '../src/retry/register.ts';
import { emptyRetryState, intervalText, parseRetrySettings, RETRY_MESSAGE, RETRY_TYPE, restoreRetryState, retryDelay, validateRetryState } from '../src/retry/state.ts';

function host() {
  const events = new Map<string, Function[]>(); let command: any;
  const entries: any[] = [], wakes: any[] = [], notices: string[] = [];
  const timers = new Map<number, { due: number; fn: () => void }>();
  const deferred: (() => void)[] = []; let deferCommands = false, silentSend = false;
  let time = 0, serial = 0, idle = true, pending = false, mode: 'normal' | 'plan' = 'normal', protectedState = false, scope = 'normal', allowed = true, sendsFail = false, writesFail = false;
  let prepared = 0, refunded = 0;
  const ctx: any = { isIdle: () => idle, hasPendingMessages: () => pending, hasUI: true, sessionManager: { getBranch: () => entries, getLeafId: () => String(entries.length) }, ui: { notify: (text: string) => notices.push(text), select: async () => undefined, input: async () => undefined, confirm: async () => false } };
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerCommand(_name: string, cmd: any) { command = cmd; }, sendUserMessage(text: string) { const run = () => { void command.handler(text.slice('/retry '.length), ctx); }; if (deferCommands) deferred.push(run); else run(); }, appendEntry(customType: string, data: unknown) { if (writesFail) throw new Error('write failed'); entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any, options: any) { if (sendsFail) throw new Error('send failed'); if (!silentSend) wakes.push({ message, options }); } };
  const controller = registerRetry(pi, { branch: () => entries as never, mode: () => mode, scope: () => scope, protected: () => protectedState, prepare: () => { prepared++; return allowed; }, undoPrepare: () => { refunded++; }, now: () => time, setTimer(fn, ms) { const id = ++serial; timers.set(id, { due: time + ms, fn }); return id as never; }, clearTimer(id) { timers.delete(id as never); } });
  const fire = async (name: string, event: any = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const failure = async (text = '500 provider failed', aborted: boolean | null = false, stopReason = 'error') => { entries.push({ type: 'message', id: `failure-${++serial}`, message: { role: 'assistant', stopReason, errorMessage: text } }); await fire('agent_settled', aborted === null ? {} : { aborted }); };
  const tick = (ms: number) => { const end = time + ms; for (;;) { const first = [...timers].sort((a, b) => a[1].due - b[1].due)[0]; if (!first || first[1].due > end) break; time = first[1].due; timers.delete(first[0]); first[1].fn(); } time = end; };
  const success = async () => { entries.push({ type: 'message', id: `success-${++serial}`, message: { role: 'assistant', stopReason: 'stop' } }); await fire('turn_end', { outcome: 'completed' }); await fire('agent_settled', { aborted: false }); };
  return { ctx, command, controller, entries, wakes, notices, timers, failure, tick, fire, success, cmd: (args: string) => command.handler(args, ctx), start: () => fire('turn_start'), prepared: () => prepared, refunded: () => refunded, setIdle(value: boolean) { idle = value; }, setPending(value: boolean) { pending = value; }, setMode(value: 'normal' | 'plan') { mode = value; scope = value; }, setScope(value: string) { scope = value; }, setProtected(value: boolean) { protectedState = value; }, setAllowed(value: boolean) { allowed = value; }, failSend() { sendsFail = true; }, failWrite() { writesFail = true; }, deferCommands() { deferCommands = true; }, drainCommands() { deferCommands = false; for (const run of deferred.splice(0)) run(); }, silentSend() { silentSend = true; }, setClock(value: number) { time = value; }, fireEarly() { const first = [...timers][0]!; timers.delete(first[0]); first[1].fn(); } };
}

test('retry intervals/count parse without hidden limits or extra commands', () => {
  const settings = parseRetrySettings(['5m,30s,10m', 'count', '5']);
  assert.deepEqual(settings, { intervals: [300000, 30000, 600000], count: 5 });
  assert.equal(intervalText(settings), '5m,30s,10m');
  assert.deepEqual(parseRetrySettings(['3m']), { intervals: [180000] });
  for (const parts of [[], ['0s'], ['-1m'], ['1ms'], ['3m', 'count'], ['3m', 'count', '0'], ['3m', 'other', '2'], ['3m', 'count', '2', 'extra']]) assert.throws(() => parseRetrySettings(parts));
  for (const value of [0, 1, 2, 3, 4]) assert.equal(retryDelay({ ...emptyRetryState(), settings, attempts: value }), settings.intervals[value % 3]);
});

test('restoration preserves records and settings but never enables recovery', () => {
  const saved = { ...emptyRetryState(), enabled: true, settings: { intervals: [1000], count: 3 }, attempts: 2, skipped: 4 };
  const branch = [{ type: 'custom', customType: RETRY_TYPE, data: saved }];
  const restored = restoreRetryState(branch);
  assert.equal(restored.enabled, false); assert.equal(restored.attempts, 2); assert.equal(saved.enabled, true);
  assert.throws(() => restoreRetryState([{ type: 'custom', customType: RETRY_TYPE, data: { version: 99 } }]));
  for (const bad of [{ ...saved, attempts: -1 }, { ...saved, settings: { intervals: [Infinity] } }, { ...saved, cancelledFailure: '' }, { ...saved, enabled: false, settings: false }, { ...saved, settings: { intervals: [1500] } }]) assert.throws(() => validateRetryState(bad as never));
});

test('default off does not retry errors and status is read-only', async () => {
  const h = host(); await h.failure(); h.tick(100000);
  assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().enabled, false);
  const mark = h.entries.length; await h.cmd('status');
  assert.equal(h.entries.length, mark); assert.equal(h.wakes.length, 0);
  assert.equal(JSON.parse(h.notices.at(-1)!).enabled, false);
  for (const cmd of ['now', 'after 1s', 'every 1s', 'on', 'cancel', 'when-error 1s count 0', 'off extra', 'status extra']) await h.cmd(cmd);
  assert.equal(h.wakes.length, 0); assert.equal(h.entries.length, mark);
});

for (const mode of ['normal', 'plan'] as const) test(`enabled recovery waits for a settled failure in ${mode}, never exits its mode`, async () => {
  const h = host(); h.setMode(mode); await h.cmd('when-error 1s count 2');
  h.tick(10000); assert.equal(h.wakes.length, 0, 'no error means no timer or polling model');
  await h.failure(); h.tick(999); assert.equal(h.wakes.length, 0);
  h.tick(1); assert.equal(h.wakes.length, 1); assert.equal(h.controller.snapshot().attempts, 0, 'send is not a real turn');
  await h.start(); assert.equal(h.controller.snapshot().attempts, 1);
  assert.equal(h.controller.snapshot().mode, mode); assert.equal(h.wakes[0].message.customType, RETRY_MESSAGE);
  assert.match(h.wakes[0].message.content, /not new user authorization/);
});

test('finite retries cycle intervals and subsequent failures do not refill the count', async () => {
  const h = host(); await h.cmd('when-error 1s,2s,3s count 5'); await h.failure();
  for (const [index, delay] of [1000, 2000, 3000, 1000, 2000].entries()) {
    h.tick(delay - 1); assert.equal(h.wakes.length, index);
    h.tick(1); await h.start(); assert.equal(h.controller.snapshot().attempts, index + 1);
    await h.failure();
  }
  assert.equal(h.controller.snapshot().phase, 'exhausted');
  h.tick(100000); await h.fire('agent_settled', { aborted: false }); h.tick(100000);
  assert.equal(h.wakes.length, 5); assert.equal(h.controller.snapshot().attempts, 5);
});

test('omitting count repeats the sequence beyond its length; success resets for a later error', async () => {
  const h = host(); await h.cmd('when-error 1s,2s'); await h.failure();
  for (let i = 0; i < 7; i++) { h.tick(i % 2 ? 2000 : 1000); await h.start(); await h.failure(); }
  assert.equal(h.wakes.length, 7); assert.equal(h.controller.snapshot().count, null);
  await h.success(); h.tick(50000);
  assert.equal(h.wakes.length, 7); assert.equal(h.controller.snapshot().attempts, 0); assert.equal(h.controller.snapshot().enabled, true);
  await h.failure(); h.tick(1000); assert.equal(h.wakes.length, 8, 'a new error starts at the first interval');
});

for (const kind of ['busy', 'pending', 'menu'] as const) test(`busy deadline skips without count/sequence advancement (${kind})`, async () => {
  const h = host(); await h.cmd('when-error 1s,5s count 2'); await h.failure();
  if (kind === 'busy') h.setIdle(false);
  if (kind === 'pending') h.setPending(true);
  if (kind === 'menu') await h.fire('ui_prompt_start', { title: 'user input' });
  h.tick(1000); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().attempts, 0); assert.equal(h.controller.snapshot().skipped, 1);
  h.setIdle(true); h.setPending(false); await h.fire('ui_prompt_end', { title: 'user input' });
  h.tick(999); assert.equal(h.wakes.length, 0, 'becoming idle is not a queued wake');
  h.tick(1); assert.equal(h.wakes.length, 1); await h.start();
  await h.failure(); h.tick(4999); assert.equal(h.wakes.length, 1); h.tick(1); assert.equal(h.wakes.length, 2);
});

test('enabling starts an existing error, but never overlaps a still-running native request', async () => {
  const h = host(); await h.failure(); h.setIdle(false); await h.cmd('when-error 1s'); h.tick(10000);
  assert.equal(h.wakes.length, 0);
  h.setIdle(true); await h.fire('agent_settled', { aborted: false }); h.tick(1000); assert.equal(h.wakes.length, 1);
});

test('off cancels the timer, retains settings and does not restore work', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure(); await h.cmd('off'); h.tick(10000);
  assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.controller.snapshot().intervals, '1s');
});

for (const event of ['input', 'session_before_tree', 'session_before_switch', 'session_before_fork', 'session_shutdown', 'session_before_compact'] as const) test(`pending timer cannot execute after ${event}`, async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure();
  await h.fire(event, { source: 'rpc', text: 'new work' }); h.tick(10000);
  assert.equal(h.wakes.length, 0);
});

test('a scope change invalidates old recovery before any request or preparation', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure(); h.setScope('different goal'); h.tick(1000);
  assert.equal(h.wakes.length, 0); assert.equal(h.prepared(), 0);
});

test('user cancellation is remembered across reload and explicit configuration cannot revive it', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure(); await h.fire('agent_settled', { aborted: true });
  h.tick(1000); assert.equal(h.wakes.length, 0);
  await h.fire('session_tree'); assert.equal(h.controller.snapshot().enabled, false);
  await h.cmd('when-error 1s'); h.tick(1000); assert.equal(h.wakes.length, 0);
  await h.failure('fresh genuine error'); h.tick(1000); assert.equal(h.wakes.length, 1);
});

test('reopening the branch cannot retry a failure whose saved work was completed or replaced', async () => {
  const h = host(); h.setScope('goal-original'); await h.cmd('when-error 1s'); await h.failure();
  h.setScope('normal-after-goal'); await h.fire('session_tree');
  await h.cmd('when-error 1s'); h.tick(10000);
  assert.equal(h.wakes.length, 0); assert.equal(h.controller.pending(), false);
});

test('provider abort recovers only with explicit no-cancel evidence', async () => {
  for (const modern of [false, true]) {
    const h = host(); await h.cmd('when-error 1s'); await h.failure('provider stream disconnected', modern ? false : null, 'aborted'); h.tick(1000);
    assert.equal(h.wakes.length, modern ? 1 : 0);
  }
});

test('quota, auth and unknown errors all use the user rule', async () => {
  for (const error of ['429 insufficient_quota', '401 invalid_api_key', '402 payment required', 'unexpected failure']) {
    const h = host(); await h.cmd('when-error 1s count 1'); await h.failure(error); h.tick(1000); assert.equal(h.wakes.length, 1, error);
  }
});

test('blocked work, failed sends and failed persistence issue no model request', async () => {
  const blocked = host(); await blocked.cmd('when-error 1s'); await blocked.failure(); blocked.setAllowed(false); blocked.tick(1000); assert.equal(blocked.wakes.length, 0);
  const failed = host(); await failed.cmd('when-error 1s'); await failed.failure(); failed.failSend(); failed.tick(1000); assert.equal(failed.wakes.length, 0); assert.equal(failed.controller.snapshot().attempts, 0); assert.equal(failed.refunded(), 1);
  const broken = host(); await broken.cmd('when-error 1s'); await broken.failure(); broken.setIdle(false); broken.failWrite(); assert.doesNotThrow(() => broken.tick(1000)); assert.equal(broken.wakes.length, 0); assert.equal(broken.controller.snapshot().enabled, false); assert.ok(broken.controller.snapshot().error);
});

test('bad saved records remain protected and never get overwritten by status/off/configure', async () => {
  const h = host(); h.entries.push({ type: 'custom', customType: RETRY_TYPE, data: { version: 99 } });
  h.controller.restore(h.ctx); const mark = h.entries.length;
  await h.cmd('status'); await h.cmd('off'); await h.cmd('when-error 1s'); h.tick(10000);
  assert.equal(h.entries.length, mark); assert.equal(h.wakes.length, 0); assert.ok(h.controller.snapshot().error);
});

test('a command deferred by slow settled handlers is a busy skip, not a queued model request', async () => {
  const h = host(); await h.cmd('when-error 1s count 2'); await h.failure(); h.deferCommands(); h.tick(1000);
  assert.equal(h.wakes.length, 0); assert.equal(h.controller.pending(), true);
  h.drainCommands(); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().skipped, 1); assert.equal(h.controller.snapshot().attempts, 0);
  h.tick(999); assert.equal(h.wakes.length, 0); h.tick(1); assert.equal(h.wakes.length, 1);
});

test('off invalidates a deferred command before it can issue a model request', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure(); h.deferCommands(); h.tick(1000);
  await h.cmd('off'); h.drainCommands(); h.tick(10000);
  assert.equal(h.wakes.length, 0); assert.equal(h.controller.pending(), false);
});

test('an async start failure reported at settlement clears pending without spending an attempt', async () => {
  const h = host(); await h.cmd('when-error 1s count 2'); await h.failure(); h.silentSend(); h.tick(1000);
  assert.equal(h.controller.snapshot().phase, 'starting'); await h.fire('agent_settled', { aborted: false });
  assert.equal(h.controller.snapshot().phase, 'failed'); assert.equal(h.controller.snapshot().attempts, 0); assert.equal(h.controller.pending(), false); assert.equal(h.refunded(), 1);
  h.tick(10000); assert.equal(h.wakes.length, 0);
});

test('a start failure with no settlement is detected locally without a model polling loop', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure(); h.silentSend(); h.tick(2000);
  assert.equal(h.controller.snapshot().phase, 'failed'); assert.equal(h.controller.pending(), false); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().attempts, 0);
});

test('menu changes retain a known provider abort and its timer', async () => {
  const h = host(); await h.cmd('when-error 1s,2s count 3'); await h.failure('provider disconnected', false, 'aborted'); h.tick(1000); await h.start(); await h.failure('provider disconnected again', false, 'aborted');
  h.ctx.ui.select = async (_title: string, choices: string[]) => choices[1]; h.ctx.ui.input = async () => '2s'; h.ctx.ui.confirm = async () => true;
  await h.cmd(''); assert.equal(h.controller.snapshot().attempts, 1); assert.equal(h.controller.snapshot().phase, 'waiting');
  h.tick(2000); assert.equal(h.wakes.length, 2);
});

test('a command prefix is not a retry command and cannot keep an old timer alive', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure();
  await h.fire('input', { source: 'rpc', text: '/retry-other new work' }); h.tick(1000);
  assert.equal(h.wakes.length, 0);
});

test('editing a running policy through the menu preserves the actual attempt count', async () => {
  const h = host(); await h.cmd('when-error 1s count 3'); await h.failure(); h.tick(1000); await h.start(); await h.failure();
  h.ctx.ui.select = async (_title: string, choices: string[]) => choices[1];
  h.ctx.ui.input = async () => '2s'; h.ctx.ui.confirm = async () => true;
  await h.cmd(''); assert.equal(h.controller.snapshot().attempts, 1); assert.equal(h.controller.snapshot().intervals, '2s');
  h.tick(1999); assert.equal(h.wakes.length, 1); h.tick(1); await h.start(); assert.equal(h.controller.snapshot().attempts, 2);
});

test('repeated settled events do not reset or extend a pending interval', async () => {
  const h = host(); await h.cmd('when-error 1s'); await h.failure(); h.tick(400);
  await h.fire('agent_settled', { aborted: false }); h.tick(600);
  assert.equal(h.wakes.length, 1);
});

test('an early timer after a backward clock change keeps its original due time', async () => {
  const h = host(); await h.cmd('when-error 1s count 1'); await h.failure();
  h.setClock(-1000); h.fireEarly(); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().nextAt, 1000);
  h.tick(1999); assert.equal(h.wakes.length, 0); h.tick(1); assert.equal(h.wakes.length, 1);
});

test('long intervals use multiple bounded timers rather than an immediate Node overflow', async () => {
  const h = host(); await h.cmd('when-error 1000h count 1'); await h.failure();
  h.tick(2147483647); assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().attempts, 0);
  h.tick(3600000000 - 2147483647 - 1); assert.equal(h.wakes.length, 0); h.tick(1); assert.equal(h.wakes.length, 1);
});

test('menus are cancellable, user-only and settings are committed only after confirmation', async () => {
  const h = host(); const mark = h.entries.length;
  await h.cmd(''); assert.equal(h.entries.length, mark);
  h.ctx.ui.select = async (_title: string, choices: string[]) => choices[0];
  h.ctx.ui.input = async () => '1s,2s'; h.ctx.ui.confirm = async () => false;
  await h.cmd(''); assert.equal(h.entries.length, mark); assert.equal(h.controller.snapshot().enabled, false);
  h.ctx.ui.confirm = async () => true;
  await h.cmd(''); assert.equal(h.controller.snapshot().enabled, true); assert.equal(h.controller.snapshot().intervals, '1s,2s'); assert.equal(h.wakes.length, 0);
  assert.equal(h.command.getArgumentCompletions('now'), null); assert.equal(h.command.getArgumentCompletions('when-error '), null);
  assert.deepEqual(h.command.getArgumentCompletions('').map((item: any) => item.value), ['when-error', 'off', 'status']);
});
