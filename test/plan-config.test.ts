import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const webTool = fileURLToPath(new URL('./fixtures/web-search-tool.ts', import.meta.url));
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));

/** Write the plugin config into the isolated agent directory before Pi starts. */
async function home(planTools?: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-plan-config-'));
  if (planTools) {
    const directory = join(root, 'agent', 'pi-dag-workflow');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'pi-dag-workflow-config.json'), `${JSON.stringify({ planTools }, null, 2)}\n`);
  }
  return root;
}

const result = (events: Record<string, unknown>[]) => {
  const event = events.findLast((item) => item.type === 'tool_execution_end' && item.toolName === 'web_search')!;
  const payload = event.result as { isError?: boolean; content: { type: string; text?: string }[] };
  return { isError: event.isError === true || payload.isError === true, text: payload.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n') };
};

test('actual Pi: a config-listed read-only network tool runs in Plan mode, an unlisted one stays blocked', { timeout: 30000 }, async (t) => {
  const blockedRoot = await home();
  const blocked = await IsolatedClient.start(blockedRoot, 'plan-config-off', [controls, webTool]);
  t.after(() => blocked.close());
  await blocked.prompt('begin');
  await blocked.prompt('/plan start');
  const denied = result(await blocked.prompt('TEST CALL web_search {"query":"parser design"}'));
  assert.equal(denied.isError, true, 'without configuration the web tool is blocked in Plan mode');
  assert.match(denied.text, /Plan/);

  const allowedRoot = await home(['web_search', 'fetch_content']);
  const allowed = await IsolatedClient.start(allowedRoot, 'plan-config-on', [controls, webTool]);
  t.after(() => allowed.close());
  await allowed.prompt('begin');
  await allowed.prompt('/plan start');
  const permitted = result(await allowed.prompt('TEST CALL web_search {"query":"parser design"}'));
  assert.equal(permitted.isError, false, 'a configured tool is allowed');
  assert.equal(permitted.text, 'offline result for: parser design');

  // Hard guards still win: a configured name cannot unlock writes or dispatch.
  const write = (await allowed.prompt('TEST CALL write {"path":"nope.txt","content":"x"}')).findLast((item) => item.type === 'tool_execution_end' && item.toolName === 'write')!;
  assert.equal(write.isError, true, 'write stays blocked in Plan mode');
});
