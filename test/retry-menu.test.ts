import { RETRY_MESSAGE, GOAL_TYPE } from './fixtures/public-records.ts';
import { retryHost } from './fixtures/retry-public-host.ts';
import { recordPanels } from './fixtures/public-host.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedClient, type RpcRecord } from './fixtures/isolated-client.ts';
import { RETRY_REQUEST_MESSAGE } from './fixtures/public-records.ts';

for (const language of ['zh-CN', 'en'] as const) test(`U7.1 root interval/count rows edit in the value column without a settings page (${language})`, async t => {
  const h = await retryHost(t, ['retry'], language); await h.cmd('on'); h.ctx.mode = 'tui';
  const styles: { text: string; fg: string }[] = []; h.ctx.ui.theme = { style(text: string, options: { fg: string }) { styles.push({ text, ...options }); return text; } };
  const panels = recordPanels(h.ctx), opening = h.menu(), intervalLabel = language === 'zh-CN' ? '重试间隔' : 'Retry intervals', countLabel = language === 'zh-CN' ? '重试次数' : 'Retry count';
  await panels.wait(() => panels.live() === 1); let rendered = panels.frame();
  assert.ok(rendered.some(line => line.includes(intervalLabel) && line.includes('30s, 2m, 5m, 15m')));
  assert.ok(rendered.some(line => line.includes(countLabel)));
  assert.doesNotMatch(rendered.join('\n'), /重试设置|Retry settings/);
  await panels.focus(intervalLabel); const column = panels.frame().find(line => line.includes(intervalLabel))!.indexOf('30s');
  await panels.press('\r'); const editing = panels.frame().find(line => line.includes(intervalLabel))!;
  assert.equal(editing.slice(column, column + 2), '> ', 'the native Input starts exactly at the value column');
  assert.equal(editing.indexOf('30s'), column + 2);
  await panels.press('\x01'); await panels.press('\x0b'); await panels.press('bad'); await panels.press('\r');
  const rejected = panels.frame();
  assert.ok(rejected.some(line => /s\/m\/h/.test(line)), 'the hint slot explains the accepted interval format');
  assert.ok(rejected.some(line => line.includes('bad')), 'the rejected draft is still in the editor');
  assert.equal(panels.live(), 1, 'the editor stays mounted instead of closing');
  assert.ok(styles.some(style => style.fg === 'error'), 'the rejection reason uses the error tone');
  await panels.press('\x01'); await panels.press('\x0b'); await panels.press('5m, 10m'); await panels.press('\r'); await panels.press('\r');
  assert.deepEqual(h.state().settings.intervals, [300000, 600000]); assert.equal(h.state().enabled, true);
  await panels.focus(countLabel); await panels.press('\r'); await panels.press('3'); await panels.press('\r'); await panels.press('\r');
  assert.equal(h.state().settings.count, 3);
  // Esc cancels the count editor without touching the saved value.
  await panels.focus(countLabel); await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press('\x1b'); assert.equal(h.state().settings.count, 3);
  // Esc cancels the interval editor the same way.
  await panels.focus(intervalLabel); await panels.press('\r'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press('1m'); await panels.press('\x1b');
  assert.deepEqual(h.state().settings.intervals, [300000, 600000], 'Esc leaves the saved intervals untouched');
  assert.equal(panels.mounts(), 1); assert.doesNotMatch(panels.frame()[0]!, / › /);
  assert.ok(styles.some(style => style.text === '3' && style.fg === 'muted'));
  await panels.press('\x1b'); await opening; assert.equal(panels.live(), 0);
});

for (const language of ['zh-CN', 'en'] as const) test(`U7.4 compaction toggle persists settings and is visible in status (${language})`, async t => {
  const h = await retryHost(t, ['retry'], language); h.ctx.mode = 'tui';
  const styles: { text: string; fg: string }[] = []; h.ctx.ui.theme = { style(text: string, options: { fg: string }) { styles.push({ text, ...options }); return text; } };
  const panels = recordPanels(h.ctx), label = language === 'zh-CN' ? '压缩后自动继续' : 'Continue after compaction';
  let opening = h.menu(); await panels.wait(() => panels.live() === 1);
  assert.ok(panels.frame().some(line => line.includes(label) && (language === 'zh-CN' ? /开启\s*$/ : /on\s*$/).test(line)));
  await panels.select(label); assert.equal(h.state().settings.resumeAfterCompaction, false); assert.equal(h.state().enabled, false);
  assert.ok(panels.frame().some(line => line.includes(label) && (language === 'zh-CN' ? /关闭\s*$/ : /off\s*$/).test(line)));
  assert.ok(styles.some(style => style.text === (language === 'zh-CN' ? '关闭' : 'off') && style.fg === 'dim'));
  await panels.press('\x1b'); await opening;
  await h.cmd('when-error 5m count 2'); await h.cmd('off'); await h.cmd('on');
  assert.equal(h.state().settings.resumeAfterCompaction, false, 'interval/count commands and on/off preserve the new preference');
  assert.match(await h.status(), language === 'zh-CN' ? /压缩后自动继续：关闭/ : /Continue after compaction: off/);
  opening = h.menu(); await panels.wait(() => panels.live() === 1); await panels.select(label);
  assert.equal(h.state().settings.resumeAfterCompaction, true);
  assert.ok(styles.some(style => style.text === (language === 'zh-CN' ? '开启' : 'on') && style.fg === 'accent'));
  await panels.press('\x1b'); await opening;
  assert.match(await h.status(), language === 'zh-CN' ? /压缩后自动继续：开启/ : /Continue after compaction: on/);
  const before = h.entries.length; await h.fire('session_tree'); assert.equal(h.entries.length, before);
});

for (const language of ['zh-CN', 'en'] as const) test(`ticket01 R43: lower Retry toggles share plain values while upper dotted values keep brackets (${language})`, async t => {
  const h = await retryHost(t, ['retry'], language); h.ctx.mode = 'tui'; h.ctx.ui.theme = { style: (text: string) => text };
  const panels = recordPanels(h.ctx), opening = h.menu(); await panels.wait(() => panels.live() === 1);
  const frame = panels.frame(), rules = frame.flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
  const upper = frame.slice(rules[0]! + 1, rules[1]), lower = frame.slice(rules[1]! + 1, rules[2]);
  assert.ok(upper.some(line => /\.{3,}/.test(line)), 'the upper zone has actual dotted status rows');
  assert.ok(upper.filter(line => /\.{3,}/.test(line)).every(line => /\[[^\]]+\]/.test(line)));
  assert.doesNotMatch(lower.join('\n'), /[\[\]]/);
  for (const label of language === 'zh-CN' ? ['压缩后自动继续'] : ['Continue after compaction']) assert.match(lower.find(line => line.includes(label))!, language === 'zh-CN' ? /开启\s*$/ : /on\s*$/);
  await panels.press('\x1b'); await opening;
});

