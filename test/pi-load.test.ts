import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { FEATURE_NAMES } from '../src/workflow/features.ts';

test('Pi actual resource loader loads all five public entries without user settings or model calls', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pi-dag-workflow-load-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const loader = new DefaultResourceLoader({ cwd: temporary, agentDir: join(temporary, 'agent'), settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [root], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 5);
    assert.deepEqual(loaded.extensions.map((item) => item.resolvedPath).sort(), FEATURE_NAMES.map((name) => join(root, `src/${name}/index.ts`)).sort());
    assert.deepEqual(loaded.extensions.flatMap((item) => [...item.tools.keys()]).sort(), ['todo', 'goal', 'subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_wait', 'subagent_cancel'].sort());
    assert.deepEqual(loaded.extensions.flatMap((item) => [...item.commands.keys()]).sort(), ['todos', 'dag', 'plan', 'agents', 'goal'].sort());
    for (const resource of loaded.extensions) for (const tool of resource.tools.values()) {
      assert.equal(tool.definition.namespace?.name, 'pi_dag_workflow');
      assert.ok(tool.definition.namespace?.instructions);
      assert.ok(tool.definition.annotations);
    }
    loaded.runtime.invalidate();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
