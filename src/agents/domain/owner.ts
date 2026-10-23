import { randomUUID, createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { configPaths, resolveChildExtensionPaths } from '../../shared/config.ts';
import { AgentRuntime, type JobSummary } from './runtime.ts';
import { CORE_TOOLS, CHILD_TOOLS, ProfileStore, readProfileExtensionPaths } from './profiles.ts';
import { contextArtifacts, taskContext } from './context.ts';
import { AgentNotices, type Notice } from '../io/notices.ts';
import { clean, notify } from '../../shared/terminal.ts';
import type { TodoParams } from '../../shared/task-schema.ts';
import type { ClearScope, Todo, WorkflowState } from '../../shared/task-types.ts';
import { workflowNamespace } from '../../shared/tool-info.ts';
import { AGENT_REPORT_MESSAGE } from '../../shared/message-types.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { AgentJournal, AGENTS_ENTRY_TYPE, foldAgentEntries } from '../io/persistence.ts';
import { agentsIO } from '../io/host.ts';
import type { AgentSpawnParams, AgentInspectParams, AgentSendParams, AgentCancelParams } from './schema.ts';

export const AGENTS_TYPE = AGENTS_ENTRY_TYPE;
function availableModels(ctx: ExtensionContext) {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return ctx.modelRegistry.getAvailable()
    // A partially described registry entry must not break the whole panel: only arrays are copied.
    .map(({ provider, id, name, reasoning, contextWindow, maxTokens, input }) => ({ provider, id, name, reasoning, contextWindow, maxTokens, input: Array.isArray(input) ? [...input] : [] }))
    .sort((a, b) => compare(a.provider, b.provider) || compare(a.id, b.id));
}
export interface Hooks { validateDispatch(state: WorkflowState, id: number): void | Promise<void>; resetTasks(params: TodoParams): readonly number[]; userPrompt?<T>(title: string, run: () => Promise<T>): Promise<T>; summary?(): boolean; setSummary?(visible: boolean, ctx: ExtensionContext): void; msg?: Translator; ui?(): boolean; state(): WorkflowState; mutate(params: TodoParams, ctx: ExtensionContext): unknown; paint(ctx: ExtensionContext): void; protected(): boolean; canWake?(): boolean; reserveWake?(ctx: ExtensionContext): boolean; pauseAuto?(ctx: ExtensionContext): void; resumeAuto?(): boolean; beforeWake?(ctx: ExtensionContext): void; compacting?(): boolean; holdingRecovery?(): boolean; branch?(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']> }
const active = (job: JobSummary) => ["starting", "running", "waiting"].includes(job.status);
const fingerprint = (state: WorkflowState, id?: number) => {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return '';
  const definition: unknown[] = [task.id, task.subject, task.description, task.blockedBy, task.metadata?.preset, task.metadata?.run, task.metadata?.step, task.metadata?.key];
  const artifacts = contextArtifacts(task);
  if (artifacts.length) definition.push({ artifacts }); // Preserve old signatures when no references were declared.
  return JSON.stringify(definition);
};
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

export function createAgentsOwner(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese, io = agentsIO(pi, workflowNamespace.name);
  const parentTools = io.parentTools;
  let runtime: AgentRuntime | undefined;
  let profiles: ProfileStore | undefined;
  let childTools: readonly string[] = CHILD_TOOLS;
  async function childEnvironment() {
    // Extensions are per-profile now; the menu trusts the union so profile tool picks validate.
    const extensions = await resolveChildExtensionPaths(await readProfileExtensionPaths(configPaths().profile), msg);
    const tools: { name: string; description: string; from: 'core' | 'extension' }[] = [];
    for (const tool of await parentTools()) {
      if (!tool.delegable) continue;
      const core = (CHILD_TOOLS as readonly string[]).includes(tool.name);
      if (core || tool.path && extensions.includes(tool.path)) tools.push({ name: tool.name, description: tool.description, from: core ? 'core' : 'extension' });
    }
    childTools = tools.map(tool => tool.name);
    return { extensions, tools };
  }
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
        ? task.status === 'completed' ? msg`\nTask #${task.id} 已完成，本报告仅供参考。`
          : job.taskReportStale ? msg`\nTask #${task.id} 当前状态：${task.status}；这是历史输出，不作为本轮验收依据。`
          : msg`\nTask #${task.id} 当前状态：${task.status}；核验后再更新，报告不会自动完成任务。`
        : '';
      // One meaningful hint instead of an empty completion notice that looks like a lost report.
      const body = notice.kind === 'completed' && job.reportEmpty ? msg('已结束·无报告') : notice.message;
      return msg`[${clean(job.id)}${job.todoId ? msg` / #${job.todoId}` : ""}${notice.requestId ? msg` / requestId=${clean(notice.requestId)}` : ""}] ${notice.kind}${stale}: ${body}${receipt}`;
    }, msg);
    return { content, terminalJobIds: [...terminalJobIds] };
  };
  // Boundary entries are drafts. Retain an uncommitted batch until the real request sees it.
  const reportPersisted = (ctx: ExtensionContext) => proposedReport && ctx.sessionManager.getBranch().some((entry) => entry.type === 'custom_message' && entry.customType === AGENT_REPORT_MESSAGE && (entry.details as { deliveryId?: string } | undefined)?.deliveryId === proposedReport!.id);
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
      try { hooks.beforeWake?.(context); reportAttempts++; io.sendMessage({ customType: AGENT_REPORT_MESSAGE, content: report.content, details: { deliveryId: report.id }, display: true }, { triggerTurn: true, deliverAs: "followUp" }); }
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
      if (payload) { io.appendEntry(AGENTS_TYPE, payload); journal.confirm(); }
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
      const loadedProfiles = new ProfileStore({ path: configPaths().profile, registry: ctx.modelRegistry, getTools: () => childTools });
      // Profiles are loaded only when selected or queried; snapshots do not depend on that file.
      if (ownGeneration !== generation) return;
      profiles = loadedProfiles;
      const provider = pi.getFlag("dag-workflow-test-child-provider");
      const loadedRuntime = new AgentRuntime({ cwd: ctx.cwd, profiles, getInheritedModel: () => context?.model ? { provider: context.model.provider, id: context.model.id } : undefined,
        getInheritedThinking: () => pi.getThinkingLevel?.() ?? 'off', getInheritedTools: () => pi.getActiveTools?.() ?? CORE_TOOLS,
        getChildExtensions: async (profile: { childExtensions?: string[] }) => resolveChildExtensionPaths(profile.childExtensions, msg),
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
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    (event.systemPromptOptions.promptGuidelines ??= []).push(
      'Delegate only independent, verifiable work to one-tier children; no grandchildren. Provide inputs, scope and expected evidence.',
      'Discover child tools with subagent_inspect tools:true; configured extension tools require an explicit tools list. Tool selection is not a sandbox or additional user authorization.',
      "The parent decides tool changes under existing user authorization. A child's request is not authorization; inspect interrupted work and external effects before resuming.",
      'If the assignment serves an existing unblocked Todo, pass todoId; otherwise omit it. Do not create a Todo merely to delegate. Keep serial steps with one child and parallelize independent work.',
      'Keep the critical path and final verification in the parent. After a child fails or is interrupted, inspect diagnostics and external side effects and prefer resumeFrom on the same Todo; do not create a replacement Todo or blindly replay work. A user-stopped objective needs explicit authorization to continue.',
      'Verify reports and artifacts before completing a Todo. Never guess profiles or models.',
    );
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
      return { entries: [...entries, { type: "custom_message" as const, customType: AGENT_REPORT_MESSAGE, content: report.content, details: { deliveryId: report.id }, display: true }], continue: true };
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

  /** Display-only projection for tool results: the linked Todo's current state, never persisted. */
  const todoStatusOf = (todoId?: number) => {
    if (todoId === undefined) return undefined;
    const task = hooks.state().tasks.find((item) => item.id === todoId);
    return task && task.status !== "deleted" ? task.status : undefined;
  };
  const reply = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data });
  return {
    ready, childEnvironment, parentTools, todoStatusOf, availableModels,
    profiles: () => profiles, runtime: () => runtime, generation: () => generation, paused: () => paused,
    dropNotice: (jobId: string, version?: number) => notices.drop(jobId, version),
    adjusted: (jobId: string) => adjusted.add(jobId),
    async reset(ctx: ExtensionContext, ownGeneration: number) {
        restoring = true; clearDelivery(); clearActivity(); await runtime?.shutdown();
        if (ownGeneration !== generation) return;
        io.appendEntry(AGENTS_TYPE, { version: 1, jobs: [], nextId: runtime?.nextId() ?? 1 });
        journal.reset();
        await restore(ctx);
    },
    async spawn(params: AgentSpawnParams, signal: AbortSignal | undefined, ctx: ExtensionContext) {
        if (signal?.aborted) throw new Error('Dispatch aborted');
        const agent = ready(ctx);
        if (params.profile !== undefined && params.profile !== 'inherit') { await childEnvironment(); await profiles!.load(); }
        if (signal?.aborted) throw new Error('Dispatch aborted');
        const before = hooks.state();
        const previous = params.resumeFrom === undefined ? undefined : agent.inspect(params.resumeFrom)[0];
        const todoId = params.todoId ?? previous?.todoId;
        const task = before.tasks.find((item) => item.id === todoId);
        if (todoId !== undefined) {
          if (!task || task.status === "completed" || task.status === "deleted") throw new Error(msg("只能派发未完成的当前 Task"));
          await hooks.validateDispatch(before, task.id); // Validate without claiming work on startup failure.
        }
        // Opt-in: the parent decides per dispatch, and only a bound task can carry a fragment brief.
        const context = params.context === true && task ? taskContext(task.id, before.tasks, agent.exportRecords()) : undefined;
        const ownGeneration = generation;
        paused = false; failedRound = false;
        // Refresh the trusted-tool union from the profile file so validation matches this dispatch.
        await childEnvironment();
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

    },
    async inspect(params: AgentInspectParams, signal: AbortSignal | undefined, ctx: ExtensionContext) {
      if (params.tools === true) {
        if ([params.models, params.jobId, params.profile, params.profiles, params.output, params.timeout, params.until, params.after, params.query, params.limit, params.offset].some(value => value !== undefined)) throw new Error(msg('tools:true 仅用于工具目录查询，不能与模型、Job、Profile 或输出参数组合'));
        return reply({ tools: (await childEnvironment()).tools });
      }
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
      if (params.profile !== undefined || params.profiles === true || params.profiles === 'summary') { await childEnvironment(); await profiles!.load(); }
      const listed = params.profile !== undefined || params.profiles === true || params.profiles === 'summary' ? profiles!.list() : [];
      let payload: Record<string, unknown> = {};
      if (params.profile !== undefined) {
        const found = listed.find((item) => item.name === params.profile);
        if (!found) throw new Error(msg`未找到 Profile ${params.profile}`);
        payload = { profile: found };
      } else if (params.profiles === true) payload = { profiles: listed, profilePath: configPaths().profile };
      else if (params.profiles === 'summary') payload = { profiles: listed.map(({ instructions: _omitted, ...profile }) => profile) };
      return reply({ ...(jobs === undefined ? {} : { jobs, paused }), ...payload });

    },
    async send(params: AgentSendParams, signal: AbortSignal | undefined, ctx: ExtensionContext) {
      const agent = ready(ctx);
      if (params.tools !== undefined) await childEnvironment();
      if (!!params.recipient === !!params.requestId) throw new Error(msg("recipient 与 requestId 需且只能提供一个"));
      if (params.tools !== undefined && (!params.recipient || params.requestId !== undefined || params.interrupt !== true)) throw new Error(msg('调整 tools 需要 recipient 与 interrupt:true，不能使用 requestId'));
      const previousVersion = params.interrupt && params.recipient ? agent.inspect(params.recipient)[0]!.reportVersion : undefined;
      const result = await agent.send({ ...params, ...(signal ? { signal } : {}) });
      if (params.recipient) {
        adjusted.add(params.recipient);
        if (params.interrupt) notices.drop(params.recipient, previousVersion);
      }
      return reply(result);

    },
    async cancel(params: AgentCancelParams, _signal: AbortSignal | undefined, ctx: ExtensionContext) { const agent = ready(ctx, false); const job = agent.inspect(params.jobId)[0]!; if (params.remove || job.status !== 'completed' || job.reportDelivery !== 'pending') notices.drop(params.jobId); await agent.cancel(params.jobId, { ...(params.remove !== undefined ? { remove: params.remove } : {}) }); original.delete(params.jobId); adjusted.delete(params.jobId); return reply({ jobId: params.jobId, stopped: true, removed: params.remove ?? false });
    },
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
      const resetIds = params.action === "reset" ? new Set(hooks.resetTasks(params)) : undefined;
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
      if (params.action === 'reset') runtime?.invalidateTaskReports(hooks.resetTasks(params));
      else if (params.action === 'update' && ['pending', 'in_progress'].includes(params.status ?? '') && params.id !== undefined) runtime?.invalidateTaskReports([params.id], true);
      if (adjusted.size === 0) return;
      for (const job of runtime?.inspect() ?? []) if (job.todoId === params.id) adjusted.delete(job.id);
    },
  };
}