// retry-menu.test.ts
{
/** Map a scripted id/label onto the real display option (label plus current value) that the menu renders. */
function displayChoice(options: readonly string[], wanted: string): string {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
  const target = norm(wanted);
  const exact = options.find((option) => option === wanted || norm(option) === target);
  if (exact) return exact;
  const prefixed = options.find((option) => norm(option).startsWith(`${target} `));
  if (prefixed) return prefixed;
  throw new Error(`no display option for ${JSON.stringify(wanted)} in ${JSON.stringify(options)}`);
}

const intervals = (h: Awaited<ReturnType<typeof retryHost>>) => h.state()?.settings?.intervals?.map((ms: number) => `${ms / 1000}s`).join(',');
const reply = (h: Awaited<ReturnType<typeof retryHost>>, ...answers: unknown[]) => h.answers.push(...answers);
const wakes = (h: Awaited<ReturnType<typeof retryHost>>) => h.sends.filter((item) => item.message.customType === RETRY_MESSAGE);

for (const language of ['zh-CN', 'en'] as const) test(`settings/status return to the menu; only root exit or cancel closes (${language})`, async (t) => {
  const h = await retryHost(t, ['retry'], language); const zh = language === 'zh-CN';
  const settings = zh ? '重试间隔' : 'Retry intervals', back = zh ? '返回' : 'Back', models = zh ? '替代模型' : 'Alternative models', exit = zh ? '退出菜单' : 'Exit menu';
  reply(h, settings, undefined, models, back, exit); await h.menu();
  assert.equal(h.requests.length, 5); assert.equal(h.entries.length, 0); assert.equal(wakes(h).length, 0);
  assert.ok(h.requests[0].value.includes(exit));
  // Status is shown directly in the heading now: readable text, never JSON, and no separate status entry.
  assert.match(h.requests[0].title, zh ? /自动重试：关闭/ : /Automatic retry: off/);
  assert.ok(!h.requests[0].title.trim().startsWith('{'));
  assert.ok(!h.requests[0].value.some((option: string) => /查看状态|show status/i.test(option)));
  assert.deepEqual(h.requests[0].value, h.requests[2].value); assert.deepEqual(h.requests[0].value, h.requests[4].value);
  reply(h, settings, undefined, undefined); await h.menu(); assert.equal(h.requests.length, 8);
});

test('invalid editor text is kept editable, confirmed settings return to root without enabling', async (t) => {
  const h = await retryHost(t); reply(h, '重试间隔', 'not an interval', '2s,3s', true, '退出菜单'); await h.menu();
  const edits = h.requests.filter((request) => request.method === 'editor');
  assert.equal(edits.length, 2); assert.equal(edits[1].value, 'not an interval'); assert.ok(h.notices.length > 0);
  assert.equal(intervals(h), '2s,3s'); assert.equal((h.state()?.enabled ?? false), false);
  assert.equal(h.requests.at(-1).value.some((option: string) => option.includes('重试间隔')), true);
});

test('cancelled text or confirmation leaves settings and timer unchanged and returns one level', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 3s count 4'); await h.failure(); h.tick(400); const before = await h.status(), writes = h.entries.length;
  reply(h, '重试间隔', undefined, '重试次数', '5', false, '退出菜单'); await h.menu();
  assert.equal(h.entries.length, writes); assert.equal(await h.status(), before); assert.equal((h.state()?.settings?.count ?? null), 4);
});

