import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { STATE_TYPE, emptyState } from '../../src/todos/state.ts';
import { GOAL_TYPE, emptyGoalState } from '../../src/goal/state.ts';
import { PLAN_TYPE } from '../../src/plan/state.ts';
import { AGENTS_ENTRY_TYPE, foldAgentEntries } from '../../src/agents/persistence.ts';

/** Explicit isolated UI fixture; no model traffic, private providers or daily-session access. */
export default function controls(pi: ExtensionAPI): void {
  let requests = 0;
  pi.on('turn_start', () => { requests++; });
  pi.registerProvider('ui-catalog', {
    api: 'dag-test-api', baseUrl: 'http://offline.invalid', apiKey: 'offline-test-only',
    models: Array.from({ length: 120 }, (_, index) => ({ id: `model-${String(index + 1).padStart(3, '0')}`, name: `Catalog model ${index + 1}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 })),
  });
  pi.registerCommand('test-ui-seed', { description: 'Synthetic large directories for isolated UI flow', handler: async (_args, ctx) => {
    if (!ctx.isIdle()) throw new Error('Fixture requires idle');
    const tasks = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, subject: `UI task ${index + 1}`, description: `Full requirement for task ${index + 1}\nSecond line with evidence.`, status: 'pending' as const, blockedBy: [] }));
    pi.appendEntry(STATE_TYPE, { ...emptyState(), tasks, nextId: 41 });
    pi.appendEntry(GOAL_TYPE, { ...emptyGoalState(), nextId: 41, goals: Array.from({ length: 40 }, (_, index) => ({ id: index + 1, title: `UI goal ${index + 1}`, description: `Scope ${index + 1}`, status: 'paused', maxTurns: 4, modelPause: 'allow', createdAt: Date.now() })) });
    pi.appendEntry(AGENTS_ENTRY_TYPE, { version: 1, nextId: 41, jobs: Array.from({ length: 40 }, (_, index) => ({ id: `a${index + 1}`, profile: 'fixture', thinking: 'off', model: { provider: 'ui-catalog', id: 'model-001' }, tools: ['read'], status: 'completed', startedAt: Date.now() - 2000, endedAt: Date.now() - 1000, pendingRequests: 0, label: `UI job ${index + 1}`, reportDelivery: 'delivered', reportVersion: 1, timedOut: false, output: `Verified fixture ${index + 1}\nSecond report line.`, requests: [] })) });
    const dir = join(getAgentDir(), 'pi-dag-workflow'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: Array.from({ length: 40 }, (_, index) => ({ name: `profile-${String(index + 1).padStart(2, '0')}`, tools: ['read'], instructions: `UI profile ${index + 1} instructions` })) }), { mode: 0o600 });
    await writeFile(join(dir, 'pi-dag-workflow-preset.json'), JSON.stringify({ presets: Array.from({ length: 32 }, (_, index) => ({ name: `fragment-${String(index + 1).padStart(2, '0')}`, description: `Fragment ${index + 1}`, steps: [{ key: 'inspect', subject: 'Inspect inputs' }, { key: 'verify', subject: 'Verify evidence', after: ['inspect'] }] })) }), { mode: 0o600 });
    await ctx.reload();
  } });
  const snapshot = async (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const data = (type: string) => { const entry = branch.findLast((item) => item.type === 'custom' && item.customType === type); return entry?.type === 'custom' ? entry.data : undefined; };
    await writeFile(join(ctx.cwd, 'ui-state.json'), JSON.stringify({ requests, idle: ctx.isIdle(), todos: data(STATE_TYPE), plan: data(PLAN_TYPE), goals: data(GOAL_TYPE), model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, retry: data('pi-dag-workflow.retry'), agents: foldAgentEntries(branch).records }), { mode: 0o600 });
  };
  pi.on('tool_execution_end', (_event, ctx) => snapshot(ctx));
  pi.on('agent_settled', (_event, ctx) => snapshot(ctx));
  pi.registerCommand('test-ui-language', { description: 'Isolated locale reload', handler: async (args, ctx) => { await writeFile(join(getAgentDir(), 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify({ language: args.trim() })); await ctx.reload(); } });
  pi.registerCommand('test-ui-theme', { description: 'Isolated theme check', handler: async (args, ctx) => { ctx.ui.setTheme(args.trim()); } });
  pi.registerCommand('test-ui-snapshot', { description: 'Export only isolated public-API state for flow verification', handler: async (_args, ctx) => snapshot(ctx) });
}
