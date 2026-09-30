import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPaths, loadConfig } from '../src/config.ts';

test('config and Profile share the requested Pi user directory; missing config has no filesystem side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-config-')); const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const paths = configPaths();
    assert.equal(paths.config, join(dir, 'pi-dag-workflow', 'pi-dag-workflow-config.json'));
    assert.equal(paths.profile, join(dir, 'pi-dag-workflow', 'pi-dag-workflow-profile.json'));
    assert.deepEqual(await loadConfig(), { goalMaxTurns: 20, goalNoProgressLimit: 3 });
    assert.deepEqual(await readdir(dir), []);
    await mkdir(paths.directory);
    await writeFile(paths.config, JSON.stringify({ goalMaxTurns: 2, goalNoProgressLimit: 1 }));
    assert.deepEqual(await loadConfig(), { goalMaxTurns: 2, goalNoProgressLimit: 1 });
    for (const value of [{ goalMaxTurns: 0 }, { goalMaxTurns: 201 }, { goalNoProgressLimit: 1.5 }, { unknown: true }, [], null]) {
      await writeFile(paths.config, JSON.stringify(value)); await assert.rejects(loadConfig());
    }
  } finally { previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});