test('unchanged settings do not write or restart an existing countdown', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 3s count 4'); await h.failure(); h.tick(400); const before = await h.status(), writes = h.entries.length;
  reply(h, '重试间隔', '3s', '退出菜单'); await h.menu();
  assert.equal(h.entries.length, writes); assert.equal(await h.status(), before);
  assert.equal(h.requests.some((request) => request.method === 'confirm'), false);
});

test('count edits preserve attempts and remaining time; interval edits alone restart the interval', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s,5s count 4'); await h.failure(); h.tick(1000); await h.fire('turn_start'); await h.failure(); h.tick(700);
  const nextAt = await h.status();
  reply(h, '重试次数', '5', true, '退出菜单'); await h.menu();
  assert.equal((h.state()?.attempts ?? 0), 1); assert.equal((await h.status()).includes('约 4s 后'), nextAt.includes('约 4s 后')); assert.equal((h.state()?.settings?.count ?? null), 5);
  reply(h, '重试间隔', '2s', true, '退出菜单'); await h.menu();
  assert.equal((h.state()?.attempts ?? 0), 1); assert.match(await h.status(), /等待重试（约 2s 后）/);
});

test('empty count is unlimited while Esc never clears a configured count', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 3s count 4');
  reply(h, '重试次数', undefined, '退出菜单'); await h.menu(); assert.equal((h.state()?.settings?.count ?? null), 4);
  reply(h, '重试次数', '', true, '退出菜单'); await h.menu(); assert.equal((h.state()?.settings?.count ?? null), null);
});

