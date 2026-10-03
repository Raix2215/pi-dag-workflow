import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import todos from '../src/todos/index.ts';
import plan from '../src/plan/index.ts';
import agents from '../src/agents/index.ts';
import goal from '../src/goal/index.ts';
import ui from '../src/ui/index.ts';
import { FEATURE_NAMES } from '../src/workflow/features.ts';

test('manifest exposes five independently selectable Pi resources and release metadata', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(manifest.pi.extensions, FEATURE_NAMES.map((name) => `./src/${name}/index.ts`));
  assert.notEqual(manifest.private, true, 'package must be publishable');
  // The version carries a dated changelog heading, so a release always documents itself.
  assert.match(changelog, new RegExp(`^## \\[${manifest.version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.dependencies, undefined);
  for (const entry of ['src', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'docs']) assert.ok(manifest.files.includes(entry), `files must include ${entry}`);
  assert.ok(manifest.keywords.includes('pi-package'));
});
test('each public resource exports a factory, without an aggregate root entry', () => {
  for (const factory of [todos, plan, agents, goal, ui]) assert.equal(typeof factory, 'function');
});
