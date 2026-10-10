import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderWidget, renderTasks, renderDag, widgetHeightBudget, type AgentView } from '../src/ui/render.ts';
import { emptyState, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';

const task = (id: number, status: Todo['status'] = 'pending'): Todo => ({ id, subject: `task-${id} 中文宽度 \x1b[2J`, status, blockedBy: id > 1 ? [id - 1] : [] });
const state = (count: number): WorkflowState => ({ ...emptyState(), tasks: Array.from({ length: count }, (_, index) => task(index + 1)), nextId: count + 1 });
const jobs: AgentView[] = Array.from({ length: 6 }, (_, index) => ({ id: `a${index + 1}`, profile: 'fixture', status: 'running', label: 'independent work' }));

test('the whole widget fits the terminal budget in both views, languages and tree styles', () => {
  for (const view of ['list', 'dag'] as const) for (const treeStyle of ['paths', 'flat'] as const) for (const locale of ['en', 'zh-CN'] as const) {
    const workflow = { ...state(24), view, treeStyle, plan: true };
    for (const width of [1, 20, 40, 80, 120]) for (const rows of [3, 9, 18, 24, 36, 60]) {
      const budget = widgetHeightBudget(rows);
      const lines = renderWidget(workflow, width, budget, { jobs, goalTitle: 'active goal', msg: createTranslator(locale) });
      assert.ok(lines.length <= budget, `${view}/${treeStyle}/${locale}/${width}x${rows}: ${lines.length} > ${budget}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes('\x1b[2J')));
    }
  }
  assert.equal(widgetHeightBudget(90), 12);
  assert.equal(widgetHeightBudget(9), 3);
  assert.equal(widgetHeightBudget(0), 1);
  assert.equal(widgetHeightBudget(NaN), 12);
  assert.deepEqual(renderWidget(state(2), 0, 12), []);
  assert.deepEqual(renderWidget(state(2), 80, 0), []);
});

test('old active work and unaccepted or failed bound reports win over newer pending tasks', () => {
  const workflow = state(100);
  for (const status of ['in_progress', 'failed', 'cancelled'] as const) {
    const changed = { ...workflow, tasks: workflow.tasks.map((todo) => todo.id === 1 ? { ...todo, status } : todo) };
    for (const budget of [2, 3]) assert.match(renderWidget(changed, 100, budget).join('\n'), /task-1 /);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'waiting', 'running'] as const) {
    const bound: AgentView = { id: 'bound', todoId: 1, profile: 'fixture', status, reportDelivery: 'delivered' };
    assert.match(renderWidget(workflow, 100, 3, { jobs: [bound] }).join('\n'), /task-1 /);
  }
  const stale: AgentView = { id: 'old', todoId: 1, profile: 'fixture', status: 'completed', taskReportStale: true };
  assert.doesNotMatch(renderWidget(workflow, 100, 3, { jobs: [stale] }).join('\n'), /task-1 /);
});

test('waiting standalone jobs remain visible in a tiny widget, and settled reports stay hidden', () => {
  const standalone: AgentView[] = [
    { id: 'closed', profile: 'fixture', status: 'failed' },
    { id: 'question', profile: 'fixture', status: 'waiting' },
    { id: 'delivered', profile: 'fixture', status: 'completed', reportDelivery: 'delivered' },
  ];
  const lines = renderWidget(state(100), 100, 3, { jobs: standalone });
  assert.ok(lines.length <= 3);
  assert.match(lines.join('\n'), /question/);
  assert.doesNotMatch(lines.join('\n'), /delivered/);
  assert.doesNotMatch(renderWidget(emptyState(), 100, 12, { jobs: [standalone[2]!] }).join('\n'), /Standalone/);
});

test('DAG previews either fit fully or clearly degrade while preserving the complete detail view', () => {
  const small = { ...state(1), view: 'dag' as const };
  const fits = renderWidget(small, 100, 12);
  assert.ok(fits.some((line) => /[┌┐]/.test(line)), fits.join('\n'));
  assert.doesNotMatch(fits.join('\n'), /降级/);
  const large = { ...state(24), view: 'dag' as const };
  const cropped = renderWidget(large, 100, 12, { jobs });
  assert.match(cropped.join('\n'), /图已降级为列表/);
  assert.equal(large.view, 'dag');
  const english = renderWidget(large, 100, 12, { msg: createTranslator('en') }).join('\n');
  assert.match(english, /Insufficient terminal height/);
  const details = renderTasks(large, 120, { maxRows: Infinity, jobs }).join('\n');
  assert.match(details, /task-1 /); assert.match(details, /task-24 /); assert.match(details, /a6/);
  assert.ok(renderDag(large, 100).length > 12, 'scrollable DAG details are not subject to the widget budget');
});

test('a fitting DAG never hides attention rows that a smaller list budget could show', () => {
  const workflow = { ...state(1), view: 'dag' as const };
  for (const status of ['waiting', 'running', 'completed', 'failed'] as const) {
    const standalone: AgentView[] = [1, 2].map((id) => ({ id: `a${id}`, profile: 'fixture', status, reportDelivery: 'pending' }));
    for (const locale of ['en', 'zh-CN'] as const) for (const treeStyle of ['paths', 'flat'] as const) for (const width of [80, 100]) {
      for (const budget of [7, widgetHeightBudget(24), 9, 12]) {
        const lines = renderWidget({ ...workflow, treeStyle }, width, budget, { jobs: standalone, msg: createTranslator(locale) });
        assert.ok(lines.length <= budget);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.match(lines.join('\n'), /a1/, `${status}/${locale}/${width}/${budget}`);
        assert.match(lines.join('\n'), /a2/, `${status}/${locale}/${width}/${budget}`);
        assert.equal((lines.join('\n').match(/Standalone/g) ?? []).length, 1);
        if (budget >= 9) assert.ok(lines.some((line) => /[┌┐]/.test(line)), 'keep the graph when attention rows fit too');
      }
    }
  }
});

test('narrow filtered DAG fallbacks keep complete hidden prerequisites or an explicit warning', () => {
  for (const treeStyle of ['paths', 'flat'] as const) for (const locale of ['en', 'zh-CN'] as const) {
    const workflow: WorkflowState = { ...state(3), view: 'dag', filter: 'pending', treeStyle, tasks: [
      { ...task(1, 'completed'), blockedBy: [] },
      { ...task(2, 'completed'), blockedBy: [] },
      { ...task(3), blockedBy: [1, 2] },
    ] };
    const before = structuredClone(workflow);
    const msg = createTranslator(locale);
    const lines = renderWidget(workflow, 20, widgetHeightBudget(36), { msg });
    assert.ok(lines.length <= widgetHeightBudget(36));
    assert.ok(lines.every((line) => visibleWidth(line) <= 20));
    assert.match(lines.join('\n'), /#3<-#1,#2/);
    assert.doesNotMatch(lines.join('\n'), /[├└]─ #(?:1|2)\b/);
    for (const budget of [2, 3]) {
      const tiny = renderWidget(workflow, 20, budget, { msg });
      assert.ok(tiny.length <= budget);
      assert.ok(tiny.every((line) => visibleWidth(line) <= 20));
      assert.ok(/#3<-#1,#2|截断|shortened/.test(tiny.join('\n')), tiny.join('\n'));
      if (!tiny.join('\n').includes('#3<-#1,#2')) assert.doesNotMatch(tiny.join('\n'), /完整前驱|keep all predecessors/);
    }
    assert.match(renderDag(workflow, 20, undefined, undefined, [], { msg }).join('\n'), /#3<-#1,#2/);
    assert.deepEqual(workflow, before, 'fallbacks do not alter the complete detail state');
  }
});

test('long fallback references stay budgeted, themed and honest alongside live activity', (t) => {
  const now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const parents = Array.from({ length: 14 }, (_, index) => ({ ...task(index + 1, 'completed'), blockedBy: [] }));
  const child = { ...task(15), blockedBy: parents.map((todo) => todo.id) };
  const reference = '#15<-' + child.blockedBy.map((id) => `#${id}`).join(',');
  const live: AgentView = { id: 'live', todoId: 15, profile: 'fixture', status: 'running', activity: { kind: 'tool', tool: 'mcp__fixture__very_long_tool_name', since: now - 105000 } };
  const question: AgentView = { id: 'question', profile: 'fixture', status: 'waiting' };
  let color = 31;
  const theme: any = { fg: (_name: string, value: string) => `\x1b[${color}m${value}\x1b[39m` };
  for (const locale of ['en', 'zh-CN'] as const) for (const treeStyle of ['paths', 'flat'] as const) for (const width of [20, 40, 100]) for (const budget of [2, 3, 6, 8, 12]) {
    const workflow: WorkflowState = { ...state(15), view: 'dag', filter: 'pending', treeStyle, tasks: [...parents, child] };
    const options = { jobs: [live, question], msg: createTranslator(locale), theme };
    color = 31;
    const first = renderWidget(workflow, width, budget, options);
    color = 32;
    const next = renderWidget(workflow, width, budget, options);
    assert.ok(next.length <= budget);
    assert.ok(next.every((line) => visibleWidth(line) <= width));
    assert.deepEqual(first.map(stripTerminalSequences), next.map(stripTerminalSequences));
    assert.match(next.join('\n'), /\x1b\[32m/);
    assert.doesNotMatch(next.join('\n'), /\x1b\[31m|\x1b\[2J/);
    const plain = next.map(stripTerminalSequences);
    if (plain.some((line) => /[├└]─ #15/.test(line))) assert.ok(plain.join('').includes(reference) || /截断|shortened/.test(plain.join('\n')), plain.join('\n'));
    if (width === 100 && budget >= 8) {
      assert.match(plain.join('\n'), /question/);
      assert.match(plain.join('\n'), /󰆍 very_long…/);
      assert.doesNotMatch(plain.join('\n'), /very_long_tool_name/);
    }
    assert.ok(renderDag(workflow, 20, undefined, undefined, [], { msg: options.msg }).map(stripTerminalSequences).join('').includes(reference), 'complete DAG detail keeps every prerequisite');
  }
});

test('hiding Todo rows does not hide a standalone handoff in a tiny widget', () => {
  for (const view of ['list', 'dag'] as const) for (const status of ['waiting', 'running', 'completed'] as const) {
    const workflow = { ...state(20), view, plan: true, tasks: state(20).tasks.map((todo) => todo.id === 1 ? { ...todo, status: 'failed' as const } : todo) };
    const standalone: AgentView = { id: 'handoff', profile: 'fixture', status, reportDelivery: 'pending' };
    for (const budget of [2, 3, 4, 6]) {
      const lines = renderWidget(workflow, 100, budget, { maxRows: 0, jobs: [standalone] });
      assert.ok(lines.length <= budget);
      assert.match(lines.join('\n'), /handoff/);
      assert.doesNotMatch(lines.join('\n'), /task-\d+/);
    }
  }
});

test('widget colors and filters use the current theme without changing the overall budget', () => {
  const workflow = { ...state(30), tasks: state(30).tasks.map((todo) => todo.id === 1 ? { ...todo, status: 'failed' as const } : todo) };
  let color = 31;
  const theme: any = { fg: (_name: string, value: string) => `\x1b[${color}m${value}\x1b[39m` };
  const first = renderWidget(workflow, 100, 6, { theme, filter: 'failed' });
  assert.match(first.join('\n'), /task-1 /); assert.doesNotMatch(first.join('\n'), /task-30 /);
  color = 32;
  const next = renderWidget(workflow, 100, 6, { theme, filter: 'failed' });
  assert.match(next.join('\n'), /\x1b\[32m/); assert.doesNotMatch(next.join('\n'), /\x1b\[31m/);
  assert.deepEqual(first.map(stripTerminalSequences), next.map(stripTerminalSequences));
});
