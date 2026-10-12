import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRetry } from '../src/retry/register.ts';
import { defaultRetryModels, emptyRetryState, modelRefText, parseModelRefs, RETRY_TYPE, restoreRetryState, validateRetryState } from '../src/retry/state.ts';

function host() {
  const events = new Map<string, Function[]>(), entries: any[] = [], requests: any[] = [], changes: string[] = [], notices: string[] = [], dialogs: any[] = [], answers: any[] = [];
  const catalog = new Map(['A', 'B', 'C'].map((id) => [`test/${id}`, { provider: 'test', id, input: ['text'], reasoning: true }])); let model: any = catalog.get('test/A'), command: any, time = 0, serial = 0, pending = false, idle = true, scope = 'normal', thinking = 'high';
  const timers = new Map<number, { at: number; fn: () => void }>(), missingAuth = new Set<string>(), rejected = new Set<string>(); let gate: ((target: string) => Promise<void>) | undefined;
  const ctx: any = { hasUI: true, get model() { return model; }, isIdle: () => idle, hasPendingMessages: () => pending, modelRegistry: { find: (provider: string, id: string) => catalog.get(`${provider}/${id}`), getAvailable: () => [...catalog.values()].filter((m) => !missingAuth.has(modelRefText(m))), hasConfiguredAuth: (m: any) => !missingAuth.has(modelRefText(m)) }, sessionManager: { getBranch: () => entries, getLeafId: () => String(entries.length) }, ui: { notify: (text: string) => notices.push(text), confirm: async (title: string, message: string) => { dialogs.push({ title, message }); const reply = answers.shift(); return typeof reply === 'function' ? reply() : reply ?? true; }, select: async (title: string, options: string[]) => { dialogs.push({ title, options }); const reply = answers.shift(); return typeof reply === 'function' ? reply() : reply; }, editor: async (title: string, prefill: string) => { dialogs.push({ title, prefill }); return answers.shift(); } } };
  const fire = async (name: string, event: any = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerCommand(_name: string, value: any) { command = value; }, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendUserMessage(text: string) { void command.handler(text.slice('/retry '.length), ctx); }, sendMessage(message: any) { requests.push({ model: modelRefText(model), at: time, message }); }, getThinkingLevel: () => thinking, setThinkingLevel(level: string) { thinking = model.reasoning ? level : 'off'; }, async setModel(target: any) { const key = modelRefText(target); if (gate) await gate(key); if (rejected.has(key)) return false; const previousModel = model; model = target; changes.push(key); thinking = model.reasoning ? 'medium' : 'off'; await fire('model_select', { model: target, previousModel, source: 'set' }); return true; } };
  const failed: boolean[] = []; const controller = registerRetry(pi, { branch: () => entries as never, scope: () => scope, mode: () => 'normal', protected: () => false, failed: (_ctx, waiting) => failed.push(waiting), now: () => time, setTimer(fn, delay) { const id = ++serial; timers.set(id, { at: time + delay, fn }); return id as never; }, clearTimer(id) { timers.delete(id as never); } });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = async (ms: number) => { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } await flush(); };
  const failure = async () => { entries.push({ type: 'message', id: `failed-${++serial}`, message: { role: 'assistant', stopReason: 'error', errorMessage: 'synthetic failure' } }); await fire('agent_settled', { aborted: false }); };
  return { controller, ctx, entries, requests, changes, notices, dialogs, catalog, missingAuth, rejected, failed, answers, timers, tick, failure, flush, fire, start: () => fire('turn_start'), cmd: (args: string) => command.handler(args, ctx), selected: () => modelRefText(model), setPending(value: boolean) { pending = value; }, setIdle(value: boolean) { idle = value; }, setScope(value: string) { scope = value; }, setGate(fn?: typeof gate) { gate = fn; }, async manual(id: string) { const previousModel = model; model = catalog.get(`test/${id}`); await fire('model_select', { model, previousModel, source: 'cycle' }); } };
}

test('fallback references/settings are bounded, branch-restored and do not enable retry', () => {
  assert.deepEqual(defaultRetryModels(), { enabled: false, candidates: [], after: 2 }); assert.deepEqual(parseModelRefs(['provider/family/model']), [{ provider: 'provider', id: 'family/model' }]);
  for (const refs of [[], ['A'], ['/A'], ['p/'], ['p/A', 'p/A'], ['p/A\nB'], Array.from({ length: 9 }, (_, i) => `p/${i}`)]) assert.throws(() => parseModelRefs(refs));
  const saved = { ...emptyRetryState(), models: { enabled: true, candidates: parseModelRefs(['test/B']), after: 2 } }; assert.deepEqual(restoreRetryState([{ type: 'custom', customType: RETRY_TYPE, data: saved }]), saved);
  for (const models of [{ enabled: true, candidates: [], after: 2 }, { enabled: false, candidates: [], after: 0 }, { enabled: 'yes', candidates: [], after: 2 }]) assert.throws(() => validateRetryState({ ...saved, models } as never));
});

