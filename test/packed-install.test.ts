import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const offlineProvider = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));

/** A distribution has no devDependencies installed; every Pi peer must come from the host. */
test('packed package loads all five resources and spawns a child without a private Pi installation', { timeout: 45000, skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dag-packed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packedJson = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: packageRoot, encoding: 'utf8' }));
  const archive = (Object.values(packedJson)[0] as { filename: string }).filename;
  execFileSync('tar', ['-xzf', join(directory, archive), '-C', directory]);
  const packed = join(directory, 'package');
  await assert.rejects(access(join(packed, 'node_modules')));
  await assert.rejects(access(join(packed, 'test')));
  await access(join(packed, 'LICENSE'));
  await access(join(packed, 'docs', 'COMMUNICATION.md'));

  const client = await IsolatedClient.start(undefined, 'packed-distribution', [], ['--dag-workflow-test-child-provider', offlineProvider], false, [packed]);
  t.after(() => client.close());
  const commands = ((await client.send('get_commands')).data as { commands: { name: string }[] }).commands.map((item) => item.name);
  assert.deepEqual(commands.sort(), ['agents', 'dag', 'goal', 'plan', 'todos']);
  await client.prompt('/todos add distribution task');
  const spawned = await client.prompt('TEST CALL subagent_spawn {"task":"Inspect the distribution","todoId":1}');
  const spawnResult = spawned.find((item) => item.type === 'tool_execution_end' && item.toolName === 'subagent_spawn')!;
  assert.equal(spawnResult.isError, false, JSON.stringify(spawnResult.result));
  const jobId = (spawnResult.result as { details: { jobId: string } }).details.jobId;
  const waited = await client.prompt(`TEST CALL subagent_wait ${JSON.stringify({ jobId, timeout: 10 })}`);
  const result = waited.find((item) => item.type === 'tool_execution_end' && item.toolName === 'subagent_wait')!;
  assert.equal(result.isError, false, JSON.stringify(result.result));
  assert.equal((result.result as { details: { status: string } }).details.status, 'completed');
});
