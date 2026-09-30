import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Test-only public command APIs, never shipped in the plugin package. */
export default function sessionControls(pi: ExtensionAPI): void {
  pi.registerCommand("test-tree", { description: "Test active-branch navigation", handler: async (args, ctx) => { await ctx.navigateTree(args.trim(), { summarize: false }); } });
  pi.registerCommand("test-reload", { description: "Test actual extension reload", handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("test-corrupt", { description: "Append invalid test state without changing existing history", handler: async () => { pi.appendEntry("pi-dag-workflow.state", { version: 99 }); } });
  pi.registerTool({ name: "test_search", label: "Test search", description: "Offline test search only", parameters: Type.Object({ query: Type.String() }), async execute(_id, params) { return { content: [{ type: "text", text: `offline search: ${params.query}` }], details: undefined }; } });
}