test('two attempts per model share the global interval sequence; finite candidates stop even without count', async () => {
  const h = host(); await h.cmd('models test/B test/C'); assert.equal(h.controller.snapshot().enabled, false); assert.match(h.dialogs[0].message, /发送当前上下文/);
  await h.cmd('when-error 1s,2s'); await h.failure();
  for (let i = 0; i < 6; i++) { await h.tick(i % 2 ? 2000 : 1000); assert.equal(h.requests.length, i + 1); assert.equal(h.requests[i].model, ['test/A', 'test/A', 'test/B', 'test/B', 'test/C', 'test/C'][i]); await h.start(); await h.failure(); }
  assert.deepEqual(h.changes, ['test/B', 'test/C']); assert.equal(h.controller.snapshot().attempts, 6); assert.equal(h.controller.snapshot().phase, 'exhausted'); assert.equal(h.failed.at(-1), false); assert.equal(h.timers.size, 0);
  await h.tick(100000); assert.equal(h.requests.length, 6); assert.equal(h.selected(), 'test/C');
});

test('total count caps the whole chain; success retains the selected model and resets both streak budgets', async () => {
  const h = host(); await h.cmd('models test/B test/C'); await h.cmd('when-error 1s count 3'); await h.failure();
  for (let i = 0; i < 3; i++) { await h.tick(1000); await h.start(); if (i < 2) await h.failure(); }
  assert.equal(h.selected(), 'test/B'); assert.equal(h.controller.snapshot().attempts, 3);
  h.entries.push({ type: 'message', id: 'success', message: { role: 'assistant', stopReason: 'stop' } }); await h.fire('turn_end', { outcome: 'completed' }); await h.fire('agent_settled', { aborted: false });
  assert.equal(h.selected(), 'test/B'); assert.equal(h.controller.snapshot().attempts, 0); await h.failure(); await h.tick(1000); await h.start(); assert.equal(h.requests.at(-1).model, 'test/B'); await h.failure();
  await h.tick(1000); await h.start(); await h.failure(); await h.tick(1000); await h.start(); await h.failure(); assert.equal(h.selected(), 'test/C'); assert.equal(h.controller.snapshot().phase, 'exhausted'); assert.equal(h.controller.snapshot().attempts, 3);
});

test('busy deadlines do not switch models or consume actual attempts', async () => {
  const h = host(); await h.cmd('models test/B'); await h.cmd('models after 1'); await h.cmd('when-error 1s,2s count 3'); await h.failure(); await h.tick(1000); await h.start(); await h.failure();
  h.setPending(true); await h.tick(2000); assert.equal(h.changes.length, 0); assert.equal(h.controller.snapshot().attempts, 1); assert.equal(h.controller.snapshot().skipped, 1);
  h.setPending(false); await h.tick(1999); assert.equal(h.changes.length, 0); await h.tick(1); assert.equal(h.selected(), 'test/B'); assert.equal(h.requests.length, 2); assert.equal(h.controller.snapshot().attempts, 1);
});

test('current-model status follows a switch even if the request is busy-skipped, and survives success', async () => {
  const h = host(); await h.cmd('models test/B'); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); await h.tick(1000); await h.start(); await h.failure();
  let release!: () => void; h.setGate((target) => target === 'test/B' ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()); await h.tick(1000); h.setPending(true); release(); await h.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.controller.snapshot().models!.current, 'test/B'); assert.equal(h.controller.snapshot().attempts, 1);
  h.setPending(false); await h.tick(1000); await h.start(); h.entries.push({ type: 'message', id: 'ok', message: { role: 'assistant', stopReason: 'stop' } }); await h.fire('turn_end', { outcome: 'completed' }); await h.fire('agent_settled', { aborted: false });
  assert.equal(h.controller.snapshot().models!.current, 'test/B'); assert.deepEqual(h.controller.snapshot().models!.attemptsInModel, {}); assert.equal(h.controller.snapshot().attempts, 0);
});

test('missing, unauthenticated and incompatible candidates are skipped without probes or consumed attempts', async () => {
  const h = host(); await h.cmd('models test/B test/C'); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); await h.tick(1000); await h.start(); h.missingAuth.add('test/B'); h.catalog.delete('test/C'); await h.failure();
  assert.equal(h.controller.snapshot().phase, 'exhausted'); assert.equal(h.requests.length, 1); assert.equal(h.changes.length, 0); assert.equal(h.controller.snapshot().attempts, 1); assert.ok(h.notices.some((notice) => notice.includes('鉴权'))); assert.ok(h.notices.some((notice) => notice.includes('不存在')));
  const image = host(); await image.cmd('models test/B'); image.ctx.model.input.push('image'); image.entries.push({ type: 'message', id: 'image', message: { role: 'user', content: [{ type: 'image', data: 'synthetic', mimeType: 'image/png' }] } }); await image.cmd('models after 1'); await image.cmd('when-error 1s'); await image.failure(); await image.tick(1000); await image.start(); await image.failure(); assert.equal(image.changes.length, 0); assert.equal(image.controller.snapshot().phase, 'exhausted');
});

