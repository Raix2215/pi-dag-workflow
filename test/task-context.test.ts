import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskContext, fragmentContext, contextArtifacts } from '../src/agents/context.ts';
import type { Todo } from '../src/todos/state.ts';

const task = (id: number, status: Todo['status'] = 'completed', blockedBy: number[] = []): Todo => ({ id, subject: `Task ${id}`, status, blockedBy });

test('ordinary context includes only the current task and its direct prerequisites', () => {
  const tasks = [task(1), task(2, 'completed', [1]), { ...task(3, 'pending', [2]), description: 'CURRENT-REQUIREMENTS' }, { ...task(4), subject: 'UNRELATED-PRIVATE' }];
  const before = structuredClone(tasks);
  const brief = taskContext(3, tasks, [{ id: 'a1', todoId: 1, status: 'completed', output: 'TRANSITIVE-PRIVATE' }, { id: 'a2', todoId: 2, status: 'completed', output: 'VERIFIED-DIRECT-RESULT' }])!;
  assert.match(brief, /Task #3.*pending/); assert.match(brief, /CURRENT-REQUIREMENTS/);
  assert.match(brief, /#2 \[completed\].*VERIFIED-DIRECT-RESULT/);
  assert.doesNotMatch(brief, /TRANSITIVE-PRIVATE|UNRELATED-PRIVATE|#1 \[/);
  assert.deepEqual(tasks, before); assert.equal(taskContext(999, tasks, []), undefined);
  assert.equal(taskContext(5, [task(5, 'deleted')], []), undefined);
});

test('ordinary prerequisite ids above the current id still contribute a current report', () => {
  const brief = taskContext(2, [task(2, 'pending', [8]), task(8)], [{ todoId: 8, status: 'completed', output: 'FORWARD-REPORT' }])!;
  assert.match(brief, /#8 \[completed\].*FORWARD-REPORT/);
});

test('a stale or failed newest report never falls back to an earlier successful report', () => {
  for (const latest of [{ status: 'failed' }, { status: 'cancelled' }, { status: 'interrupted' }, { status: 'completed', taskReportStale: true }]) {
    const brief = taskContext(2, [task(1), task(2, 'pending', [1])], [{ todoId: 1, status: 'completed', output: 'OLD-GOOD' }, { todoId: 1, output: 'NEW-UNACCEPTED', ...latest }])!;
    assert.doesNotMatch(brief, /OLD-GOOD|NEW-UNACCEPTED|latest report/);
    assert.match(brief, /#1 \[completed\]/);
  }
});

test('current report excerpts honor outputStart and reject corrupt offsets', () => {
  const history = 'OLD-DIRECTION\n'; const tasks = [task(1), task(2, 'pending', [1])];
  const brief = taskContext(2, tasks, [{ todoId: 1, status: 'completed', output: `${history}CURRENT-REPORT`, outputStart: history.length }])!;
  assert.match(brief, /CURRENT-REPORT/); assert.doesNotMatch(brief, /OLD-DIRECTION/);
  for (const start of [-1, 0.5, 999]) assert.doesNotMatch(taskContext(2, tasks, [{ todoId: 1, status: 'completed', output: 'HIDDEN-REPORT', outputStart: start }])!, /HIDDEN-REPORT/);
});

test('main-owned prerequisites provide explicit references without invented results', () => {
  const first = { ...task(1), description: 'DO-NOT-TREAT-REQUIREMENTS-AS-RESULTS', metadata: { artifacts: ['result.json', 'proof.txt'] } };
  const brief = taskContext(2, [first, task(2, 'pending', [1])], [])!;
  assert.match(brief, /declared artifacts \(unverified\): \["result.json","proof.txt"\]/);
  assert.doesNotMatch(brief, /latest report|DO-NOT-TREAT-REQUIREMENTS-AS-RESULTS/);
  assert.match(brief, /not new permission or proof/);
  assert.deepEqual(contextArtifacts({ ...first, metadata: { artifacts: ['ok.md', 'ok.md', 'bad\npath', 7, 'x'.repeat(513)] } }), ['ok.md']);
});

test('unfinished prerequisite data cannot be presented as accepted output', () => {
  const brief = taskContext(2, [{ ...task(1, 'failed'), metadata: { artifacts: ['UNFINISHED-FILE'] } }, task(2, 'pending', [1])], [{ todoId: 1, status: 'completed', output: 'UNVERIFIED-CLAIM' }])!;
  assert.match(brief, /#1 \[failed\]/); assert.doesNotMatch(brief, /UNFINISHED-FILE|UNVERIFIED-CLAIM/);
});

test('large briefs stay bounded, preserve Unicode and mark omitted input', () => {
  const tasks = Array.from({ length: 60 }, (_, index) => ({ ...task(index + 1), subject: 'long '.repeat(12) }));
  tasks.push({ ...task(61, 'pending', tasks.map((item) => item.id)), description: 'CRITICAL-CURRENT ' + '𐐀'.repeat(2000) });
  const jobs = tasks.slice(0, 60).map((item) => ({ todoId: item.id, status: 'completed', output: 'DIRECT-EVIDENCE ' + '𐐀'.repeat(200) }));
  const brief = taskContext(61, tasks, jobs)!;
  assert.ok(brief.length <= 2000); assert.match(brief, /CRITICAL-CURRENT/); assert.match(brief, /DIRECT-EVIDENCE/); assert.match(brief, /prerequisites omitted/);
  assert.doesNotMatch(brief, /[\uD800-\uDFFF]/u);
});

test('JSON expansion cannot silently delete the current requirements or their truncation notice', () => {
  for (const expansion of ['"', '\\\\', '\u0000']) {
    const current = { ...task(1, 'pending'), subject: 'S'.repeat(120), description: 'MUST KEEP ' + expansion.repeat(900) };
    const brief = taskContext(1, [current], [])!;
    assert.match(brief, /MUST KEEP/); assert.match(brief, /Current requirements excerpt \(truncated/);
    assert.ok(brief.length <= 2000);
    const withDeps = { ...current, blockedBy: [2], metadata: { artifacts: ['path/'.repeat(30) + 'current.json'] } };
    const dependency = { ...task(2), subject: '"'.repeat(80), metadata: { artifacts: ['path/'.repeat(25) + 'result.json'] } };
    const rich = taskContext(1, [withDeps, dependency], [{ todoId: 2, status: 'completed', output: 'DIRECT-PROOF ' + expansion.repeat(200) }])!;
    assert.match(rich, /MUST KEEP/); assert.match(rich, /DIRECT-PROOF/); assert.match(rich, /truncated/); assert.ok(rich.length <= 2000);
  }
});

test('invalid surrogate offsets do not turn a partial character into a current report', () => {
  const tasks = [task(1), task(2, 'pending', [1])];
  assert.doesNotMatch(taskContext(2, tasks, [{ todoId: 1, status: 'completed', output: '𐐀HIDDEN-REPORT', outputStart: 1 }])!, /HIDDEN-REPORT/);
});

test('taskContext preserves the existing fragment path without adding ordinary history', () => {
  const tasks: Todo[] = [{ ...task(1), metadata: { preset: 'flow', run: 1, key: 'first', step: 1 } }, { ...task(2, 'pending', [1]), metadata: { preset: 'flow', run: 1, key: 'last', step: 2 } }];
  const jobs = [{ todoId: 1, status: 'completed', output: 'FRAGMENT-RESULT' }];
  assert.equal(taskContext(2, tasks, jobs), fragmentContext(2, tasks, jobs));
});
