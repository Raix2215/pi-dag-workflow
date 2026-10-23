import { RETRY_TYPE, RETRY_MESSAGE, GOAL_TYPE } from './fixtures/public-records.ts';
import { retryHost } from './fixtures/retry-public-host.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRetryModels, emptyRetryState, intervalText, parseModelRefs, parseRetrySettings, retryDelay, restoreRetryState, validateRetryState } from '../src/retry/domain/state.ts';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IsolatedClient } from './fixtures/isolated-client.ts';

// retry-models.test.ts
{
/** Model-switching behavior assembled through the public retry entry; observations come from records and notifications. */
const modelHost = async (t: Parameters<typeof retryHost>[0]) => { const h = await retryHost(t); h.installModels('test/A', 'test/B', 'test/C'); return h; };
const sent = (h: Awaited<ReturnType<typeof retryHost>>) => h.sends.filter((item) => item.message?.customType === RETRY_MESSAGE);
const countdown = (text: string) => text.split('\n').find((line) => line.startsWith('阶段：'));

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
  // Restoring the enabled flag must not revive an in-flight timer or failure.
  assert.equal(restored.enabled, true); assert.equal(restored.attempts, 2); assert.equal(saved.enabled, true);
  assert.equal(restoreRetryState([{ type: 'custom', customType: RETRY_TYPE, data: { ...saved, enabled: false } }]).enabled, false);
  assert.deepEqual(restoreRetryState([]), emptyRetryState());
  assert.throws(() => restoreRetryState([{ type: 'custom', customType: RETRY_TYPE, data: { version: 99 } }]));
  for (const bad of [{ ...saved, attempts: -1 }, { ...saved, settings: { intervals: [Infinity] } }, { ...saved, cancelledFailure: '' }, { ...saved, enabled: false, settings: false }, { ...saved, settings: { intervals: [1500] } }]) assert.throws(() => validateRetryState(bad as never));
});

test('U7.4 resumeAfterCompaction accepts only optional booleans', () => {
  for (const resumeAfterCompaction of [undefined, true, false]) {
    const state = { ...emptyRetryState(), settings: { intervals: [1000], ...(resumeAfterCompaction === undefined ? {} : { resumeAfterCompaction }) } };
    assert.doesNotThrow(() => validateRetryState(state));
  }
  for (const resumeAfterCompaction of [null, 'true', 0, 1, {}, []]) assert.throws(() => validateRetryState({ ...emptyRetryState(), settings: { intervals: [1000], resumeAfterCompaction } } as never));
});

test('fallback references/settings are bounded, branch-restored and do not enable retry', () => {
  assert.deepEqual(defaultRetryModels(), { enabled: false, candidates: [], after: 2 }); assert.deepEqual(parseModelRefs(['provider/family/model']), [{ provider: 'provider', id: 'family/model' }]);
  for (const refs of [[], ['A'], ['/A'], ['p/'], ['p/A', 'p/A'], ['p/A\nB'], Array.from({ length: 9 }, (_, i) => `p/${i}`)]) assert.throws(() => parseModelRefs(refs));
  const saved = { ...emptyRetryState(), models: { enabled: true, candidates: parseModelRefs(['test/B']), after: 2 } }; assert.deepEqual(restoreRetryState([{ type: 'custom', customType: RETRY_TYPE, data: saved }]), saved);
  for (const models of [{ enabled: true, candidates: [], after: 2 }, { enabled: false, candidates: [], after: 0 }, { enabled: 'yes', candidates: [], after: 2 }]) assert.throws(() => validateRetryState({ ...saved, models } as never));
});

