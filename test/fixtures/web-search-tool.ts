import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/**
 * Offline stand-in for a read-only network tool. Plan mode's allowlist is name-based, so a
 * registered `web_search` is enough to exercise the guard end to end without network access.
 */
export default function webSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'web_search',
    label: 'Web search',
    description: 'Offline test double for a web search tool.',
    parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, _ctx) {
      return { content: [{ type: 'text', text: `offline result for: ${params.query}` }], details: undefined };
    },
  });
}