test('toggle operations refresh root and first enabling obtains missing settings', async (t) => {
  const h = await retryHost(t); reply(h, '自动重试', '自动重试', '退出菜单'); await h.menu();
  assert.equal((h.state()?.enabled ?? false), false); assert.equal(intervals(h), '30s,120s,300s,900s'); assert.equal(wakes(h).length, 0);
  // The row keeps one stable label and reports state in its value column, so search and muscle memory stay valid.
  assert.match(h.requests.at(-1).value[0], /^自动重试\s+关闭$/);
});

test('a stale editor or confirmation cannot overwrite external policy edits', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2');
  reply(h, '重试间隔', async () => { await h.cmd('when-error 5s count 8'); return '2s'; }, '退出菜单'); await h.menu();
  assert.equal(intervals(h), '5s'); assert.equal((h.state()?.settings?.count ?? null), 8);
  assert.equal(h.requests.some((request) => request.method === 'confirm'), false);
});

for (const event of ['session_before_tree', 'session_before_switch', 'session_before_fork', 'session_shutdown']) test(`old confirmation is discarded after ${event}`, async (t) => {
  const h = await retryHost(t); reply(h, '重试间隔', '2s', async () => { await h.fire(event); return true; }); await h.menu();
  assert.equal(intervals(h), undefined); assert.equal((h.state()?.enabled ?? false), false);
  reply(h, '退出菜单'); await h.menu(); // Old finally does not leave a stuck menu guard.
});

test('reducing count to spent attempts pauses Goal recovery; raising it permits remaining attempts', async (t) => {
  const h = await retryHost(t);
  await h.cmd('when-error 1s count 4'); await h.failure(); h.tick(1000); await h.fire('turn_start'); await h.failure();
  reply(h, '重试次数', '1', true, '退出菜单'); await h.menu();
  assert.equal((await h.status()).includes('已耗尽'), true); assert.equal((h.state()?.attempts ?? 0), 1); assert.equal(wakes(h).length, 1);
  h.tick(10000); assert.equal(wakes(h).length, 1);
  reply(h, '重试次数', '2', true, '退出菜单'); await h.menu();
  assert.equal((await h.status()).includes('等待'), true); assert.equal((h.state()?.attempts ?? 0), 1);
  h.tick(1000); assert.equal(wakes(h).length, 2);
});

test('the count row has no dead end without prior intervals and never enables retry', async (t) => {
  const h = await retryHost(t); reply(h, '重试次数', '3', true, '退出菜单'); await h.menu();
  // No disabled row and no dead-end command hint: editing the count on its own fills in the default intervals.
  assert.equal(intervals(h), '30s,120s,300s,900s', 'the editor reports the interval list it would keep');
  assert.equal((h.state()?.settings?.count ?? null), 3);
  assert.equal((h.state()?.enabled ?? false), false, 'saving a count never turns retry on');
});

test('a pending timer skips without probing command delivery while the root menu is open', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2'); await h.failure();
  reply(h, () => { h.tick(1000); assert.equal(wakes(h).length, 0); assert.equal((h.state()?.attempts ?? 0), 0); assert.equal((h.state()?.skipped ?? 0), 1); return '退出菜单'; }); await h.menu();
  assert.equal(wakes(h).length, 0); h.tick(999); assert.equal(wakes(h).length, 0); h.tick(1); assert.equal(wakes(h).length, 1);
});

test('success during a menu keeps navigation open while resetting the streak', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2'); await h.failure();
  reply(h, async () => { await h.fire('turn_end', { outcome: 'completed' }); return '重试间隔'; }, undefined, '退出菜单'); await h.menu();
  assert.equal(h.requests.length, 3); assert.equal((h.state()?.attempts ?? 0), 0); assert.equal((await h.status()).includes('等待下一次错误'), true);
});

test('scope changes and external confirmations cannot apply stale settings', async (t) => {
  const h = await retryHost(t, ['plan', 'retry']); await h.cmd('when-error 1s count 2');
  reply(h, '重试间隔', '2s', async () => { await h.commands.get('plan').handler('start', h.ctx); return true; }); await h.menu(); assert.equal(intervals(h), '1s');
  reply(h, '重试间隔', '2s', async () => { await h.cmd('when-error 5s count 8'); return true; }, '退出菜单'); await h.menu();
  assert.equal(intervals(h), '5s'); assert.equal((h.state()?.settings?.count ?? null), 8);
});