test('compaction preserves the model ladder allowance instead of retrying its base model forever', async t => {
  const h = await modelHost(t); h.answers.push(true); await h.cmd('models test/B test/C');
  await h.cmd('when-error 1s'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start');
  await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start');
  await h.failure(); await h.fire('session_before_compact', { willRetry: false });
  const compactionEntry = { type: 'compaction', id: 'model-ladder-compacted' }; h.entries.push(compactionEntry);
  await h.fire('session_compact', { compactionEntry, willRetry: false }); h.tick(1000); await h.flush();
  assert.deepEqual(sent(h).map(item => item.model), ['test/A', 'test/A', 'test/B'], 'two used attempts on the base model survive compaction');
  await h.fire('turn_start'); assert.equal(h.state().attempts, 3);
});

test('two attempts per model share the global interval sequence; finite candidates stop even without count', async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B test/C');
  assert.equal(h.state()?.enabled ?? false, false); assert.match(h.requests[0].value, /发送当前上下文/);
  await h.cmd('when-error 1s,2s'); await h.failure();
  for (let i = 0; i < 6; i++) { h.tick(i % 2 ? 2000 : 1000); await h.flush(); assert.equal(sent(h).length, i + 1); assert.equal(sent(h)[i].model, ['test/A', 'test/A', 'test/B', 'test/B', 'test/C', 'test/C'][i]); await h.fire('turn_start'); await h.failure(); }
  assert.deepEqual(h.modelChanges, ['test/B', 'test/C']); assert.equal(h.state()?.attempts, 6); assert.match(await h.status(), /阶段：已耗尽/);
  assert.ok(h.notices.some((notice) => notice.includes('候选已用完')));
  h.tick(100000); await h.flush(); assert.equal(sent(h).length, 6); assert.equal(h.currentModel(), 'test/C');
});

test('total count caps the whole chain; success retains the selected model and resets both streak budgets', async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B test/C'); await h.cmd('when-error 1s count 3'); await h.failure();
  for (let i = 0; i < 3; i++) { h.tick(1000); await h.flush(); await h.fire('turn_start'); if (i < 2) await h.failure(); }
  assert.equal(h.currentModel(), 'test/B'); assert.equal(h.state()?.attempts, 3);
  await h.success();
  assert.equal(h.currentModel(), 'test/B'); assert.equal(h.state()?.attempts, 0); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); assert.equal(sent(h).at(-1).model, 'test/B'); await h.failure();
  h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure();
  assert.equal(h.currentModel(), 'test/C'); assert.match(await h.status(), /阶段：已耗尽/); assert.equal(h.state()?.attempts, 3);
});

test('busy deadlines do not switch models or consume actual attempts', async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B'); h.answers.push(true); await h.cmd('models after 1'); await h.cmd('when-error 1s,2s count 3'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure();
  h.setPending(true); h.tick(2000); await h.flush(); assert.equal(h.modelChanges.length, 0); assert.equal(h.state()?.attempts, 1); assert.equal(h.state()?.skipped, 1);
  h.setPending(false); h.tick(1999); await h.flush(); assert.equal(h.modelChanges.length, 0); h.tick(1); await h.flush(); assert.equal(h.currentModel(), 'test/B'); assert.equal(sent(h).length, 2); assert.equal(h.state()?.attempts, 1);
});

test('current-model status follows a switch even if the request is busy-skipped, and survives success', async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B'); h.answers.push(true); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure();
  let release!: () => void; h.gateModel((target) => target === 'test/B' ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()); h.tick(1000); await h.flush(); h.setPending(true); release(); await h.flush();
  assert.equal(sent(h).length, 1); assert.match(await h.status(), /实际使用模型：test\/B/); assert.equal(h.state()?.attempts, 1);
  h.setPending(false); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.success();
  assert.match(await h.status(), /实际使用模型：test\/B/); assert.equal((await h.status()).includes('各模型已用'), false); assert.equal(h.state()?.attempts, 0);
});

