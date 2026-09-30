import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { detailView } from '../src/detail-view.ts';

test('detail panel scrolls with pinned header/footer, clamps resize and handles return', () => {
  let rows = 12; let draws = 0; let closed = false;
  const data = ['HEADER', ...Array.from({ length: 80 }, (_, i) => `row ${i}`)];
  let layouts = 0;
  const panel = detailView(() => { layouts++; return data; }, () => rows, () => draws++, () => { closed = true; });
  let output = panel.render(80);
  assert.equal(output[0], 'HEADER'); assert.equal(output[1], 'row 0'); assert.equal(output.length, 8);
  panel.handleInput!('\x1b[B'); output = panel.render(80); assert.equal(output[1], 'row 1');
  panel.handleInput!('\x1b[6~'); output = panel.render(80); assert.equal(output[1], 'row 7');
  panel.handleInput!('\x1b[F'); output = panel.render(80); assert.equal(output[1], 'row 74');
  rows = 20; output = panel.render(80); assert.equal(output[1], 'row 66');
  panel.handleInput!('\x1b[H'); output = panel.render(80); assert.equal(output[1], 'row 0');
  assert.equal(layouts, 1, 'scrolling/resizing height alone reuses rendered content');
  panel.invalidate(); panel.render(80); assert.equal(layouts, 2);
  for (const line of panel.render(10)) assert.ok(visibleWidth(line) <= 10);
  assert.ok(draws > 0); panel.handleInput!('\x1b'); assert.equal(closed, true);
});
