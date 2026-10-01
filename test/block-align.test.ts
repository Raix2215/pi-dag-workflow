import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { emptyState, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { renderTasks } from '../src/ui/render.ts';

/** Rows with mixed depths, references and live job owners, like the user's real panel. */
function scene(): WorkflowState {
  const tasks: Todo[] = Array.from({ length: 35 }, (_, index) => ({ id: index + 1, subject: `旧任务 ${index + 1}`, status: 'completed' as const, blockedBy: [] }));
  tasks.push(
    { id: 36, subject: '验证安装并给出试用入口', status: 'completed', blockedBy: [35] },
    { id: 37, subject: '核对 Pi 资源选择与共享协调机制', status: 'completed', blockedBy: [] },
    { id: 38, subject: '重构为 Pi config 可选扩展入口', status: 'completed', blockedBy: [37] },
    { id: 39, subject: '复验组合加载与真实 Pi config', status: 'completed', blockedBy: [38] },
    { id: 40, subject: '核对命令补全 API 并创建 fast Profile', status: 'completed', blockedBy: [] },
    { id: 41, subject: '实现命令补全', status: 'completed', blockedBy: [40] },
    { id: 42, subject: '复验补全与真实子 Agent 流程', status: 'completed', blockedBy: [43] },
    { id: 43, subject: 'Todo 小组件优先显示当前与最近任务', status: 'completed', blockedBy: [40] },
  );
  return { ...emptyState(), tasks, nextId: 44 };
}
const jobs = [
  { id: 'a1', todoId: 41, profile: 'fast', status: 'completed' as const },
  { id: 'a2', todoId: 43, profile: 'fast', status: 'completed' as const },
];
const iconColumn = (plain: string): number => plain.search(/[✓○◐]/);
const titleColumn = (plain: string): number => {
  const icon = iconColumn(plain);
  if (icon < 0) return -1;
  const after = plain.slice(icon + 1);
  return icon + 1 + (after.length - after.replace(/^ +/, '').length);
};

test('three blocks: tree+id+refs stay glued, icon and title share one unified column', () => {
  const lines = renderTasks(scene(), 120, { maxRows: 8, jobs });
  const body = lines.slice(1, -1);
  assert.ok(body.length >= 8);
  const icons = body.map((line) => iconColumn(line.replace(/\x1b\[[0-9;]*m/g, '')));
  const titles = body.map((line) => titleColumn(line.replace(/\x1b\[[0-9;]*m/g, '')));
  // Block 2: every icon (and its merged title, one space later) starts at the same column.
  for (const value of icons) assert.equal(value, icons[0]);
  for (const value of titles) assert.equal(value, icons[0]! + 1 + 1);
  // Block 1: no padding inside the tree — a row's prefix+ref ends exactly where its lead begins.
  for (const line of body) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /^[│ ]*[├└]─ #[0-9]+(<-#[0-9,]+)? /);
  }
});

test('block 3 stays right-aligned and every row fits the width', () => {
  for (const width of [80, 100, 120, 140]) {
    const lines = renderTasks(scene(), width, { maxRows: 8, jobs });
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    for (const line of lines.slice(1, -1)) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
      // Suffix ends the row: the last character is the closing bracket of the status tag.
      assert.ok(plain.endsWith(']'), plain);
      assert.ok(plain.lastIndexOf('[') > 0);
    }
  }
});

test('narrow width drops block alignment before harming the tree or block 1 text', () => {
  const lines = renderTasks(scene(), 42, { maxRows: 8, jobs });
  for (const line of lines) assert.ok(visibleWidth(line) <= 42, line);
  // Block 1 is still glued: prefix+id+refs contiguous, then the icon.
  for (const line of lines.slice(1, -1)) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /^[│ ]*[├└]─ #[0-9]+(<-#[0-9,]+)? [✓○◐]/);
  }
});

test('flat style keeps the same three-block alignment semantics', () => {
  const lines = renderTasks({ ...scene(), treeStyle: 'flat' }, 120, { maxRows: 8, jobs });
  const body = lines.slice(1, -1);
  const icons = body.map((line) => iconColumn(line.replace(/\x1b\[[0-9;]*m/g, '')));
  for (const value of icons) assert.equal(value, icons[0]);
});
