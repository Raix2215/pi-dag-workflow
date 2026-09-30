import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AgentRuntime, type JobSummary, type JobResult } from "./agents.ts";
import { ProfileStore, type Profile } from "./profiles.ts";
import { AgentNotices, type Notice } from "./agent-notices.ts";
import { clean } from "./view.ts";
import { applyTodo, type TodoParams, type WorkflowState } from "./todos.ts";

export const AGENTS_TYPE = "pi-dag-workflow.agents";
interface Hooks { state(): WorkflowState; mutate(params: TodoParams, ctx: ExtensionContext): unknown; paint(ctx: ExtensionContext): void; protected(): boolean }
const active = (job: JobSummary) => ["starting", "running", "waiting"].includes(job.status);
const fingerprint = (state: WorkflowState, id?: number) => {
  const task = state.tasks.find((item) => item.id === id);
  return task ? JSON.stringify([task.id, task.subject, task.description, task.blockedBy]) : "";
};
const idSchema = Type.String({ minLength: 1, maxLength: 80 });
const seconds = Type.Number({ minimum: 0, maximum: 86400 });
const text = Type.String({ minLength: 1, maxLength: 50000 });

/** Registration is side-effect-free; session hooks own runtime resources. */
export function registerAgents(pi: ExtensionAPI, hooks: Hooks) {
  let runtime: AgentRuntime | undefined;
  let profiles: ProfileStore | undefined;
  let context: ExtensionContext | undefined;
  let restoring = false;
  let paused = false;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let claiming: number | undefined;
  const notices = new AgentNotices();
  const original = new Map<string, string>();
  const adjusted = new Set<string>();
  pi.registerFlag("dag-workflow-test-child-provider", { type: "string", description: "Test-only: explicit trusted offline child provider extension" });

  const clearDelivery = () => { if (timer) clearTimeout(timer); timer = undefined; notices.clear(); };
  const drain = () => {
    const jobs = new Map((runtime?.inspect() ?? []).map((job) => [job.id, job]));
    const state = hooks.state();
    const tasks = new Map(state.tasks.map((task) => [task.id, task]));
    return notices.drain((notice) => {
      const job = jobs.get(notice.jobId);
      if (!job) return;
      const task = job.todoId === undefined ? undefined : tasks.get(job.todoId);
      if (job.todoId !== undefined && (!task || task.status === "deleted")) return;
      const stale = original.has(job.id) && original.get(job.id) !== fingerprint(state, job.todoId);
      return `[${clean(job.id)}${job.todoId ? ` / #${job.todoId}` : ""}${notice.requestId ? ` / requestId=${clean(notice.requestId)}` : ""}] ${notice.kind}${stale ? "（任务定义已改变，需重新核验）" : ""}: ${notice.message}`;
    });
  };
  const deliverIdle = () => {
    timer = undefined;
    if (!context || restoring || paused || hooks.state().plan || !context.isIdle()) return;
    const content = drain();
    if (content) {
      try { pi.sendMessage({ customType: "pi-dag-workflow.agent-report", content, display: true }, { triggerTurn: true, deliverAs: "nextTurn" }); }
      catch { paused = true; } // Session closed; durable output remains available, never retry an old wake.
    }
  };
  const onNotice = (notice: Notice) => {
    if (restoring || paused || hooks.state().plan) return;
    notices.add(notice);
    if (context?.isIdle() && !timer) timer = setTimeout(deliverIdle, 25);
  };
  const onChanged = () => {
    if (restoring || !runtime || !context) return;
    try { pi.appendEntry(AGENTS_TYPE, { version: 1, jobs: runtime.exportRecords() }); }
    catch (cause) { error = `运行状态无法保存：${String(cause)}`; paused = true; clearDelivery(); context.ui.notify(error, "error"); }
    hooks.paint(context);
  };
  async function restore(ctx: ExtensionContext) {
    restoring = true;
    generation++;
    clearDelivery();
    original.clear(); adjusted.clear();
    await runtime?.shutdown();
    context = ctx; runtime = undefined; profiles = undefined; error = undefined;
    // Restores never wake the model or resume processes. New explicit work re-enables delivery.
    paused = true;
    try {
      profiles = new ProfileStore({ path: join(getAgentDir(), "pi-dag-workflow", "pi-dag-workflow-profile.json"), registry: ctx.modelRegistry, trustedTools: ["bash", "edit", "write"] });
      await profiles.load();
      const provider = pi.getFlag("dag-workflow-test-child-provider");
      runtime = new AgentRuntime({ cwd: ctx.cwd, profiles, getInheritedModel: () => context?.model ? { provider: context.model.provider, id: context.model.id } : undefined, onChanged, onNotice,
        ...(typeof provider === "string" && provider ? { testExtensions: [provider] } : {
          getModelBootstrap: async (ref) => {
            const model = context?.modelRegistry.find(ref.provider, ref.id);
            if (!model || !context) throw new Error(`找不到模型 ${ref.provider}/${ref.id}`);
            const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(auth.error);
            return { model: { ...model, baseUrl: auth.baseUrl ?? model.baseUrl, headers: { ...model.headers, ...auth.headers } }, ...(auth.apiKey ? { apiKey: auth.apiKey } : {}), ...(auth.env ? { env: auth.env } : {}) };
          },
        }),
      });
      const entry = [...ctx.sessionManager.getBranch()].reverse().find((item) => item.type === "custom" && item.customType === AGENTS_TYPE);
      if (entry?.type === "custom") {
        const data = entry.data as { version?: unknown; jobs?: unknown } | undefined;
        if (data?.version !== 1 || !Array.isArray(data.jobs)) throw new Error("不支持或损坏的 Agent 状态");
        await runtime.importSummaries(data.jobs as JobResult[]);
      }
    } catch (cause) { error = String(cause); ctx.ui.notify(`Agent 恢复／配置失败：${error}；/agents reset 可明确清除运行记录`, "error"); }
    finally { restoring = false; hooks.paint(ctx); }
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  // Stop before switching the active branch, so writes cannot escape into the new branch.
  // A cancelled navigation leaves the old session live: undo the stop so tools keep working.
  const stopBeforeNavigation = async () => { restoring = true; generation++; clearDelivery(); await runtime?.shutdown(); restoring = false; };
  pi.on("session_before_switch", stopBeforeNavigation);
  pi.on("session_before_fork", stopBeforeNavigation);
  pi.on("session_before_tree", stopBeforeNavigation);
  pi.on("session_shutdown", async () => { restoring = true; generation++; clearDelivery(); await runtime?.shutdown(); runtime = undefined; context = undefined; });
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    event.systemPromptOptions.sections["dag_workflow_agents"] = "Use subagent_spawn for useful independent work (optional todoId/profile); no grandchildren. Inspect profiles as needed, send direction or reply by requestId, wait or cancel. Check returned work yourself before completing Todos.";
  });
  pi.on("input", (event, ctx) => { context = ctx; if (event.source !== "extension" && !hooks.state().plan && !event.text.trim().startsWith("/")) paused = false; });
  pi.on("turn_end", (event) => {
    if (event.outcome !== "completed") { paused = true; clearDelivery(); return; }
    if (restoring || paused || hooks.state().plan) return;
    const content = drain();
    if (content) return { entries: [{ type: "custom_message" as const, customType: "pi-dag-workflow.agent-report", content, display: true }], continue: true };
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome !== "completed") { paused = true; clearDelivery(); return; }
    if (restoring || paused || hooks.state().plan) return;
    const content = drain();
    if (content) return { entries: [{ type: "custom_message" as const, customType: "pi-dag-workflow.agent-report", content, display: true }], continue: true };
  });
  pi.on("agent_settled", (_event, ctx) => { context = ctx; if (!paused && !timer) timer = setTimeout(deliverIdle, 25); });

  function ready(ctx: ExtensionContext, execution = true): AgentRuntime {
    context = ctx;
    if (restoring || !runtime || error || hooks.protected()) throw new Error(error ?? "工作流正在恢复或状态受保护");
    if (execution && hooks.state().plan) throw new Error("Plan 中不实施／派发／发送执行信息；先 /plan off");
    return runtime;
  }
  const renderResult = (result: { content: { type: string; text?: string }[]; isError?: boolean }, _options: unknown, theme: ExtensionContext["ui"]["theme"]) => new Text(theme.fg(result.isError ? "error" : "text", result.content.map((item) => item.text ?? "").join("\n")), 0, 0);
  const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data });
  const fail = (cause: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String(cause) }], details: { error: String(cause) } });

  pi.registerTool({ name: "subagent_spawn", label: "Agent", description: "Start one isolated child. Optional todoId must be unblocked; profile selects a named model/tools config. Returns jobId. No grandchildren; maximum four active jobs.",
    parameters: Type.Object({ task: text, todoId: Type.Optional(Type.Integer({ minimum: 1 })), profile: Type.Optional(idSchema), tools: Type.Optional(Type.Array(idSchema)), timeout: Type.Optional(seconds) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const agent = ready(ctx);
        await profiles!.load();
        const before = hooks.state();
        const task = before.tasks.find((item) => item.id === params.todoId);
        if (params.todoId !== undefined) {
          if (!task || task.status === "completed" || task.status === "deleted") throw new Error("只能派发未完成的当前 Todo");
          applyTodo(before, { action: "update", id: task.id, status: "in_progress" }); // Validate without claiming work on startup failure.
        }
        const ownGeneration = generation;
        paused = false;
        const job = await agent.spawn(params);
        if (ownGeneration !== generation) throw new Error("会话已切换，派发已停止");
        original.set(job.id, fingerprint(before, params.todoId));
        if (task && job.status !== "failed") {
          claiming = task.id;
          try { hooks.mutate({ action: "update", id: task.id, status: "in_progress" }, ctx); }
          finally { claiming = undefined; }
        }
        const result = reply({ jobId: job.id, status: job.status, ...(job.error ? { error: job.error } : {}) });
        return job.status === "failed" ? { ...result, isError: true } : result;
      } catch (cause) { return fail(cause); }
    },
  });
  pi.registerTool({ name: "subagent_inspect", label: "Agents", description: "List private-safe job summaries and named profiles; no full child conversations.", parameters: Type.Object({ jobId: Type.Optional(idSchema) }, { additionalProperties: false }), renderResult,
    async execute(_id, params, _signal, _update, ctx) { try { const agent = ready(ctx, false); await profiles!.load(); return reply({ jobs: agent.inspect(params.jobId), profiles: profiles!.list(), profilePath: join(getAgentDir(), "pi-dag-workflow", "pi-dag-workflow-profile.json"), paused }); } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_send", label: "Agent message", description: "Send direction to recipient jobId, or answer a pending requestId; provide exactly one target.", parameters: Type.Object({ recipient: Type.Optional(idSchema), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), message: text }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) { try {
      const agent = ready(ctx);
      if (!!params.recipient === !!params.requestId) throw new Error("recipient 与 requestId 需且只能提供一个");
      await agent.send(params);
      if (params.recipient) adjusted.add(params.recipient);
      return reply({ delivered: true });
    } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_wait", label: "Wait for Agent", description: "Wait for a result or question. Timeout/abort stops only this wait, not the child. Returned work is not automatic Todo completion.", parameters: Type.Object({ jobId: idSchema, timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 300 })) }, { additionalProperties: false }), executionMode: "parallel", renderResult,
    async execute(_id, params, signal, _update, ctx) { try { return reply(await ready(ctx, false).wait(params.jobId, { ...(params.timeout !== undefined ? { timeout: params.timeout } : {}), ...(signal ? { signal } : {}) })); } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_cancel", label: "Stop Agent", description: "Stop a child. Optional remove discards its retained record and pending notices; never completes/deletes the Todo or reverts files.", parameters: Type.Object({ jobId: idSchema, remove: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) { try { const agent = ready(ctx, false); notices.drop(params.jobId); await agent.cancel(params.jobId, { ...(params.remove !== undefined ? { remove: params.remove } : {}) }); original.delete(params.jobId); adjusted.delete(params.jobId); return reply({ jobId: params.jobId, stopped: true, removed: params.remove ?? false }); } catch (cause) { return fail(cause); } },
  });

  pi.registerCommand("agents", { description: "子 Agent 状态／消息／取消与 Profile；也可直接描述需求", handler: async (args, ctx) => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === "reset") {
        if (!ctx.hasUI || !await ctx.ui.confirm("清除 Agent 运行记录？", "先停止所有子 Agent，不撤销文件修改；历史记录保留。")) return;
        restoring = true; clearDelivery(); await runtime?.shutdown();
        pi.appendEntry(AGENTS_TYPE, { version: 1, jobs: [] });
        await restore(ctx); return;
      }
      const agent = ready(ctx, false);
      if (!args.trim() || action === "list") { ctx.ui.notify(JSON.stringify({ jobs: agent.inspect(), paused }, null, 2), "info"); return; }
      if (action === "pause") { paused = true; clearDelivery(); ctx.ui.notify("已暂停结果自动唤醒；子 Agent 仍可能运行，停止请用 /agents cancel", "info"); return; }
      if (action === "resume") { ready(ctx); paused = false; ctx.ui.notify("后续新结果可自动唤醒；暂停期间旧报告仍可 /agents wait 查看", "info"); return; }
      if (action === "cancel" || action === "remove") { if (parts.length !== 1) throw new Error(`/agents ${action} jobId`); notices.drop(parts[0]!); await agent.cancel(parts[0]!, { remove: action === "remove" }); return; }
      if (action === "wait") { ctx.ui.notify(JSON.stringify(await agent.wait(parts[0]!, { timeout: 0 })), "info"); return; }
      if (action === "send" || action === "reply") { ready(ctx); const target = parts.shift(); if (!target || !parts.length) throw new Error(`/agents ${action} 编号 消息`); await agent.send({ ...(action === "send" ? { recipient: target } : { requestId: target }), message: parts.join(" ") }); if (action === "send") adjusted.add(target); return; }
      if (action === "profiles") { await profiles!.load(); ctx.ui.notify(JSON.stringify(profiles!.list(), null, 2), "info"); return; }
      if (action === "profile") {
        ready(ctx);
        const [name, model, thinking, tools] = parts;
        if (!name || !model || parts.length > 4 || !model.includes("/")) throw new Error("/agents profile 名称 provider/model [thinking] [工具逗号列表]");
        const split = model.indexOf("/");
        profiles!.set({ name, model: { provider: model.slice(0, split), id: model.slice(split + 1) }, ...(thinking ? { thinking: thinking as NonNullable<Profile["thinking"]> } : {}), ...(tools ? { tools: tools.split(",") } : {}) });
        await profiles!.save(); ctx.ui.notify(`已保存 Profile ${name}`, "info"); return;
      }
      if (action === "unprofile") { ready(ctx); if (parts.length !== 1) throw new Error("/agents unprofile 名称"); profiles!.delete(parts[0]!); await profiles!.save(); return; }
      pi.sendUserMessage(`请管理当前子 Agent／Profile：${args}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    } catch (cause) { ctx.ui.notify(String(cause), "error"); }
  } });
  return {
    summaries: () => runtime?.inspect() ?? [],
    assertPlanEntry() { if (restoring || error) throw new Error(error ?? "Agent 状态正在恢复"); if (runtime?.activeCount()) throw new Error("子 Agent 仍在执行／等待；请先等待结束或明确取消，再进入 Plan"); clearDelivery(); paused = true; },
    assertTodoMutation(params: TodoParams) {
      if (params.action === "list" || params.action === "get" || params.action === "create" || claiming !== undefined && params.action === "update" && params.id === claiming) return;
      const jobs = (runtime?.inspect() ?? []).filter(active).filter((job) => params.action === "clear" || job.todoId === params.id);
      for (const job of jobs) {
        if (params.action !== "update" || params.status !== undefined || !adjusted.has(job.id)) throw new Error(`任务 #${job.todoId} 关联活动 ${job.id}；内容修改先发送明确调整信息，完成／删除／清空先停止该 Agent`);
      }
    },
    afterTodoMutation(params: TodoParams) { for (const job of runtime?.inspect() ?? []) if (job.todoId === params.id) adjusted.delete(job.id); },
  };
}