test('old menu completion cannot release a new menu guard or erase its owned prompt', async (t) => {
  const h = await retryHost(t); let oldReply!: (value: string) => void, newReply!: (value: string) => void;
  reply(h, () => new Promise<string>((resolve) => { oldReply = resolve; })); const old = h.menu();
  await h.fire('session_before_tree'); reply(h, () => new Promise<string>((resolve) => { newReply = resolve; })); const newer = h.menu();
  oldReply('退出菜单'); await old;
  // Ownership is registered under the dialog title (the heading's first line), not the whole summary block.
  assert.equal(h.requests.at(-1).method, 'select'); await h.menu(); assert.ok(h.notices.some((message) => message.includes('重试菜单已打开')));
  newReply('退出菜单'); await newer; assert.equal(h.requests.at(-1).method, 'select');
});

for (const retryFirst of [true, false]) test(`active Goal recognizes owned dialogs but pauses on foreign input (retry first: ${retryFirst})`, async (t) => {
  const h = await retryHost(t, retryFirst ? ['retry', 'todos', 'goal'] : ['todos', 'goal', 'retry']);
  const goal = () => h.entries.filter((entry) => entry.customType === GOAL_TYPE).at(-1)?.data;
  await h.call('goal', { action: 'create', title: 'Menu scope', maxTurns: 2 }); assert.equal(goal().goals[0].title, 'Menu scope');
  await h.fire('input', { source: 'rpc', text: 'enable' });
  await h.call('goal', { action: 'enable', id: 1 }); assert.equal(goal().focusId, 1);
  assert.equal(goal().run.paused, false);
  let step = 0; const replies = ['替代模型', '返回', '退出菜单'];
  h.ctx.ui.select = async (title: string, options: string[]) => {
    await h.fire('ui_prompt_start', { title, kind: 'select' });
    assert.equal(goal().run.paused, false, 'own dialog never pauses active Goal');
    await h.fire('ui_prompt_end', { title, kind: 'select' });
    return displayChoice(options, replies[step++]!);
  };
  await h.menu(); assert.equal(goal().run.paused, false);
  await h.fire('ui_prompt_start', { title: 'Foreign question', kind: 'input' });
  assert.equal(goal().run.paused, true); assert.match(goal().run.reason!, /等待用户答复/);
});

test('an explicit off while a settings confirmation is pending still wins', async (t) => {
  const h = await retryHost(t); reply(h, '重试间隔', '2s', async () => { await h.cmd('off'); return true; }, '退出菜单'); await h.menu();
  assert.equal((h.state()?.enabled ?? false), false); assert.equal(intervals(h), undefined); assert.equal(wakes(h).length, 0);
  assert.ok(h.notices.some((message) => message.includes('未保存过期输入')));
});

test('explicit unchanged configuration cannot be overwritten by an older draft', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2');
  reply(h, '重试间隔', '2s', async () => { await h.cmd('when-error 1s count 2'); return true; }, '退出菜单'); await h.menu();
  assert.equal(intervals(h), '1s'); assert.equal((h.state()?.settings?.count ?? null), 2);
});

test('only owned retry dialogs bypass Goal pause; foreign prompts merely block recovery', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2'); await h.failure();
  await h.fire('ui_prompt_start', { title: 'Foreign input' });
  assert.equal(h.requests.some((request) => request.title === 'Foreign input'), false);
  h.tick(1000); assert.equal(wakes(h).length, 0); assert.equal((h.state()?.attempts ?? 0), 0);
  await h.fire('ui_prompt_end', { title: 'Foreign input' });
  reply(h, ({ title }: any) => { assert.equal(title.includes('重试恢复'), true); return '退出菜单'; }); await h.menu();
  assert.equal(h.requests.at(-1).method, 'select');
});
}