test('a rejected switch skips that candidate and thinking adapts without adding a second wait', async () => {
  const h = host(); h.rejected.add('test/B'); h.catalog.get('test/C')!.reasoning = false;
  await h.cmd('models test/B test/C'); await h.cmd('models after 1'); await h.cmd('when-error 1s,2s'); await h.failure(); await h.tick(1000); await h.start(); await h.failure(); await h.tick(2000);
  assert.equal(h.selected(), 'test/C'); assert.equal(h.requests.at(-1).at, 3000); assert.equal(h.requests.length, 2); assert.ok(h.notices.some((notice) => notice.includes('test/C · off'))); assert.equal(h.controller.snapshot().attempts, 1);
});

for (const stop of ['off', 'manual', 'navigation', 'input']) test(`a slow switch cannot issue recovery after ${stop}`, async () => {
  const h = host(); await h.cmd('models test/B test/C'); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); await h.tick(1000); await h.start(); await h.failure();
  let release!: () => void; h.setGate((target) => target === 'test/B' ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()); await h.tick(1000);
  assert.equal(h.controller.snapshot().phase, 'switching'); assert.equal(h.controller.pending(), true);
  if (stop === 'off') await h.cmd('off');
  if (stop === 'manual') await h.manual('C');
  if (stop === 'navigation') { await h.fire('session_before_tree'); h.setScope('new-branch'); }
  if (stop === 'input') await h.fire('input', { source: 'rpc', text: 'new work' });
  release(); await h.flush(); assert.equal(h.requests.length, 1); assert.equal(h.controller.snapshot().attempts, 1);
  if (stop === 'off' || stop === 'input') assert.equal(h.selected(), 'test/A'); if (stop === 'manual') assert.equal(h.selected(), 'test/C');
  await h.tick(10000); assert.equal(h.requests.length, 1);
});

for (const takeover of ['manual', 'navigation']) test(`a cancelled switch rollback cannot overwrite a later ${takeover} selection`, async () => {
  const h = host(); await h.cmd('models test/B'); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); await h.tick(1000); await h.start(); await h.failure();
  let finishSwitch!: () => void, finishRollback!: () => void;
  h.setGate((target) => target === 'test/B' ? new Promise<void>((resolve) => { finishSwitch = resolve; }) : target === 'test/A' ? new Promise<void>((resolve) => { finishRollback = resolve; }) : Promise.resolve());
  await h.tick(1000); await h.cmd('off'); finishSwitch(); await h.flush(); assert.equal(typeof finishRollback, 'function');
  if (takeover === 'navigation') { await h.fire('session_before_tree'); h.setScope('new-branch'); }
  await h.manual('C'); finishRollback(); await h.flush();
  assert.equal(h.selected(), 'test/C', 'latest explicit selection wins even when the compensating API call is late'); assert.equal(h.requests.length, 1); assert.equal(h.controller.snapshot().enabled, false);
});

test('policy editors preserve actual usage and countdown; cancelled/stale dialogs never enable fallback', async () => {
  const h = host(); h.answers.push(false); await h.cmd('models test/B'); assert.equal(h.controller.snapshot().models, undefined);
  h.answers.push(async () => { await h.cmd('off'); return true; }); await h.cmd('models test/B'); assert.equal(h.controller.snapshot().models, undefined);
  await h.cmd('models test/B'); await h.cmd('when-error 5s count 4'); await h.failure(); await h.tick(5000); await h.start(); await h.failure(); await h.tick(1000); const due = h.controller.snapshot().nextAt;
  await h.cmd('models after 3'); assert.equal(h.controller.snapshot().attempts, 1); assert.equal(h.controller.snapshot().nextAt, due);
  await h.cmd('models off'); assert.equal(h.controller.snapshot().enabled, true); assert.equal(h.controller.snapshot().models!.enabled, false); assert.equal(h.controller.snapshot().nextAt, due);
  await h.fire('session_tree'); assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.controller.snapshot().models!.after, 3);
});

test('candidate and per-model menus return to root, preserve invalid text and allow clearing without enabling', async () => {
  const h = host(); h.answers.push('修改候选顺序', 'test/B', '保存候选顺序', true, '退出菜单'); await h.cmd('models'); assert.equal(h.controller.snapshot().models!.enabled, false); assert.equal(h.controller.snapshot().enabled, false);
  h.answers.push('修改每模型次数', 'bad', '3', true, '退出菜单'); await h.cmd('models'); assert.ok(h.dialogs.some((dialog) => dialog.prefill === 'bad')); assert.equal(h.controller.snapshot().models!.after, 3);
  h.answers.push('开启模型替代', true, '退出菜单'); await h.cmd('models'); assert.equal(h.controller.snapshot().models!.enabled, true); assert.equal(h.controller.snapshot().enabled, false);
  h.answers.push('修改候选顺序', '清空候选', '保存候选顺序', true, '退出菜单'); await h.cmd('models'); assert.deepEqual(h.controller.snapshot().models!.candidates, []); assert.equal(h.controller.snapshot().models!.enabled, false);
});
