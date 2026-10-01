import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPaths, loadConfig } from '../src/shared/config.ts';

test('config and Profile share the requested Pi user directory; missing config has no filesystem side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-config-')); const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const paths = configPaths();
    assert.equal(paths.config, join(dir, 'pi-dag-workflow', 'pi-dag-workflow-config.json'));
    assert.equal(paths.profile, join(dir, 'pi-dag-workflow', 'pi-dag-workflow-profile.json'));
    assert.deepEqual(await loadConfig(), { language: 'auto', goalMaxTurns: 32, goalNoProgressLimit: 3, goalErrorRetries: 5, planTools: [] });
    assert.deepEqual(await readdir(dir), []);
    await mkdir(paths.directory);
    await writeFile(paths.config, JSON.stringify({ goalMaxTurns: 2, goalNoProgressLimit: 1, goalErrorRetries: 0, planTools: ['web_search', 'fetch_content'] }));
    assert.deepEqual(await loadConfig(), { language: 'auto', goalMaxTurns: 2, goalNoProgressLimit: 1, goalErrorRetries: 0, planTools: ['web_search', 'fetch_content'] });
    for (const value of [{ language: 'fr' }, { language: null }, { goalMaxTurns: 0 }, { goalMaxTurns: 201 }, { goalNoProgressLimit: 1.5 }, { goalErrorRetries: -1 }, { goalErrorRetries: 21 }, { goalErrorRetries: 1.5 }, { planTools: 'web_search' }, { planTools: [1] }, { planTools: ['bad name'] }, { planTools: ['a', 'a'] }, { planTools: Array.from({ length: 17 }, (_, index) => `t${index}`) }, { unknown: true }, { modules: ['unknown'] }, { modules: null }, [], null]) {
      await writeFile(paths.config, JSON.stringify(value)); await assert.rejects(loadConfig());
    }
  } finally { previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});
