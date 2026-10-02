import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

/**
 * The workflow tools only surface in the model's prompt through Pi's snippet and guideline
 * fields: a tool without `promptSnippet` is missing from the Available tools section, and
 * `promptGuidelines` are the only place our usage rules reach the Guidelines section.
 * This runs a real Pi process and reads the system message Pi persisted for the request.
 */
test('actual Pi: workflow tools are listed with snippets and their usage rules reach the prompt', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await client.prompt('随便聊一句');
  const entries = await client.entries() as any[];
  const system = entries.findLast((entry) => entry.message?.role === 'system' && entry.message.sections?.rules);
  assert.ok(system, 'the session must persist the rendered system prompt sections');
  const { tools, rules, dag_workflow_mode: mode, dag_workflow_agents: agents } = system.message.sections;

  for (const name of ['todo', 'subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_wait', 'subagent_cancel', 'goal']) {
    assert.match(tools, new RegExp(`^- ${name}: \\S`, 'm'), `${name} must appear in the Available tools section`);
  }
  assert.doesNotMatch(tools, /todo: Track optional/);
  for (const rule of ['three or more steps', 'blockedBy (#4 blocked by', 'Delegate work that is independent and verifiable', 'Create a goal only when the user asks']) {
    assert.ok(rules.includes(rule), `the Guidelines section must carry: ${rule}`);
  }

  assert.match(mode, /Plan multi-step work in the one todo list/);
  assert.doesNotMatch(mode, /Todos are optional/);
  assert.match(agents, /single-tier/);
  assert.doesNotMatch(agents, /useful independent work/);
});
