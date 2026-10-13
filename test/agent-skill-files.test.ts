import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_SKILLS_ENV, skillFiles, takeSkillFiles } from '../src/agents/skills.ts';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

async function files() {
  const root = await mkdtemp(join(tmpdir(), 'dag-skill-files-'));
  await mkdir(join(root, 'selected'));
  await writeFile(join(root, 'selected', 'SKILL.md'), '# Local skill\nRead only the assigned inputs.\n');
  await writeFile(join(root, 'empty.md'), '');
  await writeFile(join(root, 'large.md'), 'x'.repeat(65537));
  await writeFile(join(root, 'not-markdown.txt'), 'not a skill');
  return root;
}

test('explicit local files resolve from cwd; duplicate symlinks do not duplicate entries', async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, 'selected', 'SKILL.md');
  assert.deepEqual(await skillFiles(['selected/SKILL.md', expected], root, ['read']), [expected]);
  if (process.platform !== 'win32') {
    await symlink(expected, join(root, 'alias.md'));
    assert.deepEqual(await skillFiles(['alias.md', expected], root, ['read']), [expected]);
  }
  if (process.platform !== 'win32') {
    await symlink(join(root, 'not-markdown.txt'), join(root, 'fake.md'));
    await assert.rejects(skillFiles(['fake.md'], root, ['read']));
  }
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previousHome = process.env[homeKey];
  try { process.env[homeKey] = root; assert.deepEqual(await skillFiles(['~/selected/SKILL.md'], root, ['read']), [expected]); }
  finally { if (previousHome === undefined) delete process.env[homeKey]; else process.env[homeKey] = previousHome; }
  assert.deepEqual(await skillFiles([], root, []), []);
  assert.deepEqual(await skillFiles(undefined, root, []), []);
});

test('bad file entries and missing read permission fail without reading bodies or scanning folders', async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['missing.md', 'selected', 'empty.md', 'large.md', 'not-markdown.txt', 'https://example.org/SKILL.md']) await assert.rejects(skillFiles([path], root, ['read']));
  await assert.rejects(skillFiles(['selected/SKILL.md'], root, ['bash']), /read tool/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(skillFiles(['selected/SKILL.md'], root, ['read'], cancelled.signal), /aborted/);
  const hidden = join(root, 'missing.md');
  try { await skillFiles([hidden], root, ['read']); assert.fail(); } catch (error) { assert.doesNotMatch(String(error), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); }
});

test('the child consumes only the selected JSON paths and removes them from its environment', () => {
  const env = { [CHILD_SKILLS_ENV]: JSON.stringify(['one.md', 'two.md']) };
  assert.deepEqual(takeSkillFiles(env), ['one.md', 'two.md']); assert.equal(CHILD_SKILLS_ENV in env, false);
  assert.deepEqual(takeSkillFiles({}), []);
  for (const value of ['not-json', '{}', 'null', '[1]', '["bad\\npath"]', 'x'.repeat(20001)]) assert.throws(() => takeSkillFiles({ [CHILD_SKILLS_ENV]: value }));
});

test('a real child does not inherit unselected guidance or bootstrap environment fields', { timeout: 15000 }, async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'child.jsonl');
  const profiles = new ProfileStore({ registry: { find: () => ({ reasoning: false }) } });
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => ({ provider: 'dag-test', id: 'scripted' }), testExtensions: [offline], ...(process.env.PI_DAG_TEST_CLI ? { testCliPath: process.env.PI_DAG_TEST_CLI } : {}), childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_DAG_TEST_CHILD_CONTEXT_LOG: log, PI_DAG_AGENT_PROFILE_PROMPT: 'UNSELECTED-PROFILE', PI_DAG_AGENT_CONTEXT: 'UNSELECTED-BRIEF', PI_DAG_AGENT_MODEL_BOOTSTRAP: 'unselected-invalid-bootstrap', [CHILD_SKILLS_ENV]: JSON.stringify(['UNSELECTED-SKILL.md']) } });
  t.after(() => runtime.shutdown());
  const child = await runtime.spawn({ task: 'Plain child probe' });
  const result = await runtime.wait(child.id, { until: 'finish', timeout: 8 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.doesNotMatch(await readFile(log, 'utf8'), /UNSELECTED-PROFILE|UNSELECTED-BRIEF|UNSELECTED-SKILL|unselected-invalid-bootstrap/);
});

test('resumed work selects current Profile skills with an explicit read-only tool override', { timeout: 20000 }, async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  const model = { provider: 'dag-test', id: 'scripted' }; const profiles = new ProfileStore({ registry: { find: () => ({ reasoning: false }) }, trustedTools: ['write'] });
  profiles.set({ name: 'reader', tools: ['read'], skills: ['selected/SKILL.md'] });
  profiles.set({ name: 'other', tools: ['read', 'write'], skills: ['other.md'] });
  await writeFile(join(root, 'other.md'), '# CURRENT-RESUME-SKILL\n');
  const log = join(root, 'child.jsonl'); const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, testExtensions: [offline], ...(process.env.PI_DAG_TEST_CLI ? { testCliPath: process.env.PI_DAG_TEST_CLI } : {}), childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_DAG_TEST_CHILD_CONTEXT_LOG: log } });
  t.after(() => runtime.shutdown());
  const first = await runtime.spawn({ task: 'First skill probe', profile: 'reader', todoId: 1 });
  assert.equal((await runtime.wait(first.id, { until: 'finish', timeout: 8 })).status, 'completed');
  const resumed = await runtime.spawn({ task: 'TEST SELECTED SKILL', profile: 'other', tools: ['read'], resumeFrom: first.id, todoId: 1 });
  const result = await runtime.wait(resumed.id, { until: 'finish', timeout: 8 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.tools, ['read']); assert.match(result.output, /CURRENT-RESUME-SKILL/);
  const records = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const current = records.find((entry) => entry.type === 'input' && JSON.stringify(entry.context).includes('Resume attempt from'));
  assert.ok(JSON.stringify(current.context).includes(join(root, 'other.md')));
  assert.doesNotMatch(JSON.stringify(current.context), /selected\/SKILL\.md/);
});

test('a rejected skill cannot fork a process, claim a Todo or leave an occupied slot', async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = new ProfileStore({ registry: { find: () => ({ reasoning: false }) } });
  profiles.set({ name: 'missing', skills: ['does-not-exist.md'], tools: ['read'] });
  let bootstraps = 0;
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => ({ provider: 'offline', id: 'test' }), getModelBootstrap: async () => { bootstraps++; throw new Error('must not run'); } });
  t.after(() => runtime.shutdown());
  const job = await runtime.spawn({ profile: 'missing', task: 'bounded work', todoId: 1 });
  assert.equal(job.status, 'failed'); assert.equal(runtime.activeCount(), 0); assert.equal(bootstraps, 0);
  assert.match(job.failure!.reason, /Skill entry 1/);
  assert.doesNotMatch(job.failure!.reason, /does-not-exist\.md/);
});
