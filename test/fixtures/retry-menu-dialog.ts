import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** Isolated test: a nested enable followed immediately by another owner's real dialog. */
export default function retryMenuDialog(pi: ExtensionAPI): void {
  pi.registerTool({ name: 'test_goal_dialog', label: 'Synthetic dialog', description: 'Offline Goal dialog probe', parameters: Type.Object({}), async execute(_id, _params, _signal, _update, ctx) {
    await ctx.executeTool('goal', { action: 'enable', id: 1 });
    try { await ctx.ui.input('Foreign dialog'); }
    finally { await ctx.executeTool('goal', { action: 'disable', id: 1 }); }
    return { content: [{ type: 'text', text: 'Synthetic dialog completed' }], details: undefined };
  } });
}
