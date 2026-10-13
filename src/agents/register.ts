import { randomUUID, createHash } from 'node:crypto';
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { configPaths } from "../shared/config.ts";
import { Text } from "@earendil-works/pi-tui";
import { AgentRuntime, AgentSendError, type JobSummary } from "./runtime.ts";
import { safeDiagnostic } from './diagnostics.ts';
import { CORE_TOOLS, CHILD_TOOLS, MAX_CHILD_TOOLS, THINKING_LEVELS, ProfileStore, type Profile } from "./profiles.ts";
import { contextArtifacts, taskContext } from "./context.ts";
import { resetClosure } from "../todos/presets.ts";
import { AgentNotices, type Notice } from "./notices.ts";
import { choose, readView, withMenuScope, type MenuCursor } from '../ui/menu.ts';
import { jobSummary, modelSummary, profileSummary, sendFailureLines, toolDisplay } from '../ui/presentation.ts';
import { clean, notify } from "../ui/render.ts";
import type { ClearScope, Todo, TodoParams, WorkflowState } from "../todos/state.ts";
import { workflowNamespace, readOnly } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';
import { AgentJournal, AGENTS_ENTRY_TYPE, foldAgentEntries } from './persistence.ts';

export const AGENTS_TYPE = AGENTS_ENTRY_TYPE;
interface Hooks { userPrompt?<T>(title: string, run: () => Promise<T>): Promise<T>; summary?(): boolean; setSummary?(visible: boolean, ctx: ExtensionContext): void; msg?: Translator; ui?(): boolean; state(): WorkflowState; mutate(params: TodoParams, ctx: ExtensionContext): unknown; paint(ctx: ExtensionContext): void; protected(): boolean; canWake?(): boolean; reserveWake?(ctx: ExtensionContext): boolean; pauseAuto?(ctx: ExtensionContext): void; resumeAuto?(): boolean; beforeWake?(ctx: ExtensionContext): void; compacting?(): boolean; holdingRecovery?(): boolean; branch?(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']> }
const active = (job: JobSummary) => ["starting", "running", "waiting"].includes(job.status);
const fingerprint = (state: WorkflowState, id?: number) => {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return '';
  const definition: unknown[] = [task.id, task.subject, task.description, task.blockedBy, task.metadata?.preset, task.metadata?.run, task.metadata?.step, task.metadata?.key];
  const artifacts = contextArtifacts(task);
  if (artifacts.length) definition.push({ artifacts }); // Preserve old signatures when no references were declared.
  return JSON.stringify(definition);
};
const idSchema = Type.String({ minLength: 1, maxLength: 80 });
const seconds = Type.Number({ exclusiveMinimum: 0, maximum: 86400 });
const text = Type.String({ minLength: 1 });

function availableModels(ctx: ExtensionContext) {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return ctx.modelRegistry.getAvailable()
    .map(({ provider, id, name, reasoning, contextWindow, maxTokens, input }) => ({ provider, id, name, reasoning, contextWindow, maxTokens, input: [...input] }))
    .sort((a, b) => compare(a.provider, b.provider) || compare(a.id, b.id));
}

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
      if (!job || job.dismissed) return;
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
    if (restoring) return;
    // A parent error wait holds reports; it must not discard them or wake before /retry.
    if (hooks.holdingRecovery?.()) { notices.add(notice); return; }
    if (paused || hooks.state().plan || hooks.canWake?.() === false) return;
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
    const ownGeneration = ++generation;
    clearDelivery(); clearActivity();
    original.clear(); adjusted.clear();
    await runtime?.shutdown();
    if (ownGeneration !== generation) return;
    context = ctx; runtime = undefined; profiles = undefined; error = undefined;
    // Restores never wake the model or resume processes. New explicit work re-enables delivery.
    paused = true;
    try {
      const loadedProfiles = new ProfileStore({ path: configPaths().profile, registry: ctx.modelRegistry, trustedTools: ["bash", "edit", "write", "powershell"] });
      // Profiles are loaded only when selected or queried; snapshots do not depend on that file.
      if (ownGeneration !== generation) return;
      profiles = loadedProfiles;
      const provider = pi.getFlag("dag-workflow-test-child-provider");
      const loadedRuntime = new AgentRuntime({ cwd: ctx.cwd, profiles, getInheritedModel: () => context?.model ? { provider: context.model.provider, id: context.model.id } : undefined,
        getInheritedThinking: () => pi.getThinkingLevel?.() ?? 'off', getInheritedTools: () => pi.getActiveTools?.() ?? CORE_TOOLS,
        onChanged: () => { if (runtime === loadedRuntime) onChanged(); },
        onNotice: (notice) => { if (runtime === loadedRuntime) onNotice(notice); },
        onActivity: () => { if (runtime === loadedRuntime) onActivity(); },
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
      runtime = loadedRuntime;
      // Fold the active branch once: version-1 snapshots replace, version-2 deltas continue.
      const folded = foldAgentEntries(hooks.branch?.(ctx) ?? ctx.sessionManager.getBranch());
      await loadedRuntime.importSummaries(folded.records, folded.nextId);
      if (ownGeneration !== generation) return;
      // The confirmed base is what was actually saved, before import normalizes metadata
      // and interrupts old live jobs. Persist those changes on the next real update.
      journal.hydrate(folded.records, runtime.nextId());
    } catch (cause) { if (ownGeneration === generation) { error = String(cause); notify(ctx, msg`Agent 恢复／配置失败：${error}；/agents reset 可明确清除运行记录`, "error"); } }
    finally { if (ownGeneration === generation) { restoring = false; hooks.paint(ctx); } }
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
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; });
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
  const renderResult = (result: { content: { type: string; text?: string }[]; details?: unknown; isError?: boolean }, _options: unknown, theme: ExtensionContext["ui"]["theme"]) => new Text(theme.fg(result.isError ? "error" : "text", toolDisplay(result.details, result.content.map((item) => item.text ?? "").join("\n"), msg)), 0, 0);
  const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data });
  /** AgentSendError carries structured direction/preflight details; ordinary causes keep safeDiagnostic. */
  const structuredFailure = (cause: unknown): Record<string, unknown> | undefined => cause instanceof AgentSendError ? cause.details as unknown as Record<string, unknown> : undefined;
  const diagnostic = (cause: unknown): string => { const details = structuredFailure(cause); return details ? sendFailureLines(details, msg).join('\n') : safeDiagnostic(String(cause)); };
  const fail = (cause: unknown) => { const details = structuredFailure(cause); const error = diagnostic(cause); return { isError: true, content: [{ type: 'text' as const, text: error }], details: details ? { ...details, error } : { error } }; };

  pi.registerTool({ name: "subagent_spawn", label: "Agent", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Start one isolated child, max8 active, no grandchildren. Give task inputs, scope and expected evidence. Configuration: parent model/thinking/supported active built-ins, then named profile's defined fields, then explicit model/thinking/tools/skills. tools replaces the list; skills omitted inherits the base, [] disables, paths replace it and require read (never added implicitly). Skills are local Markdown references, not auto-discovered or system prompts. No extensions/full parent history. todoId must be unblocked; context:true adds a task/prerequisite brief. resumeFrom starts a new attempt on the same Todo using its last actual configuration, without rereading its old profile; explicit profile:'inherit' resets to the current parent configuration. Inspect artifacts/side effects first. Returns jobId, status and actual model/thinking/tools/skills.",
    promptSnippet: "Use subagent_spawn to start one isolated child agent for independent work",
    promptGuidelines: [
      "Delegate work that is independent and verifiable, such as research or isolated edits; keep the critical path and final verification in the main session.",
      "Pass todoId to bind a job to its task. For new work, omitted/inherit profile starts from parent configuration; a named profile overrides defined fields, and explicit model/thinking/tools/skills win. resumeFrom defaults to the last actual configuration; profile:'inherit' explicitly resets to the current parent. Give the child a self-contained task with inputs, constraints and expected evidence. Returned work must be verified before completing a Todo.",
      "Give one child a serial chain (A then B then C) when its steps share context, bind its last task only if it is already unblocked; otherwise bind the first ready task, and ask it to send a short interim message as each step finishes. Start parallel children for independent branches, and dispatch a task only when its prerequisites are completed: never ask a child to wait on work another child is doing.",
      "Use context:true for a bounded task/prerequisite brief. Fragments include their position and step statuses; ordinary tasks include direct prerequisites and current report excerpts, not the parent's history.",
      "After child failure/interruption, inspect diagnostics and side effects; prefer resumeFrom on the same Todo, optionally with a discovered profile. Do not create a replacement Todo or blindly replay work. A user-stopped objective needs explicit allowance; cancelling one attempt does not cancel its Todo.",
    ],
    parameters: Type.Object({ task: text, resumeFrom: Type.Optional(idSchema), todoId: Type.Optional(Type.Integer({ minimum: 1 })), profile: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'New work defaults to parent; resume defaults to last actual configuration. inherit explicitly resets to current parent; otherwise a saved profile name' })), model: Type.Optional(Type.Object({ provider: text, id: text }, { additionalProperties: false, description: 'Explicit provider/id from subagent_inspect models:true; overrides the base model' })), thinking: Type.Optional(Type.Enum(THINKING_LEVELS, { type: 'string', description: 'Overrides the base thinking level' })), tools: Type.Optional(Type.Array(Type.Enum(CHILD_TOOLS, { type: 'string' }), { maxItems: MAX_CHILD_TOOLS, description: 'Replace the built-in tool list. Allowed: read, grep, find, ls, bash, edit, write, powershell; parent plugin tools such as ffgrep or recall are not accepted and names are never remapped. read is never added implicitly' })), skills: Type.Optional(Type.Array(text, { description: 'Omit to inherit base skills; [] disables; local Markdown paths replace. Requires read; no automatic discovery or system-prompt injection' })), timeout: Type.Optional(seconds), context: Type.Optional(Type.Boolean({ description: "Attach a bounded task/prerequisite brief; Todo metadata.artifacts can declare file references" })) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Dispatch aborted');
        const agent = ready(ctx);
        if (params.profile !== undefined && params.profile !== 'inherit') await profiles!.load();
        if (signal?.aborted) throw new Error('Dispatch aborted');
        const before = hooks.state();
        const previous = params.resumeFrom === undefined ? undefined : agent.inspect(params.resumeFrom)[0];
        const todoId = params.todoId ?? previous?.todoId;
        const task = before.tasks.find((item) => item.id === todoId);
        if (todoId !== undefined) {
          if (!task || task.status === "completed" || task.status === "deleted") throw new Error(msg("只能派发未完成的当前 Todo"));
          const { applyTodo } = await import('../todos/state.ts');
          applyTodo(before, { action: "update", id: task.id, status: "in_progress" }, msg); // Validate without claiming work on startup failure.
        }
        // Opt-in: the parent decides per dispatch, and only a bound task can carry a fragment brief.
        const context = params.context === true && task ? taskContext(task.id, before.tasks, agent.exportRecords()) : undefined;
        const ownGeneration = generation;
        paused = false; failedRound = false;
        const job = await agent.spawn({
          task: params.task,
          ...(todoId === undefined ? {} : { todoId, taskDefinition: createHash('sha256').update(fingerprint(before, todoId)).digest('hex') }),
          ...(params.resumeFrom === undefined ? {} : { resumeFrom: params.resumeFrom }),
          ...(params.profile === undefined ? {} : { profile: params.profile }),
          ...(params.model === undefined ? {} : { model: params.model }),
          ...(params.thinking === undefined ? {} : { thinking: params.thinking }),
          ...(params.tools === undefined ? {} : { tools: params.tools }),
          ...(params.skills === undefined ? {} : { skills: params.skills }),
          ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
          ...(context ? { context } : {}),
          ...(signal ? { signal } : {}),
        });
        if (signal?.aborted) { await agent.cancel(job.id); throw new Error('Dispatch aborted; child stopped'); }
        if (ownGeneration !== generation) throw new Error(msg("会话已切换，派发已停止"));
        original.set(job.id, fingerprint(before, todoId));
        if (task && !['failed', 'cancelled', 'interrupted'].includes(job.status)) {
          claiming = task.id;
          try { hooks.mutate({ action: "update", id: task.id, status: "in_progress" }, ctx); }
          finally { claiming = undefined; }
        }
        const ignored = job.ignoredInheritedTools ?? [];
        const result = reply({ jobId: job.id, status: job.status, model: job.model, thinking: job.thinking, tools: job.tools, skills: job.skills, ...(ignored.length ? { ignoredInheritedTools: ignored } : {}), ...(task ? { todoId: task.id, todoStatus: hooks.state().tasks.find((item) => item.id === task.id)?.status } : {}), ...(job.error ? { error: job.error } : {}), ...(job.failure ? { failure: job.failure } : {}), ...(job.resumeFrom ? { resumeFrom: job.resumeFrom } : {}) });
        return ['failed', 'cancelled', 'interrupted'].includes(job.status) ? { ...result, isError: true } : result;
      } catch (cause) { return fail(cause); }
    },
  });
  pi.registerTool({ name: "subagent_inspect", label: "Agents", namespace: workflowNamespace, annotations: readOnly, description: "Inspect child status or discover profiles/models. models:true returns available provider/id/name/reasoning and context limits; query searches provider/id/name, limit defaults to 20 (max100), offset defaults to 0; total and nextOffset paginate. Model discovery is exclusive with job/profile/output/wait fields; query/limit/offset require models:true. With output:true and jobId, collect output/question and todoStatus; timeout:0 is immediate. Default until:update waits up to 5s; until:finish up to 30s, max300s; after selects a newer reportVersion. Timeout/abort only ends waiting, not the child. Verify work yourself; do independent work instead of polling. profiles:'summary' lists profile settings; profile:NAME fetches one; profiles:true fetches all instructions. Directory queries cannot collect output.",
    promptSnippet: "Use subagent_inspect for child status, output and profile/model discovery",
    promptGuidelines: ["Discover profiles on demand: profiles:'summary' lists names/model/thinking/tools, profile:NAME returns one full profile with instructions, and profiles:true returns everything. Never guess a profile name or bulk-read instructions. Discover available models with models:true and optional query/limit/offset; use exact provider/id for spawn overrides."],
    parameters: Type.Object({ models: Type.Optional(Type.Boolean({ description: 'Available model catalog only; exclusive with job/profile/output/wait fields' })), query: Type.Optional(Type.String({ description: 'Case-insensitive provider/id/name search; models:true only' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Model page size; default 20; models:true only' })), offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Model page offset; default 0; models:true only' })), jobId: Type.Optional(idSchema), profiles: Type.Optional(Type.Union([Type.Boolean(), Type.Literal('summary')], { description: "Omit for jobs only; 'summary' lists profiles without instructions; true returns all profiles with full instructions" })), profile: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Return this one profile in full, including instructions; cannot be combined with profiles' })), output: Type.Optional(Type.Boolean({ description: 'Collect output or wait for a report; requires jobId. Default false: status only.' })), timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 300 })), until: Type.Optional(Type.Enum(['update', 'finish'] as const, { type: 'string' })), after: Type.Optional(Type.Integer({ minimum: 0, description: 'Wait for reports newer than this reportVersion; default captures the current version at call time' })) }, { additionalProperties: false }), executionMode: 'parallel', renderResult,
    async execute(_id, params, signal, _update, ctx) { try {
      if (params.models !== true && (params.query !== undefined || params.limit !== undefined || params.offset !== undefined)) throw new Error(msg('模型搜索与分页参数仅用于 models:true'));
      if (params.models === true) {
        if ([params.jobId, params.profile, params.profiles, params.output, params.timeout, params.until, params.after].some((value) => value !== undefined)) throw new Error(msg('models:true 不能与 Job、Profile、输出或等待参数组合'));
        const query = params.query?.trim().toLowerCase() ?? '';
        const models = availableModels(ctx).filter((model) => !query || [model.provider, model.id, model.name].some((value) => value.toLowerCase().includes(query)));
        const offset = params.offset ?? 0, limit = params.limit ?? 20;
        const page = models.slice(offset, offset + limit);
        return reply({ models: page, total: models.length, nextOffset: offset + page.length < models.length ? offset + page.length : null });
      }
      if (params.output === true && (!params.jobId || params.profile !== undefined || params.profiles === true || params.profiles === 'summary')) throw new Error(msg('output:true 需要 jobId，不能与 Profile 查询组合'));
      if (params.output !== true && (params.timeout !== undefined || params.until !== undefined || params.after !== undefined)) throw new Error(msg('等待参数仅用于 output:true；普通状态查询不等待'));
      if (params.profile !== undefined && (params.profiles === true || params.profiles === 'summary')) throw new Error(msg('profile 与 profiles 不能同时指定：profile 返回单个完整配置，profiles 返回列表摘要或全量'));
      const agent = ready(ctx, false);
      if (params.output === true) {
        const result = await agent.wait(params.jobId!, { ...(params.timeout === undefined ? {} : { timeout: params.timeout }), ...(signal ? { signal } : {}), ...(params.until === undefined ? {} : { until: params.until }), ...(params.after === undefined ? {} : { after: params.after }) });
        notices.drop(params.jobId!, result.reportVersion);
        if (['completed', 'failed'].includes(result.status) && result.reportDelivery === 'pending' && agent.markReportDelivered(params.jobId!)) result.reportDelivery = 'delivered';
        const todoStatus = todoStatusOf(result.todoId);
        return reply(todoStatus === undefined ? result : { ...result, todoStatus });
      }
      const directoryOnly = params.jobId === undefined && (params.profile !== undefined || params.profiles === 'summary');
      const jobs = directoryOnly ? undefined : agent.inspect(params.jobId).map((job) => { const todoStatus = todoStatusOf(job.todoId); return todoStatus === undefined ? job : { ...job, todoStatus }; });
      if (params.profile !== undefined || params.profiles === true || params.profiles === 'summary') await profiles!.load();
      const listed = params.profile !== undefined || params.profiles === true || params.profiles === 'summary' ? profiles!.list() : [];
      let payload: Record<string, unknown> = {};
      if (params.profile !== undefined) {
        const found = listed.find((item) => item.name === params.profile);
        if (!found) throw new Error(msg`未找到 Profile ${params.profile}`);
        payload = { profile: found };
      } else if (params.profiles === true) payload = { profiles: listed, profilePath: configPaths().profile };
      else if (params.profiles === 'summary') payload = { profiles: listed.map(({ instructions: _omitted, ...profile }) => profile) };
      return reply({ ...(jobs === undefined ? {} : { jobs, paused }), ...payload });
    } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_send", label: "Agent message", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Send direction to recipient jobId or answer requestId; exactly one target. Normal direction queues at the next safe boundary and does not stop a running tool. interrupt:true aborts the current local turn, clears old queued directions/questions, then resumes the same child context with the new direction. External actions may still run. Optional tools replaces the tool list only with recipient and interrupt:true, never requestId; pause the running original process, change tools, then continue its context. The main session decides under user authorization; a child's request is not authorization. Tool selection is not a sandbox. Delivery is accepted/queued/answered, not proof the child followed it.",
    promptSnippet: "Use subagent_send to direct a child job or answer its question", parameters: Type.Object({ recipient: Type.Optional(idSchema), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), message: text, tools: Type.Optional(Type.Array(Type.Enum(CHILD_TOOLS, { type: 'string' }), { maxItems: MAX_CHILD_TOOLS, description: 'Replace tools in the same child; requires recipient + interrupt:true, forbids requestId. Allowed built-in names only (no ffgrep/recall, no remapping); the main session decides under user authorization, never automatically from child requests, and this is not a sandbox' })), interrupt: Type.Optional(Type.Boolean({ description: 'recipient only: interrupt local turn, discard old queue, and continue the same child with this direction' })) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, signal, _update, ctx) { try {
      const agent = ready(ctx);
      if (!!params.recipient === !!params.requestId) throw new Error(msg("recipient 与 requestId 需且只能提供一个"));
      if (params.tools !== undefined && (!params.recipient || params.requestId !== undefined || params.interrupt !== true)) throw new Error(msg('调整 tools 需要 recipient 与 interrupt:true，不能使用 requestId'));
      const previousVersion = params.interrupt && params.recipient ? agent.inspect(params.recipient)[0]!.reportVersion : undefined;
      const result = await agent.send({ ...params, ...(signal ? { signal } : {}) });
      if (params.recipient) {
        adjusted.add(params.recipient);
        if (params.interrupt) notices.drop(params.recipient, previousVersion);
      }
      return reply(result);
    } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_cancel", label: "Stop Agent", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, description: "Stop a child. Optional remove discards its retained record and pending notices; never completes/deletes the Todo or reverts files.",
    promptSnippet: "Use subagent_cancel to stop one child job", parameters: Type.Object({ jobId: idSchema, remove: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential", renderResult,
    async execute(_id, params, _signal, _update, ctx) { try { const agent = ready(ctx, false); const job = agent.inspect(params.jobId)[0]!; if (params.remove || job.status !== 'completed' || job.reportDelivery !== 'pending') notices.drop(params.jobId); await agent.cancel(params.jobId, { ...(params.remove !== undefined ? { remove: params.remove } : {}) }); original.delete(params.jobId); adjusted.delete(params.jobId); return reply({ jobId: params.jobId, stopped: true, removed: params.remove ?? false }); } catch (cause) { return fail(cause); } },
  });

  async function modelsMenu(ctx: ExtensionContext) {
    const epoch = generation, cursor: MenuCursor = {}, current = () => epoch === generation;
    const owned = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
    const title = msg('模型目录');
    while (current()) {
      const models = availableModels(ctx);
      const selected = await owned(title, () => choose(ctx, title, models.map((model, index) => ({ id: String(index), label: model.name, value: model.provider, description: model.id })), { msg, cursor, searchable: true, isCurrent: current, lines: [msg('仅查看准确 provider/id；不切换主模型或保存 Profile')] }));
      if (!current() || selected === undefined) return;
      const model = models[Number(selected)];
      if (model) await owned(title, () => readView(ctx, title, modelSummary(model, msg).join('\n'), { msg, isCurrent: current }));
    }
  }
  async function profilesMenu(ctx: ExtensionContext) {
    const epoch = generation, cursor: MenuCursor = {};
    const current = () => epoch === generation;
    const owned = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
    while (current()) {
      await profiles!.load(); if (!current()) return;
      const all = profiles!.list(), title = msg('Profile');
      const selected = await owned(title, () => choose(ctx, title, all.map((profile) => ({ id: profile.name, label: profile.name, value: profile.model ? `${profile.model.provider}/${profile.model.id}` : msg('继承主会话'), description: profile.tools?.join(', ') ?? msg('继承主会话核心工具') })), { msg, cursor, searchable: true, isCurrent: current, lines: (item) => { const profile = all.find((value) => value.name === item.id); return profile ? profileSummary(profile, msg) : []; } }));
      if (!current() || selected === undefined) return;
      const profile = all.find((value) => value.name === selected); if (!profile) continue;
      const detail = msg`Profile ${profile.name}`;
      const action = await owned(detail, () => choose(ctx, detail, [{ id: 'read', label: msg('读取完整指令') }, { id: 'instructions', label: msg('编辑 Profile 指令') }, { id: 'skills', label: msg('编辑技能文件入口') }], { msg, isCurrent: current, lines: profileSummary(profile, msg) }));
      if (!current() || action === undefined) continue;
      if (action === 'read') await owned(detail, () => readView(ctx, detail, profileSummary(profile, msg).join('\n'), { msg, isCurrent: current }));
      if (action === 'instructions' || action === 'skills') {
        const title = action === 'instructions' ? msg('Profile 指令') : msg('技能文件：每行一个本地 Markdown 路径');
        const input = await owned(title, () => ctx.ui.editor(title, action === 'instructions' ? profile.instructions ?? '' : (profile.skills ?? []).join('\n')));
        if (!current() || input === undefined) continue;
        await profiles!.load(); if (!current()) return;
        if (JSON.stringify(profiles!.get(profile.name)) !== JSON.stringify(profile)) { notify(ctx, msg('Profile 已改变，未保存过期输入'), 'warning'); continue; }
        profiles!.set({ ...profile, ...(action === 'instructions' ? { instructions: input } : { skills: input.split('\n').map((value) => value.trim()).filter(Boolean) }) }); await profiles!.save();
      }
    }
  }
  async function agentsMenu(ctx: ExtensionContext) {
    const epoch = generation, cursor: MenuCursor = {}, current = () => epoch === generation;
    const owned = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
    let filter: 'attention' | 'all' = 'attention';
    while (current()) {
      const all = ready(ctx, false).exportSummaries();
      const rows = all.filter((job) => filter === 'all' || active(job) || job.reportDelivery === 'pending' || job.todoId !== undefined && todoStatusOf(job.todoId) !== 'completed' || ['failed', 'interrupted'].includes(job.status) && !job.dismissed);
      const title = msg('子 Agent');
      const selected = await owned(title, () => choose(ctx, title, rows.map((job) => ({ id: job.id, label: `${job.id} ${job.label ?? ''}`, value: statusLabel(job), description: job.todoId ? `Todo #${job.todoId}` : msg('独立任务') })), { msg, cursor, searchable: true, isCurrent: current, lines: (item) => { const job = runtime?.exportSummaries().find((job) => job.id === item.id); return job ? jobSummary({ ...job, ...(todoStatusOf(job.todoId) ? { todoStatus: todoStatusOf(job.todoId)! } : {}) }, msg) : []; }, actions: [{ id: 'models', label: msg('模型目录') }, { id: 'profiles', label: msg('Profile…') }, { id: 'filter', label: msg('筛选'), value: filter === 'attention' ? msg('需要关注') : msg('全部'), valueTone: 'dim' }, { id: 'summary', label: msg('显示摘要'), value: hooks.summary?.() !== false ? msg('开启') : msg('关闭'), valueTone: 'dim' }, { id: 'delivery', label: msg('结果自动唤醒'), value: paused ? msg('暂停') : msg('开启'), valueTone: 'dim' }] }));
      if (!current() || selected === undefined) return;
      if (selected === 'models') { await modelsMenu(ctx); continue; }
      if (selected === 'profiles') { await profilesMenu(ctx); continue; }
      if (selected === 'filter') { filter = filter === 'all' ? 'attention' : 'all'; cursor.page = 0; continue; }
      if (selected === 'summary') { hooks.setSummary?.(hooks.summary?.() === false, ctx); continue; }
      if (selected === 'delivery') { if (!paused) { paused = true; clearDelivery(); hooks.pauseAuto?.(ctx); } else if (!hooks.resumeAuto || hooks.resumeAuto()) { paused = false; failedRound = false; } else notify(ctx, msg('Goal 续跑仍暂停；先明确 /goal enable'), 'warning'); continue; }
      const job = runtime?.exportSummaries().find((job) => job.id === selected); if (!job) continue;
      const jobTitle = `${job.id} · ${job.label ?? job.profile}`;
      const action = await owned(jobTitle, () => choose(ctx, jobTitle, [
        { id: 'output', label: msg('阅读报告与诊断') },
        { id: 'send', label: msg('发送方向'), ...(!active(job) ? { disabledReason: msg('子 Agent 已停止') } : {}) },
        { id: 'answer', label: msg('回答问题'), ...(job.pendingRequests === 0 ? { disabledReason: msg('当前没有待答复问题') } : {}) },
        { id: 'cancel', label: msg('停止此子 Agent'), ...(!active(job) ? { disabledReason: msg('子 Agent 已停止') } : {}) },
        { id: 'remove', label: msg('移除记录'), tone: 'error' },
      ], { msg, isCurrent: current, lines: () => jobSummary(runtime?.exportSummaries().find((value) => value.id === job.id) ?? job, msg) }));
      if (!current() || action === undefined) continue;
      if (action === 'output') { const output = await ready(ctx, false).wait(job.id, { timeout: 0 }); if (current()) await owned(jobTitle, () => readView(ctx, jobTitle, jobSummary({ ...output, ...(todoStatusOf(output.todoId) ? { todoStatus: todoStatusOf(output.todoId)! } : {}) }, msg).join('\n'), { msg, isCurrent: current })); }
      if (action === 'send' || action === 'answer') {
        const requests = action === 'answer' ? (await ready(ctx, false).wait(job.id, { timeout: 0 })).requests : [];
        const question = requests.length ? requests[0] : undefined;
        const inputTitle = action === 'answer' ? msg('答复子 Agent') : msg('调整子 Agent 方向');
        const input = await owned(inputTitle, () => ctx.ui.editor(inputTitle, question?.message ?? ''));
        if (current() && input?.trim()) await ready(ctx).send({ ...(action === 'answer' && question ? { requestId: question.requestId } : { recipient: job.id }), message: input });
      }
      if (action === 'cancel' || action === 'remove') {
        const prompt = action === 'cancel' ? msg('停止子 Agent？') : msg('移除子 Agent 记录？');
        if (await owned(prompt, () => ctx.ui.confirm(prompt, msg('不撤销文件修改；移除会丢弃保留报告和记录。'))) && current()) { if (action === 'remove' || job.status !== 'completed' || job.reportDelivery !== 'pending') notices.drop(job.id); await ready(ctx, false).cancel(job.id, { remove: action === 'remove' }); }
      }
    }
  }
  pi.registerCommand("agents", { description: msg("子 Agent 状态／消息／取消与 Profile；也可直接描述需求"), getArgumentCompletions: (prefix) => completeArguments(prefix, completion), handler: async (args, ctx) => withMenuScope(ctx, async () => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify(msg('/agents list · wait jobId · send jobId 消息 · reply requestId 回答 · cancel/remove jobId · pause/resume · profiles · profile 名称 provider/model [thinking] [工具逗号列表] · unprofile 名称 · reset · Profile 的 instructions 写在配置文件里，作为该子任务的被动指导消息'), 'info'); return; }
      if (action === "reset") {
        const ownGeneration = generation;
        if (!ctx.hasUI || !await ctx.ui.confirm(msg("清除 Agent 运行记录？"), msg("先停止所有子 Agent，不撤销文件修改；历史记录保留。"))) return;
        if (ownGeneration !== generation) return;
        restoring = true; clearDelivery(); clearActivity(); await runtime?.shutdown();
        if (ownGeneration !== generation) return;
        pi.appendEntry(AGENTS_TYPE, { version: 1, jobs: [], nextId: runtime?.nextId() ?? 1 });
        journal.reset();
        await restore(ctx); return;
      }
      const agent = ready(ctx, false);
      if (!args.trim()) { await agentsMenu(ctx); return; }
      if (action === 'list') {
        const jobs = agent.exportSummaries();
        ctx.ui.notify(jobs.length ? jobs.map((job) => jobSummary({ ...job, ...(todoStatusOf(job.todoId) ? { todoStatus: todoStatusOf(job.todoId)! } : {}) }, msg).join('\n')).join('\n\n') : msg('暂无 Job'), 'info');
        return;
      }
      if (action === 'show' || action === 'hide') { hooks.setSummary?.(action === 'show', ctx); return; }
      if (action === "pause") { paused = true; clearDelivery(); hooks.pauseAuto?.(ctx); ctx.ui.notify(msg("已暂停结果自动唤醒；子 Agent 仍可能运行，停止请用 /agents cancel"), "info"); return; }
      if (action === "resume") { ready(ctx); if (hooks.resumeAuto ? !hooks.resumeAuto() : hooks.canWake?.() === false) throw new Error(msg("Goal 续跑仍暂停；先明确 /goal enable")); paused = false; failedRound = false; ctx.ui.notify(msg("后续新结果可自动唤醒；暂停期间旧报告仍可 /agents wait 查看"), "info"); return; }
      if (action === "cancel" || action === "remove") { if (parts.length !== 1) throw new Error(msg`/agents ${action} jobId`); const job = agent.inspect(parts[0]!)[0]!; if (action === 'remove' || job.status !== 'completed' || job.reportDelivery !== 'pending') notices.drop(parts[0]!); await agent.cancel(parts[0]!, { remove: action === "remove" }); return; }
      if (action === 'wait') { if (parts.length !== 1) throw new Error(msg('/agents wait jobId')); const epoch = generation; const job = await agent.wait(parts[0]!, { timeout: 0 }); if (epoch !== generation) return; ctx.ui.notify(jobSummary({ ...job, ...(todoStatusOf(job.todoId) ? { todoStatus: todoStatusOf(job.todoId)! } : {}) }, msg).join('\n'), 'info'); return; }
      if (action === "send" || action === "reply") { ready(ctx); const target = parts.shift(); if (!target || !parts.length) throw new Error(msg`/agents ${action} 编号 消息`); const interrupt = action === 'send' && parts[0] === '--interrupt'; if (interrupt) parts.shift(); if (!parts.length) throw new Error(msg('/agents send jobId [--interrupt] 消息')); await agent.send({ ...(action === "send" ? { recipient: target } : { requestId: target }), message: parts.join(" "), ...(interrupt ? { interrupt: true } : {}) }); if (action === "send") adjusted.add(target); return; }
      if (action === 'profiles') {
        await profiles!.load();
        const all = profiles!.list();
        ctx.ui.notify(all.length ? all.map((profile) => profileSummary(profile, msg).join('\n')).join('\n\n') : msg('未配置 Profile'), 'info');
        return;
      }
      if (action === "profile") {
        ready(ctx);
        const [name, model, thinking, tools] = parts;
        if (!name || !model || parts.length > 4 || !model.includes("/")) throw new Error(msg("/agents profile 名称 provider/model [thinking] [工具逗号列表]"));
        const split = model.indexOf("/");
        await profiles!.load();
        const previous = profiles!.get(name);
        profiles!.set({ name, model: { provider: model.slice(0, split), id: model.slice(split + 1) }, ...(thinking ? { thinking: thinking as NonNullable<Profile["thinking"]> } : {}), ...(tools ? { tools: tools.split(",") } : {}), ...(previous?.instructions ? { instructions: previous.instructions } : {}), ...(previous?.skills !== undefined ? { skills: previous.skills } : {}) });
        await profiles!.save(); ctx.ui.notify(msg`已保存 Profile ${name}`, "info"); return;
      }
      if (action === "unprofile") { ready(ctx); if (parts.length !== 1) throw new Error(msg("/agents unprofile 名称")); await profiles!.load(); profiles!.delete(parts[0]!); await profiles!.save(); return; }
      pi.sendUserMessage(msg`请管理当前子 Agent／Profile：${args}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    } catch (cause) { notify(ctx, diagnostic(cause), "error"); }
  }) });
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
      if (params.action === "list" || params.action === "get" || params.action === 'presets' || params.action === "create" || claiming !== undefined && params.action === "update" && params.id === claiming) return;
      if (!runtime?.activeCount()) return;
      const resetIds = params.action === "reset" ? new Set(resetClosure(hooks.state().tasks, params.preset ?? "", params.step, params.run)) : undefined;
      const jobs = (runtime?.inspect() ?? []).filter(active).filter((job) => params.action === "clear" || job.todoId !== undefined && (resetIds ? resetIds.has(job.todoId) : job.todoId === params.id));
      for (const job of jobs) {
        const reported = (runtime?.reports(job.id) ?? 0) > 0;
        if (claimedBy(job, params, { adjusted, reported })) throw new Error(msg`任务 #${job.todoId} 关联活动 ${job.id}；内容修改先发送明确调整信息；未收到它的汇报前不能完成，删除／清空请先停止该 Agent`);
      }
    },
    afterTodoMutation(params: TodoParams, before?: WorkflowState) {
      if (params.action === 'update' && params.id !== undefined && (params.subject !== undefined || params.description !== undefined || params.metadata !== undefined || Boolean(params.addBlockedBy?.length || params.removeBlockedBy?.length))) {
        const definition = fingerprint(hooks.state(), params.id);
        const changed = before ? fingerprint(before, params.id) !== definition : undefined;
        for (const job of runtime?.inspect() ?? []) if (job.todoId === params.id && active(job) && (changed ?? original.get(job.id) !== definition)) {
          runtime?.invalidateReports(job.id); notices.drop(job.id);
        }
        if (changed) runtime?.invalidateTaskReports([params.id]);
      }
      if (params.action === 'reset') runtime?.invalidateTaskReports(resetClosure(hooks.state().tasks, params.preset ?? '', params.step, params.run));
      else if (params.action === 'update' && ['pending', 'in_progress'].includes(params.status ?? '') && params.id !== undefined) runtime?.invalidateTaskReports([params.id], true);
      if (adjusted.size === 0) return;
      for (const job of runtime?.inspect() ?? []) if (job.todoId === params.id) adjusted.delete(job.id);
    },
  };
}
