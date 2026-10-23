import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { realpath } from 'node:fs/promises';
import { CHILD_TOOLS } from './contracts.ts';

export function agentsIO(pi: ExtensionAPI, namespace: string) {
  async function parentTools() {
    const registered = pi.getAllTools?.() ?? CHILD_TOOLS.map(name => ({ name, description: name, exposure: 'direct', namespace: undefined, sourceInfo: { path: `builtin:${name}` } }));
    return Promise.all(registered.filter(tool => !tool.name.startsWith('subagent_') && tool.namespace?.name !== namespace).map(async tool => {
      const source = tool.sourceInfo?.path;
      const path = source && !source.startsWith('builtin:') && !source.startsWith('<') ? await realpath(source).catch(() => undefined) : undefined;
      return { name: tool.name, description: tool.description, path, delegable: tool.exposure !== 'hidden' && !tool.name.startsWith('mcp__') };
    }));
  }

  return { parentTools, appendEntry: pi.appendEntry?.bind(pi), sendMessage: pi.sendMessage?.bind(pi) };
}
