import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { emptyState } from '../src/todos/state.ts';
import { renderTasks, renderDag, type AgentView } from '../src/ui/render.ts';
import { createTranslator } from '../src/shared/i18n.ts';

const state = { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Implementation', status: 'in_progress' as const, blockedBy: [] }] };
const job: AgentView = { id: 'a1', todoId: 1, profile: 'worker', status: 'completed', reportDelivery: 'pending' };

test('a finished child is pending delivery until the report handoff, in both locales and views', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const msg = createTranslator(locale);
    const pending = locale === 'en' ? 'Pending delivery' : '待交付';
    const returned = locale === 'en' ? 'Returned' : '已返回';
    for (const width of [80, 120]) {
      const list = renderTasks(state, width, { jobs: [job], msg });
      assert.ok(list.join('\n').includes(pending));
      assert.ok(!list.join('\n').includes(returned));
      for (const line of list) assert.ok(visibleWidth(line) <= width);
      const accepted = renderTasks(state, width, { jobs: [{ ...job, reportDelivery: 'delivered' }], msg });
      assert.ok(accepted.join('\n').includes(returned));
      assert.ok(!accepted.join('\n').includes(pending));
    }
    const graph = renderDag(state, 120, undefined, undefined, [job], { msg });
    assert.ok(graph.join('\n').includes(pending));
    assert.equal(state.tasks[0]!.status, 'in_progress', 'report delivery never completes the Todo');
  }
});

test('pending delivery remains width-safe and does not override running, waiting or failure states', () => {
  for (const width of [20, 40, 80, 120]) {
    for (const line of renderTasks(state, width, { jobs: [job], msg: createTranslator('en') })) assert.ok(visibleWidth(line) <= width);
  }
  for (const status of ['running', 'waiting', 'failed'] as const) {
    const output = renderTasks(state, 120, { jobs: [{ ...job, status }], msg: createTranslator('en') }).join('\n');
    assert.ok(!output.includes('Pending delivery'));
  }
  const legacy = { ...job }; delete legacy.reportDelivery;
  assert.match(renderTasks(state, 120, { jobs: [legacy] }).join('\n'), /已返回/, 'legacy records retain their previous display');
});
