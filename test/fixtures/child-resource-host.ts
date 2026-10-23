import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { protocolHost } from './agents-protocol-host.ts';

/** Discover the child's extension through public dispatch argv, then drive its native Pi registration. */
export async function childResourceHost(env: NodeJS.ProcessEnv) {
  const parent = await protocolHost({ cli: fileURLToPath(new URL('./m2-rpc-fixture.mjs', import.meta.url)) });
  const spawn = childProcess.spawn;
  let resource: string | undefined;
  childProcess.spawn = ((command: string, args: string[], options: any) => {
    resource = args[args.indexOf('-e') + 1];
    return spawn(command, args, options);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  let loaded: ReturnType<DefaultResourceLoader['getExtensions']> | undefined;
  try {
    const job = await parent.call('subagent_spawn', { task: 'HOLD', tools: ['read'] });
    await parent.call('subagent_cancel', { jobId: job.jobId });
    if (!resource) throw new Error('Public dispatch did not specify a child extension');
    const keys = ['PI_DAG_AGENT_PROFILE_PROMPT', 'PI_DAG_AGENT_CONTEXT', 'PI_DAG_AGENT_MODEL_BOOTSTRAP', 'PI_DAG_AGENT_SKILLS', 'PI_DAG_AGENT_TOOLS'];
    const saved = keys.map(key => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    try {
      const loader = new DefaultResourceLoader({ cwd: parent.root, agentDir: join(parent.root, 'resource-agent'), settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [resource], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload(); loaded = loader.getExtensions();
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
    } finally {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    }
    const extension = loaded.extensions[0];
    if (!extension) throw new Error('Native Pi loader did not register the dispatched child extension');
    const sent: unknown[] = [], entries: any[] = [];
    const runtime = loaded.runtime;
    runtime.sendMessage = ((...args: any[]) => { sent.push(args); }) as typeof runtime.sendMessage;
    runtime.sendUserMessage = ((...args: any[]) => { sent.push(args); }) as typeof runtime.sendUserMessage;
    const ctx: any = { sessionManager: { getBranch: () => entries }, isIdle: () => true };
    const fire = (name: string, event: any = {}) => (extension.handlers.get(name) ?? []).map(handler => (handler as any)(event, ctx));
    const start = () => { const event: any = { type: 'before_agent_start', systemPromptOptions: { sections: {} } }; const result = fire('before_agent_start', event)[0]; return { event, result }; };
    const persist = (message: any) => entries.push({ type: 'custom_message', ...message });
    return { pi: runtime, sent, entries, fire, start, persist, async close() { loaded!.runtime.invalidate(); await parent.close(); } };
  } catch (error) { loaded?.runtime.invalidate(); await parent.close(); throw error; }
}