test('missing, unauthenticated and incompatible candidates are skipped without probes or consumed attempts', async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B test/C'); h.answers.push(true); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); h.noAuth.add('test/B'); h.catalog.delete('test/C'); await h.failure();
  assert.match(await h.status(), /阶段：已耗尽/); assert.equal(sent(h).length, 1); assert.equal(h.modelChanges.length, 0); assert.equal(h.state()?.attempts, 1); assert.ok(h.notices.some((notice) => notice.includes('鉴权'))); assert.ok(h.notices.some((notice) => notice.includes('不存在')));
  const image = await modelHost(t); image.answers.push(true); await image.cmd('models test/B'); image.answers.push(true); await image.cmd('models after 1'); image.catalog.get('test/A')!.input.push('image'); image.entries.push({ type: 'message', id: 'image', message: { role: 'user', content: [{ type: 'image', data: 'synthetic', mimeType: 'image/png' }] } }); await image.cmd('when-error 1s'); await image.failure(); image.tick(1000); await image.flush(); await image.fire('turn_start'); await image.failure(); assert.equal(image.modelChanges.length, 0); assert.match(await image.status(), /阶段：已耗尽/);
});

test('a rejected switch skips that candidate and thinking adapts without adding a second wait', async (t) => {
  const h = await modelHost(t);
  h.rejected.add('test/B'); h.catalog.get('test/C')!.reasoning = false;
  h.answers.push(true); await h.cmd('models test/B test/C'); h.answers.push(true); await h.cmd('models after 1'); await h.cmd('when-error 1s,2s'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure(); h.tick(2000); await h.flush();
  assert.equal(h.currentModel(), 'test/C'); assert.equal(sent(h).at(-1).at, 3000); assert.equal(sent(h).length, 2); assert.ok(h.notices.some((notice) => notice.includes('test/C · off'))); assert.equal(h.state()?.attempts, 1);
});

for (const stop of ['off', 'manual', 'navigation', 'input']) test(`a slow switch cannot issue recovery after ${stop}`, async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B test/C'); h.answers.push(true); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure();
  let release!: () => void; h.gateModel((target) => target === 'test/B' ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()); h.tick(1000); await h.flush();
  assert.match(await h.status(), /阶段：切换替代模型/);
  if (stop === 'off') await h.cmd('off');
  if (stop === 'manual') await h.manualSelect('C');
  if (stop === 'navigation') await h.fire('session_before_tree');
  if (stop === 'input') await h.fire('input', { source: 'rpc', text: 'new work' });
  release(); await h.flush(); assert.equal(sent(h).length, 1); assert.equal(h.state()?.attempts, 1);
  if (stop === 'off' || stop === 'input') assert.equal(h.currentModel(), 'test/A'); if (stop === 'manual') assert.equal(h.currentModel(), 'test/C');
  h.tick(10000); await h.flush(); assert.equal(sent(h).length, 1);
});

for (const takeover of ['manual', 'navigation']) test(`a cancelled switch rollback cannot overwrite a later ${takeover} selection`, async (t) => {
  const h = await modelHost(t);
  h.answers.push(true); await h.cmd('models test/B'); h.answers.push(true); await h.cmd('models after 1'); await h.cmd('when-error 1s'); await h.failure(); h.tick(1000); await h.flush(); await h.fire('turn_start'); await h.failure();
  let finishSwitch!: () => void, finishRollback!: () => void;
  h.gateModel((target) => target === 'test/B' ? new Promise<void>((resolve) => { finishSwitch = resolve; }) : target === 'test/A' ? new Promise<void>((resolve) => { finishRollback = resolve; }) : Promise.resolve());
  h.tick(1000); await h.flush(); await h.cmd('off'); finishSwitch(); await h.flush(); assert.equal(typeof finishRollback, 'function');
  if (takeover === 'navigation') await h.fire('session_before_tree');
  await h.manualSelect('C'); finishRollback(); await h.flush();
  assert.equal(h.currentModel(), 'test/C'); assert.equal(sent(h).length, 1); assert.equal(h.state()?.enabled, false);
});

