import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentJournal, AGENTS_ENTRY_TYPE, foldAgentData, foldAgentEntries } from '../src/agents/persistence.ts';
import type { JobResult } from '../src/agents/runtime.ts';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const model = { provider: 'dag-test', id: 'scripted' };
const record = (id: string, output: string, extra: Partial<JobResult> = {}): JobResult => ({
  id, profile: 'inherit', model, thinking: 'off', tools: ['read'], status: 'completed',
  startedAt: 1, endedAt: 2, pendingRequests: 0, output, requests: [],
  usage: { requests: 1, input: 0, output: output.length, estimatedCost: 0 }, reportVersion: 1, ...extra,
});
/** Metadata without the output field, as a version-2 delta carries it. */
const meta = (job: JobResult): Omit<JobResult, 'output'> => { const { output: _output, ...rest } = job; return rest; };

test('folding applies version-1 snapshots and version-2 deltas in order', () => {
  const a1 = record('a1', 'alpha');
  const a2 = record('a2', 'beta');
  const snapshot = { version: 1, jobs: [a1, a2], nextId: 5 };
  const append = { version: 2, jobs: [{ ...meta(a1), outputAppend: '!', offset: 5 }], removed: ['a2'], nextId: 6 };
  const folded = foldAgentData([snapshot, append]);
  assert.deepEqual(folded.records.map((job) => job.id), ['a1']);
  assert.equal(folded.records[0]!.output, 'alpha!');
  assert.equal(folded.nextId, 6);
});

test('the newest full snapshot supersedes prior corruption and accepts summary-only records', () => {
  const { output: _output, requests: _requests, ...summary } = record('a8', 'ignored');
  const folded = foldAgentData([
    { version: 99, jobs: [] },
    { version: 1, jobs: [summary] },
  ]);
  assert.equal(folded.records[0]!.output, '');
  assert.deepEqual(folded.records[0]!.requests, []);
  assert.equal(folded.nextId, undefined);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [summary] }, { version: 99 }]), /Unsupported/);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [summary, summary] }]), /corrupt/);
});

test('metadata deltas replace optional fields instead of preserving obsolete error flags', () => {
  const before = record('a1', 'evidence', { error: 'old diagnostic', taskReportStale: true });
  const after = record('a1', 'evidence');
  const journal = new AgentJournal(); journal.hydrate([before], 2);
  const payload = journal.prepare([after], 2)!;
  const restored = foldAgentData([{ version: 1, jobs: [before], nextId: 2 }, payload]);
  assert.equal(restored.records[0]!.error, undefined);
  assert.equal(restored.records[0]!.taskReportStale, undefined);
  assert.equal(restored.records[0]!.output, 'evidence');
});

test('delta replay never lowers the ID high-water mark after pruning', () => {
  assert.throws(() => foldAgentData([{ version: 1, jobs: [], nextId: 20 }, { version: 2, jobs: [], nextId: 2 }]), /nextId decreased/);
});

test('a metadata-only delta keeps the previously persisted output', () => {
  const a1 = record('a1', 'alpha');
  const folded = foldAgentData([
    { version: 1, jobs: [a1], nextId: 2 },
    { version: 2, jobs: [{ ...meta(a1), status: 'failed', error: 'boom' }], nextId: 2 },
  ]);
  assert.equal(folded.records[0]!.output, 'alpha');
  assert.equal(folded.records[0]!.status, 'failed');
  assert.equal(folded.records[0]!.error, 'boom');
});

test('folding a brand-new job delta keeps its id and output', () => {
  const folded = foldAgentData([{ version: 2, jobs: [record('a7', 'fresh')], nextId: 8 }]);
  assert.equal(folded.records.length, 1);
  assert.equal(folded.records[0]!.id, 'a7');
  assert.equal(folded.records[0]!.output, 'fresh');
  assert.equal(folded.nextId, 8);
});

test('prepare writes only changed jobs and only the appended output tail', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'alpha');
  const a2 = record('a2', 'beta');
  journal.hydrate([a1, a2], 3);
  assert.equal(journal.prepare([a1, a2], 3), null, 'unchanged records write nothing');

  const grown = { ...a1, output: 'alpha-more' };
  const payload = journal.prepare([grown, a2], 3)!;
  assert.equal(payload.version, 2);
  assert.equal(payload.jobs!.length, 1);
  assert.equal(payload.jobs![0]!.id, 'a1');
  assert.equal(payload.jobs![0]!.output, undefined);
  assert.equal(payload.jobs![0]!.outputAppend, '-more');
  assert.equal(payload.jobs![0]!.offset, 5);
  journal.confirm();
  assert.equal(journal.prepare([grown, a2], 3), null, 'a confirmed append is not repeated');

  // A nextId-only change still persists the high-water mark with no job payload.
  const bumped = journal.prepare([grown, a2], 4)!;
  assert.deepEqual(bumped.jobs, []);
  assert.equal(bumped.nextId, 4);
  journal.confirm();
  assert.equal(journal.nextId, 4);
});

