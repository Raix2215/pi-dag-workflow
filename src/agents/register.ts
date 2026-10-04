import { randomUUID } from 'node:crypto';
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { configPaths } from "../shared/config.ts";
import { Text } from "@earendil-works/pi-tui";
import { AgentRuntime, type JobSummary } from "./runtime.ts";
import { ProfileStore, type Profile } from "./profiles.ts";
import { fragmentContext } from "./context.ts";
import { resetClosure } from "../todos/presets.ts";
import { AgentNotices, type Notice } from "./notices.ts";
import { clean, displayText, notify } from "../ui/render.ts";
import { applyTodo, type ClearScope, type Todo, type TodoParams, type WorkflowState } from "../todos/state.ts";
import { workflowNamespace, readOnly } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';
import { AgentJournal, AGENTS_ENTRY_TYPE, foldAgentEntries } from './persistence.ts';

export const AGENTS_TYPE = AGENTS_ENTRY_TYPE;
interface Hooks { msg?: Translator; ui?(): boolean; state(): WorkflowState; mutate(params: TodoParams, ctx: ExtensionContext): unknown; paint(ctx: ExtensionContext): void; protected(): boolean; canWake?(): boolean; reserveWake?(ctx: ExtensionContext): boolean; pauseAuto?(ctx: ExtensionContext): void; resumeAuto?(): boolean; beforeWake?(ctx: ExtensionContext): void; compacting?(): boolean }
const active = (job: JobSummary) => ["starting", "running", "waiting"].includes(job.status);
const fingerprint = (state: WorkflowState, id?: number) => {
  const task = state.tasks.find((item) => item.id === id);
  return task ? JSON.stringify([task.id, task.subject, task.description, task.blockedBy]) : "";
};
const idSchema = Type.String({ minLength: 1, maxLength: 80 });
const seconds = Type.Number({ exclusiveMinimum: 0, maximum: 86400 });
const text = Type.String({ minLength: 1 });

/** Registration is side-effect-free; session hooks own runtime resources. */
/**
 * Whether an active child blocks this todo mutation. A child that already sent an interim report
 * may have its task completed while it keeps working on later steps; every other edit, and any
 * task the child has not reported on, still waits for the child to stop.
 */
export function claimedBy(job: { id: string; todoId?: number }, params: TodoParams, options: { adjusted: ReadonlySet<string>; reported: boolean }): boolean {
  if (params.action === "update") {
    if (params.status === "completed" && options.reported && Object.keys(params).every((key) => ["action", "id", "status"].includes(key))) return false;
    if (params.status === undefined && options.adjusted.has(job.id)) return false;
  }
  return true;
}

