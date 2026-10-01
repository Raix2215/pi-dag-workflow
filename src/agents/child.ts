import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Private RPC pipe markers, not a network endpoint. Loaded explicitly in children only. */
export const CHILD_NOTICE_PREFIX = "pi-dag-child-message:";
export const CHILD_QUESTION_PREFIX = "pi-dag-child-question:";

export default function childCommunication(pi: ExtensionAPI): void {
  const bootstrap = process.env.PI_DAG_AGENT_MODEL_BOOTSTRAP;
  delete process.env.PI_DAG_AGENT_MODEL_BOOTSTRAP;
  if (bootstrap) {
    try {
      const parsed = JSON.parse(bootstrap) as { model: { provider: string; api: string; baseUrl: string; headers?: Record<string, string>; [key: string]: unknown }; apiKey?: string };
      const { provider, api, baseUrl, headers, ...model } = parsed.model;
      if (typeof provider !== "string" || typeof api !== "string" || typeof model.id !== "string") throw new Error("Invalid model");
      // Builtin streaming adapters remain Pi-owned; this only supplies model metadata/auth.
      const config = { api, baseUrl, ...(headers ? { headers } : {}), ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }), models: [model] };
      pi.registerProvider(provider, config as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);
    } catch { throw new Error("Invalid child model bootstrap"); }
  }
  pi.registerTool({
    name: "subagent_send",
    label: "Parent communication",
    description: "Send a report to the parent. Match its length to what the parent needs: conclusions, changes, verification, and risks first, without play-by-play. Set question to wait for its answer. The parent handles any further delegation.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }), question: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Communication aborted");
      if (params.question) {
        const answer = await ctx.ui.input(`${CHILD_QUESTION_PREFIX}${params.message}`, undefined, signal ? { signal } : undefined);
        if (answer === undefined || signal?.aborted) throw new Error("Parent question cancelled");
        return { content: [{ type: "text", text: answer }], details: undefined };
      }
      ctx.ui.notify(`${CHILD_NOTICE_PREFIX}${params.message}`, "info");
      return { content: [{ type: "text", text: "Report delivered to parent." }], details: undefined };
    },
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.dag_child = "You are a one-tier child agent. Work within your assigned task and scope. Use subagent_send for reports or questions to the parent; question:true waits for its answer. The parent handles further delegation, and user authorization reaches you through the parent. Match report length to the task: lead with conclusions, changes, verification, and risks; skip play-by-play, but keep the evidence that matters. Report length is your call, and one report is enough: subagent_send or your final answer can carry it.";
  });
}