test('Unicode output tails use exact string offsets and preserve every character', () => {
  const before = record('a1', '𝄞中文\n');
  const after = { ...before, output: `${before.output}résumé\u0000` };
  const journal = new AgentJournal(); journal.hydrate([before], 2);
  const payload = journal.prepare([after], 2)!;
  assert.equal(payload.jobs![0]!.offset, before.output.length);
  assert.equal(foldAgentData([{ version: 1, jobs: [before], nextId: 2 }, payload]).records[0]!.output, after.output);
});

test('non-append replacement writes the full output instead of a broken tail', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'alpha');
  journal.hydrate([a1], 2);
  const replaced = journal.prepare([{ ...a1, output: 'OMEGA' }], 2)!;
  assert.equal(replaced.jobs![0]!.output, 'OMEGA');
  assert.equal(replaced.jobs![0]!.outputAppend, undefined);
  assert.equal(replaced.jobs![0]!.offset, undefined);
});

test('a failed append never swallows the diff or later updates', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'one');
  journal.hydrate([a1], 2);
  assert.ok(journal.prepare([{ ...a1, output: 'one-two' }], 2));
  // Simulate an append that threw: no confirm, so the same diff must be offered again.
  assert.ok(journal.prepare([{ ...a1, output: 'one-two' }], 2));
  const merged = journal.prepare([{ ...a1, output: 'one-two-three' }], 2)!;
  assert.equal(merged.jobs![0]!.offset, 3);
  assert.equal(merged.jobs![0]!.outputAppend, '-two-three');
  journal.confirm();
  assert.equal(journal.prepare([{ ...a1, output: 'one-two-three' }], 2), null);
});

test('corrupt, unknown and offset-mismatched journals throw instead of dropping data', () => {
  assert.throws(() => foldAgentData([{ version: 9, jobs: [] }]), /Unsupported agent journal version/);
  assert.throws(() => foldAgentData([{ version: 1 }]), /corrupt/);
  const a1 = record('a1', 'alpha');
  assert.throws(() => foldAgentData([{ version: 2, jobs: [{ ...meta(a1), offset: 4, outputAppend: 'x' }] }]), /no base record/);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [a1] }, { version: 2, jobs: [{ ...meta(a1), offset: 4, outputAppend: 'x' }] }]), /offset mismatch/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [{ ...meta(a1), offset: 5 }] }]), /offset/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [{ ...meta(a1), outputAppend: 'x' }] }]), /offset/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [meta(record('a9', ''))] }]), /missing its initial output/);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [], nextId: 0 }]), /nextId/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [], removed: [7] }]), /corrupt/);
});

test('foldAgentEntries reads the whole branch and ignores foreign entries', () => {
  const a1 = record('a1', 'alpha');
  const folded = foldAgentEntries([
    { type: 'custom', customType: 'pi-dag-workflow.state', data: { version: 1, tasks: [] } },
    { type: 'custom_message', customType: AGENTS_ENTRY_TYPE, content: 'a model message is not authoritative agent state' },
    { type: 'custom', customType: AGENTS_ENTRY_TYPE, data: { version: 1, jobs: [a1], nextId: 2 } },
    { type: 'custom', customType: AGENTS_ENTRY_TYPE, data: { version: 2, jobs: [{ ...meta(a1), outputAppend: '!', offset: 5 }], nextId: 3 } },
  ]);
  assert.equal(folded.records.length, 1);
  assert.equal(folded.records[0]!.output, 'alpha!');
  assert.equal(folded.nextId, 3);
});

test('pruning records never resurrects ids and keeps the high-water nextId', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'one');
  const a2 = record('a2', 'two');
  const a3 = record('a3', 'three');
  journal.hydrate([a1, a2, a3], 20);
  const payloads: unknown[] = [{ version: 1, jobs: [a1, a2, a3], nextId: 20 }];
  const prune = journal.prepare([a3], 20)!;
  assert.deepEqual(prune.jobs, []);
  assert.deepEqual(prune.removed, ['a1', 'a2']);
  payloads.push(prune);
  journal.confirm();
  const folded = foldAgentData(payloads);
  assert.deepEqual(folded.records.map((job) => job.id), ['a3']);
  assert.equal(folded.nextId, 20);
  assert.equal(journal.prepare([a3], 20), null, 'a pruned record never returns');
});