test('policy editors preserve actual usage and countdown; cancelled/stale dialogs never enable fallback', async (t) => {
  const h = await modelHost(t);
  h.answers.push(false); await h.cmd('models test/B'); assert.equal(h.state()?.models, undefined);
  h.answers.push(async () => { await h.cmd('off'); return true; }); await h.cmd('models test/B'); assert.equal(h.state()?.models, undefined);
  h.answers.push(true); await h.cmd('models test/B'); await h.cmd('when-error 5s count 4'); await h.failure(); h.tick(5000); await h.flush(); await h.fire('turn_start'); await h.failure(); h.tick(1000); await h.flush(); const due = countdown(await h.status());
  h.answers.push(true); await h.cmd('models after 3'); assert.equal(h.state()?.attempts, 1); assert.equal(countdown(await h.status()), due);
  await h.cmd('models off'); assert.equal(h.state()?.enabled, true); assert.equal(h.state()?.models?.enabled, false); assert.equal(countdown(await h.status()), due);
  await h.fire('session_tree'); assert.match(await h.status(), /自动重试：开启/); assert.equal(h.state()?.models?.after, 3);
  assert.match(await h.status(), /阶段：等待下一次错误/);
});

test('candidate, count and switch edits stay in an inline draft and save together without enabling retry', async (t) => {
  const h = await modelHost(t);
  // Adding a candidate is a draft edit inside the same panel: saving never turns automatic retry on.
  h.answers.push('替代模型', '添加候选模型', 'B', '替代模型', '保存候选设置', true, '退出菜单'); await h.menu(); assert.equal(h.state()?.models?.enabled, false); assert.equal(h.state()?.enabled, false); assert.deepEqual(h.state()?.models?.candidates, [{ provider: 'test', id: 'B' }]);
  // Invalid text keeps the editor open with the reason instead of dropping the draft.
  h.answers.push('替代模型', '每模型尝试次数', 'bad', '3', '替代模型', '保存候选设置', true, '退出菜单'); await h.menu(); assert.ok(h.requests.some((request) => request.method === 'editor' && request.value === 'bad')); assert.equal(h.state()?.models?.after, 3);
  h.answers.push('替代模型', '启用替代（草稿）', '替代模型', '保存候选设置', true, '退出菜单'); await h.menu(); assert.equal(h.state()?.models?.enabled, true); assert.equal(h.state()?.enabled, false);
  h.answers.push('替代模型', '清空草稿候选', '替代模型', '保存候选设置', true, '退出菜单'); await h.menu(); assert.deepEqual(h.state()?.models?.candidates, []); assert.equal(h.state()?.models?.enabled, false);
});
}

