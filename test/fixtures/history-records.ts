import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Generic retained records, never live processes or personal environment data. */
export default function historyRecords(pi: ExtensionAPI) {
  pi.registerCommand('test-history-corrupt', { description: 'Seed a corrupt agent entry for reset recovery', handler: async () => { pi.appendEntry('pi-dag-workflow.agents', { version: 99 }); } });
  pi.registerCommand('test-history-records', { description: 'Seed retained job snapshots for cleanup tests', handler: async (args) => {
    const records = JSON.parse(args) as { id: string; todoId?: number; status: string; reportDelivery?: string; taskReportStale?: boolean }[];
    pi.appendEntry('pi-dag-workflow.agents', { version: 1, nextId: 20, jobs: records.map((record) => ({ profile: 'inherit', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'off', tools: ['read', 'grep', 'find', 'ls'], startedAt: 1, endedAt: 2, pendingRequests: 0, output: 'generic retained report', usage: { requests: 1, input: 0, output: 0, estimatedCost: 0 }, reportVersion: 1, ...record })) });
  } });
}