test('real Pi: restore normalization is persisted on the next change and reset supersedes corruption', { timeout: 30000 }, async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/history-records.ts', import.meta.url));
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'journal-normalization', [fixture, controls], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await client.prompt('/test-history-records [{"id":"a1","status":"running"}]');
  await client.prompt('/test-reload');
  await client.prompt('TEST CALL subagent_spawn {"task":"HOLD-IDLE-ENABLE-CHILD"}');
  const restored = foldAgentEntries(await client.entries());
  assert.equal(restored.records.find((job) => job.id === 'a1')!.status, 'interrupted');
  assert.equal(restored.records.find((job) => job.id === 'a1')!.output, 'generic retained report');
  assert.equal(restored.records.find((job) => job.id === 'a20')!.status, 'running');
  await client.prompt('/test-history-corrupt'); await client.prompt('/test-reload');
  const offset = client.records.length;
  const resetting = client.prompt('/agents reset');
  await client.until(() => client.records.slice(offset).some((event) => event.method === 'confirm'));
  const question = client.records.slice(offset).find((event) => event.method === 'confirm')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: question.id, confirmed: true })}\n`);
  await resetting;
  assert.deepEqual(foldAgentEntries(await client.entries()).records, []);
  const inspected = await client.prompt('TEST CALL subagent_inspect {}');
  assert.equal(inspected.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent_inspect')!.isError, false);
});

test('byte benchmark: append-only deltas replace full-snapshot rewrites', () => {
  // Steady state: 128 jobs of 64 KiB. One small append must not rewrite ~8.4 MB.
  const jobs = Array.from({ length: 128 }, (_, index) => record(`a${index + 1}`, 'x'.repeat(64 * 1024)));
  const snapshot = { version: 1, jobs, nextId: 129 };
  const fullBytes = JSON.stringify(snapshot).length;
  const journal = new AgentJournal();
  journal.hydrate(jobs, 129);
  const grown = jobs.map((job, index) => index === 0 ? { ...job, output: `${job.output}\nupdate` } : job);
  const payload = journal.prepare(grown, 129)!;
  const deltaBytes = JSON.stringify(payload).length;
  assert.ok(fullBytes > 8_000_000, `full snapshot was only ${fullBytes} bytes`);
  assert.ok(deltaBytes < 50_000, `delta was ${deltaBytes} bytes`);
  assert.ok(fullBytes / deltaBytes > 200, `expected >200x, got ${fullBytes}/${deltaBytes}`);
  journal.confirm();
  const folded = foldAgentData([snapshot, payload]);
  assert.equal(folded.records.length, 128);
  assert.equal(folded.records[0]!.output, `${'x'.repeat(64 * 1024)}\nupdate`);
  assert.equal(folded.records[127]!.output, 'x'.repeat(64 * 1024));

  // Growing children: six 4 KiB jobs with 30 updates should not repeat whole snapshots.
  const journal2 = new AgentJournal();
  const base = Array.from({ length: 6 }, (_, index) => record(`b${index + 1}`, 'y'.repeat(4 * 1024), { status: 'running' }));
  journal2.hydrate(base, 7);
  const captured: unknown[] = [{ version: 1, jobs: base, nextId: 7 }];
  let current = base;
  let fullTotal = 0;
  let deltaTotal = 0;
  for (let round = 0; round < 30; round++) {
    const changed = round % 6;
    current = current.map((job, index) => index === changed ? { ...job, output: `${job.output}#${round}\n` } : job);
    fullTotal += JSON.stringify({ version: 1, jobs: current, nextId: 7 }).length;
    const step = journal2.prepare(current, 7);
    assert.ok(step, `round ${round}`);
    deltaTotal += JSON.stringify(step).length;
    captured.push(step);
    journal2.confirm();
  }
  assert.ok(fullTotal > deltaTotal * 8, `expected >8x, got ${fullTotal}/${deltaTotal}`);
  const restored = foldAgentData(captured);
  assert.equal(restored.records.length, 6);
  for (const [index, job] of current.entries()) assert.equal(restored.records[index]!.output, job.output);
});