// retry-models-integration.test.ts
{
async function clientFor(extra: string[] = [], language = 'zh-CN') {
  const root = await mkdtemp(join(tmpdir(), 'dag-model-fallback-')); await mkdir(join(root, 'agent')); await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  return IsolatedClient.start(root, 'retry-fallback', extra, ['--dag-test-retry-failures', '100', '--dag-test-context-export'], false, undefined, language);
}
async function confirm(client: IsolatedClient, text: string) {
  const mark = client.records.length, running = client.prompt(text); await client.until(() => client.records.slice(mark).some((record) => record.method === 'confirm'));
  const dialog = client.records.slice(mark).find((record) => record.method === 'confirm')!; assert.match(String(dialog.message), /current context|当前上下文/);
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: dialog.id, confirmed: true })}\n`); await running;
}
async function configure(client: IsolatedClient) { await confirm(client, '/retry models dag-test/reasoned'); await confirm(client, '/retry models after 1'); await client.prompt('/retry when-error 1s'); }
const retryState = (client: IsolatedClient) => client.records.filter((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === RETRY_TYPE).map((record) => (record.entry as any).data).at(-1);
const selected = async (client: IsolatedClient) => ((await client.send('get_state')).data as any).model.id;

for (const language of ['zh-CN', 'en']) test(`actual Pi: fallback switches the session, exhausts candidates and persists no global model default (${language})`, { timeout: 30000 }, async (t) => {
  const client = await clientFor([], language); t.after(() => client.close()); await configure(client); await client.prompt('RETRY-TEST model fallback');
  await client.until(() => client.records.some((record) => record.method === 'notify' && /candidates exhausted|候选已用完/.test(String(record.message))));
  assert.equal(retryState(client).attempts, 2); assert.equal(await selected(client), 'reasoned');
  const entries = await client.entries() as any[]; assert.equal(entries.filter((entry) => entry.customType === RETRY_MESSAGE).length, 2);
  const messages = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error'); assert.deepEqual(messages.map((entry) => entry.message.model), ['scripted', 'scripted', 'reasoned']);
  const { readFile } = await import('node:fs/promises'); const settings = JSON.parse(await readFile(join(client.root, 'agent', 'settings.json'), 'utf8')); assert.equal(settings.defaultModel, undefined); assert.equal(settings.defaultProvider, undefined);
  await client.prompt('/retry off'); assert.equal(await selected(client), 'reasoned', 'ordinary off does not switch back'); assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi: autoresearch does not override candidate exhaustion or restart the failed chain', { timeout: 30000 }, async (t) => {
  const client = await clientFor(); t.after(() => client.close()); await client.prompt('TEST CALL goal {"action":"create","title":"出错暂停测试","maxTurns":1}');
  await client.prompt('/goal autoresearch #1 on');
  await configure(client); await client.prompt('/goal enable #1'); await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('候选已用完')));
  const entries = await client.entries() as any[], goal = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(goal.goals[0].autoresearch, true); assert.notEqual(goal.goals[0].status, 'completed'); assert.equal(goal.run.paused, true); assert.equal(goal.run.used, 3); assert.equal(retryState(client).attempts, 2); assert.equal(await selected(client), 'reasoned');
  await client.prompt('/retry status'); assert.equal(retryState(client).attempts, 2); assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi: changing Goal mode during an error wait cancels recovery and leaves an explicit paused state', { timeout: 30000 }, async (t) => {
  const client = await clientFor(); t.after(() => client.close()); await client.prompt('TEST CALL goal {"action":"create","title":"出错暂停测试","maxTurns":6}'); await configure(client);
  await client.prompt('/goal enable #1'); await client.until(() => retryState(client)?.failure !== undefined);
  const before = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  await client.prompt('/goal autoresearch #1 on');
  const entries = await client.entries() as any[], after = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(after.goals[0].autoresearch, true); assert.equal(after.run.used, before.run.used); assert.equal(after.run.paused, true, 'scope invalidation must not leave a running Goal with a stranded error hold');
  assert.equal(entries.filter((entry) => entry.customType === RETRY_MESSAGE).length, 0); await client.prompt('/retry off');
});

test('actual Pi: off during a slow model-select observer cancels the request and restores only this session selection', { timeout: 30000 }, async (t) => {
  const delay = new URL('./fixtures/retry-model-delay.ts', import.meta.url).pathname, client = await clientFor([delay]); t.after(() => client.close()); await configure(client); await client.prompt('RETRY-TEST slow switch');
  await client.until(() => client.records.some((record) => record.method === 'notify' && record.message === 'Synthetic slow model selection entered')); await client.prompt('/retry off');
  await client.until(() => client.records.some((record) => record.type === 'response' && record.command === 'prompt') && retryState(client).enabled === false);
  const deadline = Date.now() + 3000; while (await selected(client) !== 'scripted') { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 30)); }
  const entries = await client.entries() as any[]; assert.equal(entries.filter((entry) => entry.customType === RETRY_MESSAGE).length, 1); assert.equal(retryState(client).attempts, 1); assert.equal(retryState(client).enabled, false); assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});
}