// retry-menu-integration.test.ts
{
/** Map a scripted id/label onto the real display option (label plus current value) sent over RPC. */
function resolveOption(options: readonly string[], wanted: string): string {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
  const target = norm(wanted);
  const exact = options.find((option) => option === wanted || norm(option) === target);
  if (exact) return exact;
  const prefixed = options.find((option) => norm(option).startsWith(`${target} `));
  if (prefixed) return prefixed;
  throw new Error(`no display option for ${JSON.stringify(wanted)} in ${JSON.stringify(options)}`);
}

async function menuDriver(client: IsolatedClient) {
  let at = client.records.length;
  const next = async (method: string, title: RegExp) => {
    const matches = (record: RpcRecord) => record.type === 'extension_ui_request' && record.method === method && typeof record.id === 'string';
    await client.until(() => client.records.slice(at).some(matches));
    const index = client.records.findIndex((record, i) => i >= at && matches(record)); const record = client.records[index]!; at = index + 1;
    assert.match(String(record.title).split('\n')[0]!, title); return record;
  };
  const answer = (record: RpcRecord, response: object) => { client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, ...response })}\n`); };
  return { next, answer, choose: async (title: RegExp, value?: string) => { const record = await next('select', title); if (value !== undefined) { const target = resolveOption(record.options as string[], value); assert.ok((record.options as string[]).includes(target), `${value} in ${JSON.stringify(record.options)}`); answer(record, { value: target }); } else answer(record, { cancelled: true }); return record; } };
}
const state = (client: IsolatedClient) => client.records.filter((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === 'pi-dag-workflow.retry').map((record) => (record.entry as any).data).at(-1);
const call = async (client: IsolatedClient, name: string, args: object) => {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const result = events.find((record) => record.type === 'tool_execution_end' && record.toolName === name)!;
  assert.ok(result); assert.equal(result.isError, false, JSON.stringify(result.result)); return result.result as any;
};

test('actual Pi RPC: menu back/status/invalid correction/empty count/toggle all preserve navigation', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'retry-menu-rpc'); t.after(() => client.close());
  await client.prompt('/retry when-error 5m count 3');
  const driver = await menuDriver(client); const opening = client.prompt('/retry');
  // Status is direct readable summary text in the root heading, never JSON, and there is no separate status entry.
  const root = await driver.choose(/重试恢复/, '重试间隔');
  assert.match(String(root.title), /自动重试：开启/);
  assert.ok(!String(root.title).trim().startsWith('{'));
  assert.ok(!(root.options as string[]).some((option) => /查看状态/.test(option)));
  const first = await driver.next('editor', /间隔列表/); assert.equal(first.prefill, '5m'); driver.answer(first, { value: 'bad interval' });
  const second = await driver.next('editor', /间隔列表/); assert.equal(second.prefill, 'bad interval'); driver.answer(second, { value: '3m,4m' });
  driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
  await driver.choose(/重试恢复.*3m,4m/, '重试次数');
  const count = await driver.next('editor', /每轮最多/); assert.equal(count.prefill, '3'); driver.answer(count, { value: '' });
  driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
  // The switch applies immediately, so one selection really changes the state; a second flips it back.
  await driver.choose(/重试恢复/, '自动重试'); await client.until(() => state(client)?.enabled === false, 5000);
  await driver.choose(/重试恢复/, '自动重试'); await client.until(() => state(client)?.enabled === true, 5000);
  await driver.choose(/重试恢复/, '退出菜单'); await opening;
  assert.equal(state(client).enabled, true); assert.equal(state(client).settings.count, undefined); assert.deepEqual(state(client).settings.intervals, [180000, 240000]);
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
  assert.equal(client.records.filter((record) => record.type === 'agent_start').length, 0, 'menu interactions never run the model');
});

test('actual Pi RPC: an open menu skips a due retry and closing it does not queue an immediate request', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-menu-timer-')); await mkdir(join(root, 'agent'));
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  const client = await IsolatedClient.start(root, 'retry-menu-timer', [], ['--dag-test-retry-failures', '100']); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 1'); await client.prompt('RETRY-TEST menu timing');
  const driver = await menuDriver(client); const opening = client.prompt('/retry');
  const rootDialog = await driver.next('select', /重试恢复/);
  await client.until(() => state(client)?.skipped >= 1, 5000); assert.equal(state(client).attempts, 0);
  driver.answer(rootDialog, { value: '退出菜单' }); await opening;
  assert.equal(state(client).attempts, 0, 'closing the menu does not issue an immediate model request');
  await client.until(() => state(client)?.attempts === 1, 5000); await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 2, 5000);
  await client.prompt('/retry off'); assert.equal(state(client).attempts, 1); assert.equal(state(client).enabled, false);
  const requests = (await client.entries()).filter((entry: any) => entry.customType === RETRY_REQUEST_MESSAGE); assert.equal(requests.length, 1);
});

test('actual Pi RPC: off wins over a settings confirmation that is still pending', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'retry-menu-off-wins'); t.after(() => client.close());
  const driver = await menuDriver(client), opening = client.prompt('/retry');
  await driver.choose(/重试恢复/, '重试间隔');
  driver.answer(await driver.next('editor', /间隔列表/), { value: '2s' });
  const old = await driver.next('confirm', /确认重试设置/); await client.prompt('/retry off'); driver.answer(old, { confirmed: true });
  await driver.choose(/重试恢复/, '退出菜单'); await opening;
  const status = (await call(client, 'todo', { action: 'status' })).details.status.retry;
  assert.equal(status.enabled, false); assert.equal(status.intervals, undefined); assert.equal(status.attempts, 0);
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi RPC: reload discards an old pending confirmation and permits a fresh menu', { timeout: 30000 }, async (t) => {
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'retry-menu-reload', [controls]); t.after(() => client.close());
  await client.prompt('/retry when-error 5m count 2');
  const driver = await menuDriver(client); const opening = client.prompt('/retry');
  await driver.choose(/重试恢复/, '重试间隔');
  driver.answer(await driver.next('editor', /间隔列表/), { value: '2s' }); const old = await driver.next('confirm', /确认重试设置/);
  await client.prompt('/test-reload'); driver.answer(old, { confirmed: true }); await opening;
  const status = (await call(client, 'todo', { action: 'status' })).details.status.retry;
  assert.equal(status.intervals, '5m'); assert.equal(status.enabled, true);
  assert.equal(status.phase, 'armed');
  const fresh = await menuDriver(client); const menu = client.prompt('/retry'); await fresh.choose(/重试恢复/, '退出菜单'); await menu;
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi RPC: retry dialogs do not pause a Goal; foreign dialogs do pause it in either load order', { timeout: 30000 }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/retry-menu-dialog.ts', import.meta.url));
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const order of [['todos', 'goal'], ['goal', 'todos']]) {
    const client = await IsolatedClient.start(undefined, `retry-menu-goal-${order[0]}`, [fixture], [], false, [...order.map((feature) => `${root}src/${feature}/index.ts`), `${root}src/retry/index.ts`]);
    try {
      await call(client, 'goal', { action: 'create', title: 'Synthetic menu Goal', maxTurns: 1 });
      await call(client, 'goal', { action: 'enable', id: 1 });
      await client.prompt('/retry when-error 3m count 1');
      const driver = await menuDriver(client); const opening = client.prompt('/retry');
      await driver.choose(/重试恢复/, '重试间隔');
      driver.answer(await driver.next('editor', /间隔列表/), { value: '4m' }); driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
      await driver.choose(/重试恢复/, '退出菜单'); await opening;
      const noPause = client.records.filter((record) => record.method === 'notify').every((record) => !String(record.message).includes('等待用户答复')); assert.ok(noPause);
      const foreign = await menuDriver(client); const work = client.prompt('TEST CALL test_goal_dialog {}');
      foreign.answer(await foreign.next('input', /^Foreign dialog$/), { value: 'done' }); await work;
      const paused = client.records.filter((record) => record.method === 'notify').some((record) => String(record.message).includes('等待用户答复')); assert.ok(paused, order.join(','));
      assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
    } finally { await client.close(); }
  }
});
}
