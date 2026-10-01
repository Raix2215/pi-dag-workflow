import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import todos from '../src/todos/index.ts';
import plan from '../src/plan/index.ts';
import agents from '../src/agents/index.ts';
import goal from '../src/goal/index.ts';
import ui from '../src/ui/index.ts';
import { FEATURE_NAMES } from '../src/workflow/features.ts';

test('manifest exposes five independently selectable Pi resources and no host runtime dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, FEATURE_NAMES.map((name) => `./src/${name}/index.ts`));
  assert.equal(manifest.private, true);
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.dependencies, undefined);
});
test('each public resource exports a factory, without an aggregate root entry', () => {
  for (const factory of [todos, plan, agents, goal, ui]) assert.equal(typeof factory, 'function');
});
