import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passiveMessage } from '../src/shared/passive-message.ts';

function host() {
  const entries: any[] = [];
  let text: string | undefined = 'current requirements';
  let idle = true;
  let saved = 0;
  const ctx: any = { sessionManager: { getBranch: () => entries }, isIdle: () => idle };
  const state = passiveMessage('test.passive', () => text, undefined, () => saved++);
  const persist = (message: any) => entries.push({ type: 'custom_message', ...message });
  return { state, ctx, entries, persist, text(value: string | undefined) { text = value; }, idle(value: boolean) { idle = value; }, saved: () => saved };
}

test('rejected drafts can be reproposed with one id; only persistence clears pending', () => {
  const h = host(); h.state.mark();
  const event = {};
  const first = h.state.take(h.ctx, event)!;
  assert.ok(first);
  assert.equal(h.state.take(h.ctx, event), undefined, 'shared module handlers do not duplicate one dispatch');
  const retry = h.state.take(h.ctx, {})!;
  assert.equal(retry.details.checkpointId, first.details.checkpointId);
  assert.equal(h.saved(), 0, 'proposing is not delivery or saving');
  h.persist(retry);
  assert.equal(h.state.take(h.ctx, {}), undefined);
  assert.equal(h.saved(), 1);
  h.text('ordinary progress is not a definition change');
  assert.equal(h.state.take(h.ctx, {}), undefined, 'no mark means no per-turn churn');
});

test('a late saved old proposal does not suppress a new definition', () => {
  const h = host(); h.state.mark();
  const old = h.state.take(h.ctx, {})!;
  h.text('new original requirements'); h.state.mark(); h.persist(old);
  const current = h.state.take(h.ctx, {})!;
  assert.equal(current.content, 'new original requirements');
  assert.notEqual(current.details.checkpointId, old.details.checkpointId);
  assert.equal(h.saved(), 0);
  h.persist(current);
  assert.equal(h.state.take(h.ctx, {}), undefined);
  assert.equal(h.saved(), 1);
});

test('successful compaction adds only one request-local message and does not consume persistence', () => {
  const h = host(); h.state.mark();
  h.persist(h.state.take(h.ctx, {})!);
  h.state.take(h.ctx, {});
  h.state.mark(true);
  const summary = { role: 'compactionSummary', summary: 'memory-owned summary' };
  const prefix = [summary];
  const recovery = h.state.recover(prefix, h.ctx, {})!;
  assert.equal(recovery.role, 'custom');
  assert.equal(recovery.display, false);
  assert.deepEqual(prefix, [summary]);
  assert.equal(h.state.recover(prefix, h.ctx, {}), undefined, 'not inserted on ordinary contexts');
  const boundary = h.state.take(h.ctx, {})!;
  assert.equal(boundary.details.checkpointId, recovery.details.checkpointId);
  h.persist(boundary);
  assert.equal(h.state.take(h.ctx, {}), undefined);
});

test('persistence after request-local recovery takes the current state, not a queued stale snapshot', () => {
  const h = host(); h.state.mark(true);
  const active = h.state.recover([], h.ctx, {})!;
  h.text('paused: user stop'); h.state.mark();
  const boundary = h.state.take(h.ctx, {})!;
  assert.equal(boundary.content, 'paused: user stop');
  assert.notEqual(boundary.details.checkpointId, active.details.checkpointId);
});

test('restores and shutdown abandon old proposals; passive busy wakes do not queue them', () => {
  const h = host(); h.state.mark();
  const first = h.state.take(h.ctx, {})!;
  h.state.reset();
  assert.equal(h.state.take(h.ctx, {}), undefined);
  h.state.reset(true); h.text('new branch');
  const next = h.state.take(h.ctx, {})!;
  assert.notEqual(next.details.checkpointId, first.details.checkpointId);
  const sent: any[] = [];
  h.idle(false); h.state.beforeWake(h.ctx, (message) => sent.push(message));
  assert.equal(sent.length, 0);
  h.idle(true); h.state.beforeWake(h.ctx, (message) => sent.push(message));
  assert.equal(sent.length, 1);
  h.persist(sent[0]);
  h.state.beforeWake(h.ctx, (message) => sent.push(message));
  assert.equal(sent.length, 1);
});

test('an already visible recovery checkpoint is not duplicated in the request', () => {
  const h = host(); h.state.mark(true);
  const message = h.state.take(h.ctx, {})!;
  assert.equal(h.state.recover([{ role: 'custom', ...message }], h.ctx, {}), undefined);
  assert.equal(h.state.take(h.ctx, {})?.details.checkpointId, message.details.checkpointId, 'still needs normal persistence');
});
