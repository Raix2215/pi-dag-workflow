import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** A question body must never execute when the Goal bans it, including nested calls. */
export default function questionTools(pi: ExtensionAPI) {
  for (const name of ['ask_user_question', 'test_custom_question']) {
    pi.registerTool({ name, label: name, description: 'Offline question side-effect probe', exposure: name === 'test_custom_question' ? 'codemode' : 'direct', parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        appendFileSync(join(ctx.cwd, 'question-executed.txt'), `${name}\n`);
        return { content: [{ type: 'text', text: 'QUESTION-EXECUTED' }], details: undefined };
      },
    });
  }
  pi.registerTool({ name: 'test_nested_question', label: 'Nested question probe', description: 'Call a question through the public nested-tool API', parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const outcome = await ctx.executeTool('test_custom_question', {}, signal ? { signal } : undefined);
      return { ...outcome.result, isError: outcome.isError };
    },
  });
  pi.registerCommand('test-question-tools', { description: 'Inspect the active tool set without a model request', handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(pi.getActiveTools()), 'info'); } });
}