export function registerAgents(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  let runtime: AgentRuntime | undefined;
  let profiles: ProfileStore | undefined;
  let context: ExtensionContext | undefined;
  let restoring = false;
  let paused = false;
  let failedRound = false;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let claiming: number | undefined;
  const notices = new AgentNotices();
  const journal = new AgentJournal();
  let proposedReport: { id: string; content: string; terminalJobIds: string[] } | undefined;
  let reportAttempts = 0;
  const original = new Map<string, string>();
  const adjusted = new Set<string>();
  const jobStatusLabel: Record<JobSummary['status'], string> = { starting: '启动中', running: '运行中', waiting: '等待回复', completed: '已返回', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
  const statusLabel = (job: { status: JobSummary['status']; reportDelivery?: JobSummary['reportDelivery'] }) => job.status === 'completed' && job.reportDelivery === 'pending' ? msg('待交付') : msg(jobStatusLabel[job.status]);
  const activeStatuses = new Set<JobSummary['status']>(['starting', 'running', 'waiting']);
  /** Display-only projection for tool results: the linked Todo's current state, never persisted. */
  const todoStatusOf = (todoId?: number) => {
    if (todoId === undefined) return undefined;
    const task = hooks.state().tasks.find((item) => item.id === todoId);
    return task && task.status !== "deleted" ? task.status : undefined;
  };
  const completion: CompletionSpec = {
    actions: [
      { action: 'list', description: msg('查看 Job 与暂停状态') },
      { action: 'wait', description: msg('等待 Job 结果：wait jobId') },
      { action: 'send', description: msg('给 Job 发消息：send jobId 消息') },
      { action: 'reply', description: msg('回答子 Agent 请求：reply requestId 回答') },
      { action: 'cancel', description: msg('停止 Job：cancel jobId') },
      { action: 'remove', description: msg('停止并移除记录：remove jobId') },
      { action: 'pause', description: msg('暂停结果自动唤醒') },
      { action: 'resume', description: msg('恢复结果自动唤醒') },
      { action: 'profiles', description: msg('查看已保存 Profile') },
      { action: 'profile', description: msg('保存 Profile：profile 名称 provider/model [thinking] [工具]') },
      { action: 'unprofile', description: msg('删除 Profile：unprofile 名称') },
      { action: 'reset', description: msg('清除 Agent 运行记录') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
    freeText: ['profile', 'reply'],
    tokens: (action) => {
      if (action === 'unprofile') return (profiles?.list() ?? []).map((profile) => ({ token: profile.name, label: profile.name, description: profile.model ? `${profile.model.provider}/${profile.model.id}` : msg('继承主会话') }));
      if (!['wait', 'send', 'cancel', 'remove'].includes(action)) return null;
      return (runtime?.viewSummaries() ?? [])
        .filter((job) => action !== 'send' || activeStatuses.has(job.status))
        .map((job) => ({ token: job.id, label: `${job.id}${job.todoId ? ` / #${job.todoId}` : ''} · ${job.profile}`, description: statusLabel(job) }));
    },
  };
  pi.registerFlag("dag-workflow-test-child-provider", { type: "string", description: "Test-only: explicit trusted offline child provider extension" });

  const clearDelivery = () => { if (timer) clearTimeout(timer); timer = undefined; failedRound = false; notices.clear(); proposedReport = undefined; reportAttempts = 0; };
  const drain = () => {
    const jobs = new Map((runtime?.inspect() ?? []).map((job) => [job.id, job]));
    const state = hooks.state();
    const tasks = new Map(state.tasks.map((task) => [task.id, task]));
    const terminalJobIds = new Set<string>();
    const content = notices.drain((notice) => {
      const job = jobs.get(notice.jobId);
      if (!job) return;
      if (notice.kind === 'question' && notice.requestId && !runtime?.hasRequest(job.id, notice.requestId)) return;
      const task = job.todoId === undefined ? undefined : tasks.get(job.todoId);
      if (job.todoId !== undefined && (!task || task.status === "deleted")) return;
      const changedDefinition = original.has(job.id) && original.get(job.id) !== fingerprint(state, job.todoId);
      const stale = job.taskReportStale ? msg('（历史输出，仅作参考）') : changedDefinition ? msg('（任务定义已改变，需重新核验）') : '';
      if ((notice.kind === 'completed' || notice.kind === 'failed') && (job.status === 'completed' || job.status === 'failed') && job.reportDelivery === 'pending') terminalJobIds.add(job.id);
      const receipt = task && ['completed', 'failed'].includes(notice.kind)
        ? task.status === 'completed' ? msg`\nTodo #${task.id} 已完成，本报告仅供参考。`
          : job.taskReportStale ? msg`\nTodo #${task.id} 当前状态：${task.status}；这是历史输出，不作为本轮验收依据。`
          : msg`\nTodo #${task.id} 当前状态：${task.status}；核验后再更新，报告不会自动完成任务。`
        : '';
      return msg`[${clean(job.id)}${job.todoId ? msg` / #${job.todoId}` : ""}${notice.requestId ? msg` / requestId=${clean(notice.requestId)}` : ""}] ${notice.kind}${stale}: ${notice.message}${receipt}`;
    }, msg);
    return { content, terminalJobIds: [...terminalJobIds] };
  };
  // Boundary entries are drafts. Retain an uncommitted batch until the real request sees it.
  const reportPersisted = (ctx: ExtensionContext) => proposedReport && ctx.sessionManager.getBranch().some((entry) => entry.type === 'custom_message' && entry.customType === 'pi-dag-workflow.agent-report' && (entry.details as { deliveryId?: string } | undefined)?.deliveryId === proposedReport!.id);
  const prepareReport = () => {
    // A repeatedly rejected batch stays queryable in Job records; it cannot block new arrivals.
    if (reportAttempts >= 3) { proposedReport = undefined; reportAttempts = 0; }
    if (proposedReport) return proposedReport;
    if (!notices.size) return undefined;
    const batch = drain();
    if (batch.content) proposedReport = { ...batch, content: batch.content, id: randomUUID() };
    return proposedReport;
  };
  // A context filter remains free to omit persisted reports. Never force them back into a request.
  const retirePersisted = (ctx: ExtensionContext) => { if (reportPersisted(ctx)) { proposedReport = undefined; reportAttempts = 0; } };
  const acknowledge = (jobIds: readonly string[]) => { for (const jobId of jobIds) runtime?.markReportDelivered(jobId); };
  const deliverIdle = () => {
    timer = undefined;
    if (!context || restoring || paused || failedRound || hooks.compacting?.() || hooks.state().plan || hooks.canWake?.() === false || !context.isIdle()) return;
    retirePersisted(context);
    const report = prepareReport();
    if (report && reportAttempts < 3 && hooks.reserveWake?.(context) !== false) {
      try { hooks.beforeWake?.(context); reportAttempts++; pi.sendMessage({ customType: "pi-dag-workflow.agent-report", content: report.content, details: { deliveryId: report.id }, display: true }, { triggerTurn: true, deliverAs: "followUp" }); }
      catch (cause) { paused = true; proposedReport = undefined; reportAttempts = 0; notify(context, msg`Agent 自动唤醒失败：${String(cause)}`, "warning"); } // Durable output remains available; never retry an old wake.
    }
  };
  const onNotice = (notice: Notice) => {
    if (restoring || paused || hooks.state().plan || hooks.canWake?.() === false) return;
    notices.add(notice);
    if (!failedRound && context?.isIdle() && !timer) timer = setTimeout(deliverIdle, 25);
  };
  /** Live activity refreshes only the widget; throttled and never appended to the session. */
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivityStamp = 0;
  const clearActivity = () => { if (activityTimer) clearTimeout(activityTimer); activityTimer = undefined; };
  const onActivity = () => {
    if (hooks.ui?.() === false || restoring || !context?.hasUI || activityTimer) return;
    const ownGeneration = generation;
    const refresh = () => {
      activityTimer = undefined;
      if (restoring || ownGeneration !== generation || !context) return;
      lastActivityStamp = Date.now();
      hooks.paint(context);
      // Only elapsed tool time needs a periodic tick; thinking/output repaint on transitions.
      if (runtime?.activities().some((item) => item.activity.kind === "tool" && item.activity.since !== undefined) && context.hasUI) activityTimer = setTimeout(refresh, 1000);
    };
    activityTimer = setTimeout(refresh, Math.max(0, 300 - (Date.now() - lastActivityStamp)));
  };
  const onChanged = () => {
    if (restoring || !runtime || !context) return;
    try {
      // Append-only deltas: unchanged jobs keep their previous bytes and only the output tail is written.
      const payload = journal.prepare(runtime.exportRecords(), runtime.nextId());
      if (payload) { pi.appendEntry(AGENTS_TYPE, payload); journal.confirm(); }
    }
    catch (cause) { error = msg`运行状态无法保存：${String(cause)}`; paused = true; clearDelivery(); notify(context, error, "error"); }
    hooks.paint(context);
    onActivity();
  };
  async function restore(ctx: ExtensionContext) {
    restoring = true;
    generation++;
    clearDelivery(); clearActivity();
    original.clear(); adjusted.clear();
    await runtime?.shutdown();
    context = ctx; runtime = undefined; profiles = undefined; error = undefined;
    // Restores never wake the model or resume processes. New explicit work re-enables delivery.
    paused = true;
    try {
      profiles = new ProfileStore({ path: configPaths().profile, registry: ctx.modelRegistry, trustedTools: ["bash", "edit", "write"] });
      await profiles.load();
      const provider = pi.getFlag("dag-workflow-test-child-provider");
      runtime = new AgentRuntime({ cwd: ctx.cwd, profiles, getInheritedModel: () => context?.model ? { provider: context.model.provider, id: context.model.id } : undefined, onChanged, onNotice, onActivity,
        ...(typeof provider === "string" && provider ? { testExtensions: [provider] } : {
          getModelBootstrap: async (ref) => {
            const model = context?.modelRegistry.find(ref.provider, ref.id);
            if (!model || !context) throw new Error(msg`找不到模型 ${ref.provider}/${ref.id}`);
            const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(auth.error);
            return { model: { ...model, baseUrl: auth.baseUrl ?? model.baseUrl, headers: { ...model.headers, ...auth.headers } }, ...(auth.apiKey ? { apiKey: auth.apiKey } : {}), ...(auth.env ? { env: auth.env } : {}) };
          },
        }),
      });
      // Fold the active branch once: version-1 snapshots replace, version-2 deltas continue.
      const folded = foldAgentEntries(ctx.sessionManager.getBranch());
      await runtime.importSummaries(folded.records, folded.nextId);
      // The confirmed base is what was actually saved, before import normalizes metadata
      // and interrupts old live jobs. Persist those changes on the next real update.
      journal.hydrate(folded.records, runtime.nextId());
    } catch (cause) { error = String(cause); notify(ctx, msg`Agent 恢复／配置失败：${error}；/agents reset 可明确清除运行记录`, "error"); }
    finally { restoring = false; hooks.paint(ctx); }
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  // Stop before switching the active branch, so writes cannot escape into the new branch.
  // A cancelled navigation leaves the old session live: undo the stop so tools keep working.
  const stopBeforeNavigation = async () => {
    const hadActive = runtime?.activeCount() ?? 0;
    restoring = true; generation++; paused = true; clearDelivery(); clearActivity();
    try {
      await runtime?.shutdown();
      // A later extension may cancel navigation: retain an available, interrupted runtime.
      if (runtime) await runtime.importSummaries(runtime.exportRecords());
    } finally { restoring = false; }
    if (hadActive) onChanged();
  };
  pi.on("session_before_switch", stopBeforeNavigation);
  pi.on("session_before_fork", stopBeforeNavigation);
  pi.on("session_before_tree", stopBeforeNavigation);
  pi.on("session_shutdown", async () => { restoring = true; generation++; clearDelivery(); clearActivity(); await runtime?.shutdown(); runtime = undefined; context = undefined; });
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    event.systemPromptOptions.sections["dag_workflow_agents"] = "Child agents are single-tier: no grandchildren. Verify returned work yourself before completing a Todo.";
  });
  pi.on("input", (event, ctx) => { context = ctx; if (event.source !== "extension" && !hooks.state().plan && !event.text.trim().startsWith("/")) { paused = false; failedRound = false; } });
  const reportBoundary = (outcome: string, ctx: ExtensionContext, entries: SessionBoundaryDraft[] = []) => {
    // A model error may recover natively or through Goal. Hold reports for the successful turn
    // instead of dropping them or racing a separate idle wake. Explicit aborts still pause.
    if (outcome === "error") { failedRound = true; return; }
    if (outcome !== "completed") { paused = true; clearDelivery(); return; }
    failedRound = false;
    if (restoring || paused || hooks.compacting?.() || hooks.state().plan || hooks.canWake?.() === false) return;
    retirePersisted(ctx);
    const report = prepareReport();
    if (report && reportAttempts < 3 && hooks.reserveWake?.(ctx) !== false) {
      reportAttempts++;
      return { entries: [...entries, { type: "custom_message" as const, customType: "pi-dag-workflow.agent-report", content: report.content, details: { deliveryId: report.id }, display: true }], continue: true };
    }
  };
  pi.on("turn_end", (event, ctx) => reportBoundary(event.outcome, ctx, event.entries));
  pi.on("agent_before_settle", (event, ctx) => reportBoundary(event.outcome, ctx, event.entries));
  pi.on('context', (event) => {
    if (!proposedReport) return;
    if (event.messages.some((message) => (message as { details?: { deliveryId?: string } }).details?.deliveryId === proposedReport!.id)) {
      acknowledge(proposedReport.terminalJobIds); proposedReport = undefined; reportAttempts = 0;
    }
  });
  pi.on('session_compact', (_event, ctx) => { context = ctx; if (!paused && !timer) timer = setTimeout(deliverIdle, 25); });
  pi.on("agent_settled", (_event, ctx) => { context = ctx; if (!paused && !failedRound && !timer) timer = setTimeout(deliverIdle, 25); });

  function ready(ctx: ExtensionContext, execution = true): AgentRuntime {
    context = ctx;
    if (restoring || !runtime || error || hooks.protected()) throw new Error(error ?? msg("工作流正在恢复或状态受保护"));
    if (execution && hooks.state().plan) throw new Error(msg("Plan 中不实施／派发／发送执行信息；先 /plan off"));
    return runtime;
  }
  const renderResult = (result: { content: { type: string; text?: string }[]; isError?: boolean }, _options: unknown, theme: ExtensionContext["ui"]["theme"]) => new Text(theme.fg(result.isError ? "error" : "text", displayText(result.content.map((item) => item.text ?? "").join("\n"))), 0, 0);
  const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data });
  const fail = (cause: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String(cause) }], details: { error: String(cause) } });

  pi.registerTool({ name: "subagent_spawn", label: "Agent", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Start one isolated child. Optional todoId must be unblocked; profile selects a named model/tools config; context:true attaches the task's fragment state and earlier step reports. Returns jobId. No grandchildren; maximum eight active jobs.",
    promptSnippet: "Use subagent_spawn to start one isolated child agent for independent work",
    promptGuidelines: [
      "Delegate work that is independent and verifiable, such as research or isolated edits; keep the critical path and final verification in the main session.",
      "Pass todoId to bind a job to its task and choose the profile that fits the job. A returned report never completes the task by itself: verify the work first.",
      "Give one child a serial chain (A then B then C) when its steps share context, bind its last task only if it is already unblocked; otherwise bind the first ready task, and ask it to send a short interim message as each step finishes. Start parallel children for independent branches, and dispatch a task only when its prerequisites are completed: never ask a child to wait on work another child is doing.",
      "Set context:true when the task belongs to a task fragment, so the child receives its step position, the whole fragment with statuses, and the report heads of earlier steps instead of rediscovering them.",
    ],
    parameters: Type.Object({ task: text, todoId: Type.Optional(Type.Integer({ minimum: 1 })), profile: Type.Optional(idSchema), tools: Type.Optional(Type.Array(idSchema)), timeout: Type.Optional(seconds), context: Type.Optional(Type.Boolean({ description: "Attach the task's fragment state and earlier step report heads" })) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const agent = ready(ctx);
        await profiles!.load();
        const before = hooks.state();
        const task = before.tasks.find((item) => item.id === params.todoId);
        if (params.todoId !== undefined) {
          if (!task || task.status === "completed" || task.status === "deleted") throw new Error(msg("只能派发未完成的当前 Todo"));
          applyTodo(before, { action: "update", id: task.id, status: "in_progress" }, msg); // Validate without claiming work on startup failure.
        }
        // Opt-in: the parent decides per dispatch, and only a bound task can carry a fragment brief.
        const context = params.context === true && task ? fragmentContext(task.id, before.tasks, agent.exportRecords()) : undefined;
        const ownGeneration = generation;
        paused = false; failedRound = false;
        const job = await agent.spawn({
          task: params.task,
          ...(params.todoId === undefined ? {} : { todoId: params.todoId }),
          ...(params.profile === undefined ? {} : { profile: params.profile }),
          ...(params.tools === undefined ? {} : { tools: params.tools }),
          ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
          ...(context ? { context } : {}),
        });
        if (ownGeneration !== generation) throw new Error(msg("会话已切换，派发已停止"));
        original.set(job.id, fingerprint(before, params.todoId));
        if (task && job.status !== "failed") {
          claiming = task.id;
          try { hooks.mutate({ action: "update", id: task.id, status: "in_progress" }, ctx); }
          finally { claiming = undefined; }
        }
        const result = reply({ jobId: job.id, status: job.status, ...(task ? { todoId: task.id, todoStatus: hooks.state().tasks.find((item) => item.id === task.id)?.status } : {}), ...(job.error ? { error: job.error } : {}) });
        return job.status === "failed" ? { ...result, isError: true } : result;
      } catch (cause) { return fail(cause); }
    },
  });
  pi.registerTool({ name: "subagent_inspect", label: "Agents", namespace: workflowNamespace, annotations: readOnly, description: "Inspect job lifecycle, current activity/tools, elapsed time, queued directions, pending question IDs and reportVersion without waiting. Use requestId to answer a child question. A selected job omits profiles by default; profiles:true includes full profile instructions. No full output.",
    promptSnippet: "Use subagent_inspect to list child jobs, status, and saved profiles", parameters: Type.Object({ jobId: Type.Optional(idSchema), profiles: Type.Optional(Type.Boolean({ description: 'Include full named profiles and their instructions; default list is brief, selected job omits profiles' })) }, { additionalProperties: false }), renderResult,
    async execute(_id, params, _signal, _update, ctx) { try { const agent = ready(ctx, false); await profiles!.load(); const jobs = agent.inspect(params.jobId).map((job) => { const todoStatus = todoStatusOf(job.todoId); return todoStatus === undefined ? job : { ...job, todoStatus }; }); const listed = profiles!.list(); return reply({ jobs, ...(params.profiles ? { profiles: listed, profilePath: configPaths().profile } : params.jobId ? {} : { profiles: listed.map(({ instructions: _omitted, ...profile }) => profile) }), paused }); } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_send", label: "Agent message", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Send direction to recipient jobId or answer requestId; exactly one target. Normal direction queues at the next safe boundary and does not stop a running tool. interrupt:true aborts the current local turn, clears old queued directions/questions, then resumes the same child context with the new direction. External actions may still run. Delivery is accepted/queued/answered, not proof the child followed it.",
    promptSnippet: "Use subagent_send to direct a child job or answer its question", parameters: Type.Object({ recipient: Type.Optional(idSchema), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), message: text, interrupt: Type.Optional(Type.Boolean({ description: 'recipient only: interrupt local turn, discard old queue, and continue the same child with this direction' })) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) { try {
      const agent = ready(ctx);
      if (!!params.recipient === !!params.requestId) throw new Error(msg("recipient 与 requestId 需且只能提供一个"));
      const result = await agent.send(params);
      if (params.recipient) adjusted.add(params.recipient);
      return reply(result);
    } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_wait", label: "Wait for Agent", namespace: workflowNamespace, annotations: readOnly, description: "Collect child output/question and linked todoStatus. timeout:0 returns a snapshot immediately. Default until:update waits up to 5s for a new report, question or finish; after uses reportVersion to avoid waiting on old reports. until:finish waits for execution end (default 30s, max 300s); questions still return early. Do independent work instead of repeated polling or long waits. Timeout/abort affects this wait only. Verify output before completing the Todo.",
    promptSnippet: "Use subagent_wait to collect a child result or question", parameters: Type.Object({ jobId: idSchema, timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 300 })), until: Type.Optional(Type.Union([Type.Literal('update'), Type.Literal('finish')])), after: Type.Optional(Type.Integer({ minimum: 0, description: 'Wait for reports newer than this reportVersion; default captures the current version at call time' })) }, { additionalProperties: false }), executionMode: "parallel", renderResult,
    async execute(_id, params, signal, _update, ctx) { try {
      const agent = ready(ctx, false);
      const result = await agent.wait(params.jobId, { ...(params.timeout !== undefined ? { timeout: params.timeout } : {}), ...(signal ? { signal } : {}), ...(params.until === undefined ? {} : { until: params.until }), ...(params.after === undefined ? {} : { after: params.after }) });
      // The tool result itself carries current content into the model context: no duplicate auto notice.
      notices.drop(params.jobId, result.reportVersion);
      if ((result.status === "completed" || result.status === "failed") && result.reportDelivery === "pending" && agent.markReportDelivered(params.jobId)) result.reportDelivery = "delivered";
      const todoStatus = todoStatusOf(result.todoId);
      return reply(todoStatus === undefined ? result : { ...result, todoStatus });
    } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_cancel", label: "Stop Agent", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, description: "Stop a child. Optional remove discards its retained record and pending notices; never completes/deletes the Todo or reverts files.",
    promptSnippet: "Use subagent_cancel to stop one child job", parameters: Type.Object({ jobId: idSchema, remove: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) { try { const agent = ready(ctx, false); if (params.remove || active(agent.inspect(params.jobId)[0]!)) notices.drop(params.jobId); await agent.cancel(params.jobId, { ...(params.remove !== undefined ? { remove: params.remove } : {}) }); original.delete(params.jobId); adjusted.delete(params.jobId); return reply({ jobId: params.jobId, stopped: true, removed: params.remove ?? false }); } catch (cause) { return fail(cause); } },
  });

  pi.registerCommand("agents", { description: msg("子 Agent 状态／消息／取消与 Profile；也可直接描述需求"), getArgumentCompletions: (prefix) => completeArguments(prefix, completion), handler: async (args, ctx) => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify(msg('/agents list · wait jobId · send jobId 消息 · reply requestId 回答 · cancel/remove jobId · pause/resume · profiles · profile 名称 provider/model [thinking] [工具逗号列表] · unprofile 名称 · reset · Profile 的 instructions 写在配置文件里，成为该 profile 子 Agent 的系统提示词段'), 'info'); return; }
      if (action === "reset") {
        if (!ctx.hasUI || !await ctx.ui.confirm(msg("清除 Agent 运行记录？"), msg("先停止所有子 Agent，不撤销文件修改；历史记录保留。"))) return;
        restoring = true; clearDelivery(); clearActivity(); await runtime?.shutdown();
        pi.appendEntry(AGENTS_TYPE, { version: 1, jobs: [], nextId: runtime?.nextId() ?? 1 });
        journal.reset();
        await restore(ctx); return;
      }
      const agent = ready(ctx, false);
      if (!args.trim() || action === "list") { notify(ctx, JSON.stringify({ jobs: agent.inspect(), paused }, null, 2), "info"); return; }
      if (action === "pause") { paused = true; clearDelivery(); hooks.pauseAuto?.(ctx); ctx.ui.notify(msg("已暂停结果自动唤醒；子 Agent 仍可能运行，停止请用 /agents cancel"), "info"); return; }
      if (action === "resume") { ready(ctx); if (hooks.resumeAuto ? !hooks.resumeAuto() : hooks.canWake?.() === false) throw new Error(msg("Goal 续跑仍暂停；先明确 /goal enable")); paused = false; failedRound = false; ctx.ui.notify(msg("后续新结果可自动唤醒；暂停期间旧报告仍可 /agents wait 查看"), "info"); return; }
      if (action === "cancel" || action === "remove") { if (parts.length !== 1) throw new Error(msg`/agents ${action} jobId`); if (action === 'remove' || active(agent.inspect(parts[0]!)[0]!)) notices.drop(parts[0]!); await agent.cancel(parts[0]!, { remove: action === "remove" }); return; }
      if (action === "wait") { notify(ctx, JSON.stringify(await agent.wait(parts[0]!, { timeout: 0 })), "info"); return; }
      if (action === "send" || action === "reply") { ready(ctx); const target = parts.shift(); if (!target || !parts.length) throw new Error(msg`/agents ${action} 编号 消息`); const interrupt = action === 'send' && parts[0] === '--interrupt'; if (interrupt) parts.shift(); if (!parts.length) throw new Error(msg('/agents send jobId [--interrupt] 消息')); await agent.send({ ...(action === "send" ? { recipient: target } : { requestId: target }), message: parts.join(" "), ...(interrupt ? { interrupt: true } : {}) }); if (action === "send") adjusted.add(target); return; }
      if (action === "profiles") { await profiles!.load(); notify(ctx, JSON.stringify(profiles!.list(), null, 2), "info"); return; }
      if (action === "profile") {
        ready(ctx);
        const [name, model, thinking, tools] = parts;
        if (!name || !model || parts.length > 4 || !model.includes("/")) throw new Error(msg("/agents profile 名称 provider/model [thinking] [工具逗号列表]"));
        const split = model.indexOf("/");
        await profiles!.load();
        profiles!.set({ name, model: { provider: model.slice(0, split), id: model.slice(split + 1) }, ...(thinking ? { thinking: thinking as NonNullable<Profile["thinking"]> } : {}), ...(tools ? { tools: tools.split(",") } : {}), ...(profiles!.get(name)?.instructions ? { instructions: profiles!.get(name)!.instructions } : {}) });
        await profiles!.save(); ctx.ui.notify(msg`已保存 Profile ${name}`, "info"); return;
      }
      if (action === "unprofile") { ready(ctx); if (parts.length !== 1) throw new Error(msg("/agents unprofile 名称")); await profiles!.load(); profiles!.delete(parts[0]!); await profiles!.save(); return; }
      pi.sendUserMessage(msg`请管理当前子 Agent／Profile：${args}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    } catch (cause) { notify(ctx, String(cause), "error"); }
  } });
  return {
    pauseAutomatic() { paused = true; clearDelivery(); },
    resumeAutomatic() { paused = false; failedRound = false; },
    summaries: () => runtime?.viewSummaries() ?? [],
    cleanupProtection(tasks: readonly Todo[]) {
      if (restoring || error) throw new Error(error ?? msg('Agent 状态正在恢复'));
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const protectedIds = new Set<number>();
      for (const job of runtime?.inspect() ?? []) {
        if (job.todoId === undefined) continue;
        const task = byId.get(job.todoId);
        const verification = job.status === 'completed' && !job.taskReportStale && task && ['pending', 'in_progress'].includes(task.status);
        if (active(job) || job.reportDelivery === 'pending' || verification) protectedIds.add(job.todoId);
      }
      return protectedIds;
    },
    cleanupRecords(scope: ClearScope, before: readonly Todo[], remaining: readonly Todo[]) {
      if (restoring || error) throw new Error(error ?? msg('Agent 状态正在恢复'));
      const beforeById = new Map(before.map((task) => [task.id, task]));
      const remainingById = new Map(remaining.map((task) => [task.id, task]));
      const ids = (runtime?.inspect() ?? []).filter((job) => {
        if (active(job) || job.reportDelivery === 'pending') return false;
        const task = job.todoId === undefined ? undefined : remainingById.get(job.todoId);
        if (task && ['pending', 'in_progress'].includes(task.status)) return false;
        if (scope !== 'completed') return true;
        return job.status === 'completed' || job.todoId !== undefined && beforeById.get(job.todoId)?.status === 'completed';
      }).map((job) => job.id);
      for (const id of ids) { notices.drop(id); original.delete(id); adjusted.delete(id); }
      return runtime?.prune(ids) ?? 0;
    },
    assertPlanEntry() { if (restoring || error) throw new Error(error ?? msg("Agent 状态正在恢复")); if (runtime?.activeCount()) throw new Error(msg("子 Agent 仍在执行／等待；请先等待结束或明确取消，再进入 Plan")); clearDelivery(); paused = true; },
    assertTodoMutation(params: TodoParams) {
      if (params.action === "list" || params.action === "get" || params.action === "create" || claiming !== undefined && params.action === "update" && params.id === claiming) return;
      if (!runtime?.activeCount()) return;
      const resetIds = params.action === "reset" ? new Set(resetClosure(hooks.state().tasks, params.preset ?? "", params.step, params.run)) : undefined;
      const jobs = (runtime?.inspect() ?? []).filter(active).filter((job) => params.action === "clear" || job.todoId !== undefined && (resetIds ? resetIds.has(job.todoId) : job.todoId === params.id));
      for (const job of jobs) {
        const reported = (runtime?.reports(job.id) ?? 0) > 0;
        if (claimedBy(job, params, { adjusted, reported })) throw new Error(msg`任务 #${job.todoId} 关联活动 ${job.id}；内容修改先发送明确调整信息；未收到它的汇报前不能完成，删除／清空请先停止该 Agent`);
      }
    },
    afterTodoMutation(params: TodoParams) {
      if (params.action === 'reset') runtime?.invalidateTaskReports(resetClosure(hooks.state().tasks, params.preset ?? '', params.step, params.run));
      else if (params.action === 'update' && ['pending', 'in_progress'].includes(params.status ?? '') && params.id !== undefined) runtime?.invalidateTaskReports([params.id]);
      if (adjusted.size === 0) return;
      for (const job of runtime?.inspect() ?? []) if (job.todoId === params.id) adjusted.delete(job.id);
    },
  };
}
