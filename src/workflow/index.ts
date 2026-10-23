import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TODO_FILTERS, type TodoFilter, type WorkflowState } from '../shared/task-types.ts';
import type { TodoParams } from "../shared/task-schema.ts";
import type { attachTodos } from '../todos/index.ts';
import type { attachPlan } from '../plan/index.ts';
import type { registerAgents } from "../agents/commands/register.ts";
import type { registerGoal } from "../goal/commands/register.ts";
import type { registerRetry } from '../retry/commands/register.ts';
import type { createWorkflowView } from './commands/view.ts';
import { noFeatures, type Feature } from './domain/features.ts';
import { createWorkflowIO } from './io/session.ts';
import { createViewOwner } from './domain/view-owner.ts';
import { createPanelRegistry } from './commands/connect.ts';
import { loadConfig, loadDisplaySettings, loadLocale, writeConfig, type WorkflowConfig } from '../shared/config.ts';
import { backgroundProcess } from '../team/domain/launcher.ts';
import { choose, panelOptions } from '../shared/ui/menu.ts';
import { notify } from '../shared/terminal.ts';
import type { IconStyle } from '../shared/ui/symbols.ts';
import { createTranslator } from '../shared/i18n.ts';
import { glyph } from '../shared/ui/symbols.ts';

export function createWorkflow(initialApi: ExtensionAPI) {
  const msg = createTranslator(loadLocale()), io = createWorkflowIO();
  const modules = noFeatures(), attached = new Set<Feature>(), owners = new Map<Feature, ExtensionAPI>();
  const started = new WeakSet<object>(), restored = new WeakSet<object>(), stopped = new WeakSet<object>();
  let dispose = () => {}, generation = 0, unbindMenu: (() => void) | undefined, displayAttached = false;
  let todos: Awaited<ReturnType<typeof attachTodos>> | undefined, plan: Awaited<ReturnType<typeof attachPlan>> | undefined;
  let agents: ReturnType<typeof registerAgents> | undefined, goals: ReturnType<typeof registerGoal> | undefined, retry: ReturnType<typeof registerRetry> | undefined;
  let view: ReturnType<typeof createWorkflowView>;
  const userPrompts = new Set<string>();
  const panelLabels = { todos: 'Todos', plan: 'Plan', goal: 'Goal', agents: 'Agents', team: 'Team', retry: 'Retry', display: 'Display' };
  let display: { iconStyle: IconStyle; modelLabelWidth: number; language: 'auto' | 'en' | 'zh-CN' } = { iconStyle: 'nerd-font', modelLabelWidth: 18, language: 'auto' };
  const anyModule = () => Object.values(modules).some(Boolean);
  const panels = createPanelRegistry(Object.keys(panelLabels), id => id === 'display' ? anyModule() : modules[id as Feature] === true, () => generation, () => { const tasks = state().tasks.filter(task => task.status !== 'deleted'); return `(${tasks.filter(task => task.status === 'completed').length}/${tasks.length})`; });
  const api = () => [...owners.values()][0] ?? initialApi;
  const readBranch = io.branch;
  const configs = new Map<string, Promise<WorkflowConfig>>();
  const readConfig = (domain: 'goal' | 'plan') => { const loaded = configs.get(domain) ?? loadConfig(msg, domain); configs.set(domain, loaded); return loaded; };
  const activeAgents = () => modules.agents ? agents : undefined;
  const activeGoal = () => modules.goal ? goals : undefined;
  const activeRetry = () => modules.retry ? retry : undefined;
  const jobs = () => activeAgents()?.summaries() ?? [];
  const empty = (): WorkflowState => ({ version: 1, tasks: [], nextId: 1, plan: false, planTools: [], visible: true, view: 'list', treeStyle: 'paths' });
  const noTasks: WorkflowState['tasks'] = [];
  const state = (): WorkflowState => {
    const tasks = todos?.state() ?? empty(), planning = plan?.state();
    return { ...tasks, tasks: modules.todos && !todos?.protected() ? tasks.tasks : noTasks, plan: modules.plan && !!planning?.enabled, planTools: modules.plan ? planning!.tools : [] };
  };
  const views = createViewOwner({ api, branch: readBranch, paint });
  const visible = (feature: Feature) => modules[feature] && (feature === 'todos' ? (todos?.state().visible ?? true) : views.state().visible[feature] !== false);
  function paint(ctx: ExtensionContext) { view.paint(ctx); }
  const retryScope = () => { const goal = activeGoal()?.recoveryGoal(); return createHash('sha256').update(JSON.stringify([state().plan, goal ? [goal.id, goal.title, goal.description, goal.status, goal.modelPause, goal.autoresearch] : null])).digest('hex'); };
  function warnEphemeral(ctx: ExtensionContext) {
    const warning = io.ephemeral(ctx);
    if (warning) ctx.ui.notify(warning.file ? msg('Pi 尚未创建会话文件：发送一条消息后，当前工作流状态才会随会话保存。') : msg('当前为临时会话，退出后工作流状态不保存。'), 'warning');
  }
  function mutate(params: TodoParams, ctx: ExtensionContext, source: 'tool' | 'command' = 'tool') {
    if (!modules.todos) throw new Error(msg('未启用 Todos，不能使用任务关联'));
    return todos!.mutate(params, ctx, source);
  }
  /** The modules that really draw a section in the shared widget: Team has none, so it is not offered. */
  const widgetFeatures = ['todos', 'plan', 'goal', 'agents', 'retry'] as const;
  const widgetLabel = (feature: typeof widgetFeatures[number]) => ({ todos: msg('Todos 小组件'), plan: msg('Plan 小组件'), goal: msg('Goal 小组件'), agents: msg('Agents 小组件'), retry: msg('Retry 小组件') })[feature];
  /**
   * What hiding each section really costs, per module: the widget is one shared block, so the row has to name
   * that module's own business instead of a generic "tasks, Goal or subprocesses" sentence that is wrong for
   * Plan, Retry and the others.
   */
  /** The five filter names the `todo` command accepts, in one place so both surfaces read the same labels. */
  const filterLabel = (filter: string): string => filter === 'pending' ? msg('待执行') : filter === 'completed' ? msg('已完成') : filter === 'failed' ? msg('失败') : filter === 'cancelled' ? msg('取消') : msg('全部');
  const widgetNote = (feature: typeof widgetFeatures[number]) => ({
    todos: msg('只控制 Todos 区（任务清单与完成进度）在这个常驻小组件里的显示；任务本身、状态与执行不受影响。'),
    plan: msg('只控制 Plan 区（当前 Plan 模式与条目）的显示；Plan 是否启用、是否拦截写入不受影响。'),
    goal: msg('只控制 Goal 区（当前目标与轮次进度）的显示；目标焦点、续跑与预算不受影响。'),
    agents: msg('只控制 Agents 区（子 Agent 任务与状态）的显示；子进程的派发与运行不受影响。'),
    retry: msg('只控制 Retry 区（重试状态与尝试次数）的显示；Retry 的开关与重试行为不受影响。'),
  })[feature];
  async function displayMenu(ctx: ExtensionContext, nav: ReturnType<typeof panels.module>): Promise<void> {
    const epoch = generation;
    while (epoch === generation) {
      const items = [
        { id: 'icon-style', kind: 'cycle' as const, icon: glyph('display'), choices: [msg('Nerd Font'), msg('纯文本')], label: msg('图标风格'), value: display.iconStyle === 'plain' ? msg('纯文本') : msg('Nerd Font'), description: msg('切换后立即生效；纯文本模式省略图标。') },
        { id: 'language', kind: 'cycle' as const, icon: glyph('send'), choices: [msg('自动'), msg('简体中文'), 'English'], label: msg('语言'), value: display.language === 'en' ? 'English' : display.language === 'zh-CN' ? msg('简体中文') : msg('自动'), description: msg('保存后重新加载插件生效。') },
        { id: 'model-width', kind: 'input' as const, icon: glyph('models'), input: { title: msg('模型名最大宽度（6–18）'), value: String(display.modelLabelWidth), validate: (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 6 && Number(value) <= 18 ? undefined : msg('输入 6–18 的整数') }, run: async (value: unknown) => { const width = Number(String(value).trim()); if (!Number.isInteger(width) || width < 6 || width > 18) return; await writeConfig({ modelLabelWidth: width }, msg); display.modelLabelWidth = width; paint(ctx); }, label: msg('模型名最大宽度'), value: String(display.modelLabelWidth), description: msg('常驻小组件里的模型名按此上限截断。') },
        ...widgetFeatures.filter(feature => modules[feature]).map(feature => ({ id: `widget:${feature}`, kind: 'toggle' as const, icon: glyph('display'), label: widgetLabel(feature), checked: visible(feature), value: visible(feature) ? msg('开启') : msg('关闭'), description: widgetNote(feature) })),
        // The Todos view is part of the workflow state the `todo` command already owns, so these rows commit
        // through that same owner instead of keeping a second copy of the setting. Only Todos draws a list, so
        // the rows exist only while Todos is enabled.
        ...(modules.todos ? [
          { id: 'todos-view', kind: 'cycle' as const, icon: glyph('mode'), choices: [msg('列表'), msg('依赖图')], label: msg('Todos 视图'), value: todos!.state().view === 'dag' ? msg('依赖图') : msg('列表'), valueTone: 'muted' as const, description: msg('设置常驻小组件的 list/dag 视图，与 /todos view 共用显示状态；不会打开已隐藏的小组件。') + '\n' + msg('只改展示，不改任务定义或依赖。') },
          { id: 'todos-filter', kind: 'cycle' as const, icon: glyph('filter'), choices: TODO_FILTERS.map(filterLabel), label: msg('Todos 筛选'), value: filterLabel(todos!.state().filter ?? 'full'), valueTone: 'muted' as const, description: msg('设置常驻小组件的筛选：全部、待执行、已完成、失败、取消；不改变 Todos 面板的临时筛选。') + '\n' + msg('只改展示范围，不改任务状态。') },
          { id: 'todos-tree', kind: 'cycle' as const, icon: glyph('graph'), choices: [msg('路径树'), msg('平铺')], label: msg('Todos 树样式'), value: todos!.state().treeStyle === 'flat' ? msg('平铺') : msg('路径树'), valueTone: 'muted' as const, description: msg('设置列表的路径树或平铺样式，与 /todos paths、/todos flat 共用 treeStyle；不修改任务或依赖，也不打开已隐藏的小组件。'), },
        ] : []),
      ];
      const selected = await choose(ctx, msg('显示'), items, { msg, panel: { ...panelOptions(nav, { id: 'display', label: panelLabels.display }, 'root', []), single: true }, isCurrent: () => epoch === generation });
      if (epoch !== generation) return;
      if (selected === undefined) return;
      try {
        if (selected === 'icon-style') { const next: IconStyle = display.iconStyle === 'plain' ? 'nerd-font' : 'plain'; await writeConfig({ iconStyle: next }, msg); display.iconStyle = next; continue; }
        if (selected === 'language') { const order = ['auto', 'zh-CN', 'en'] as const; const next = order[(order.indexOf(display.language) + 1) % order.length]!; await writeConfig({ language: next }, msg); display.language = next; notify(ctx, msg('语言已保存；重新加载插件后生效。'), 'info'); continue; }
        if (selected === 'model-width') continue;
        if (selected.startsWith('widget:')) { const feature = selected.slice('widget:'.length) as Feature; setSummary(feature, !visible(feature), ctx); paint(ctx); continue; }
        // The three Todos rows write the same workflow state the `todo` command writes, through its own commit.
        if (selected === 'todos-view') { const current = todos!.state(); todos!.commit({ ...current, view: current.view === 'dag' ? 'list' : 'dag' }, ctx); paint(ctx); continue; }
        if (selected === 'todos-filter') { const current = todos!.state(); const at = TODO_FILTERS.indexOf(current.filter ?? 'full'); const filter = TODO_FILTERS[(at + 1) % TODO_FILTERS.length]!; todos!.commit({ ...current, filter }, ctx); paint(ctx); continue; }
        if (selected === 'todos-tree') { const current = todos!.state(); todos!.commit({ ...current, treeStyle: current.treeStyle === 'flat' ? 'paths' : 'flat' }, ctx); paint(ctx); continue; }
      } catch (cause) { notify(ctx, cause instanceof Error ? cause.message : String(cause), 'error'); }
    }
  }
  function setSummary(feature: Feature, show: boolean, ctx: ExtensionContext) {
    if (feature === 'todos') { todos!.commit({ ...todos!.state(), visible: show }, ctx); return; }
    views.set(feature, show, ctx);
  }
  const show = (ctx: ExtensionContext, kind: 'list' | 'dag', filter?: TodoFilter) => view.show(ctx, kind, filter);
  function lifecycle(owner: ExtensionAPI, feature: Feature) {
    owner.on('session_start', async (event, ctx) => {
      if (!started.has(event)) {
        started.add(event); Object.assign(modules, noFeatures()); owners.clear(); generation++; io.reset(); configs.clear(); view.invalidate();
        todos?.shutdown(); plan?.reset(); views.reset();
      }
      modules[feature] = true; owners.set(feature, owner);
      if (!unbindMenu) unbindMenu = view.bind(ctx);
      if (feature === 'todos') { todos!.restore(ctx); await todos!.restorePresets(ctx); }
      if (feature === 'plan') plan!.restore(ctx);
      views.restore(ctx); paint(ctx);
    });
    owner.on('session_tree', async (event, ctx) => {
      if (restored.has(event)) return;
      restored.add(event); generation++; io.invalidate(); configs.clear(); view.invalidate();
      if (modules.todos) todos!.restore(ctx);
      if (modules.plan) plan!.restore(ctx);
      views.restore(ctx);
      if (modules.todos) await todos!.restorePresets(ctx);
      paint(ctx);
    });
    owner.on('session_shutdown', (event, ctx) => {
      if (stopped.has(event)) return;
      stopped.add(event); generation++; unbindMenu?.(); unbindMenu = undefined; dispose(); owners.clear();
      todos?.shutdown(); plan?.reset(); views.reset(); view.invalidate();
      if (ctx.hasUI) ctx.ui.setWidget('pi-dag-workflow.todos', undefined);
    });
    if (feature !== 'plan') return;
    owner.on('before_agent_start', (event, ctx) => { const message = plan!.take(ctx, event); if (message) return { message }; });
    owner.on('turn_end', (event, ctx) => { const message = plan!.take(ctx, event); if (message) return { entries: [...event.entries, { type: 'custom_message' as const, ...message }] }; });
    owner.on('agent_before_settle', (event, ctx) => { const message = plan!.take(ctx, event); if (message) return { entries: [...event.entries, { type: 'custom_message' as const, ...message }] }; });
    owner.on('session_compact', (_event, ctx) => { if (modules.plan) plan!.compact(ctx); });
    owner.on('context', (event, ctx) => { const message = plan!.recover(event.messages, ctx, event); if (message) return { messages: [...event.messages, message] }; });
  }
  return {
    onDispose(off: () => void) { dispose = off; },
    async attach(feature: Feature | 'ui', owner: ExtensionAPI) {
      if (feature === 'ui') return;
      if (!displayAttached) {
        displayAttached = true;
        display = loadDisplaySettings();
        const nav = panels.module({ id: 'display', label: panelLabels.display }, () => display.iconStyle);
        nav.register(ctx => displayMenu(ctx, nav));
        owner.registerCommand?.('dag-display', { description: msg('显示：图标风格、语言、常驻小组件与模型名宽度'), handler: async (args: string, ctx: ExtensionContext) => {
          if (!args.trim() && ctx.mode === 'tui' && anyModule()) { await nav.open(ctx); return; }
          notify(ctx, msg`图标风格：${display.iconStyle} · 模型名宽度：${display.modelLabelWidth} · 语言：${(await loadConfig(msg)).language}`, 'info');
        } });
      }
      if (attached.has(feature)) throw new Error(msg`重复加载工作流模块：${feature}`);
      attached.add(feature);
      const { createWorkflowView } = await import('./commands/view.ts');
      view ??= createWorkflowView({ msg, state, todo: () => todos?.state() ?? empty(), modules: () => modules, preferences: views.state, visible, jobs, goalTitle: () => activeGoal()?.title(), retry: () => activeRetry()?.snapshot(), errors: () => ({ todoError: todos?.error(), planError: plan?.error() }), generation: () => generation, iconStyle: () => display.iconStyle, modelMax: () => display.modelLabelWidth });
      owner = io.resource(owner); lifecycle(owner, feature);
      const panel = panels.module({ id: feature, label: panelLabels[feature] }, () => display.iconStyle);
      if (feature === 'todos') {
        const { attachTodos } = await import('../todos/index.ts');
        todos = await attachTodos(owner, { msg, panel, api, branch: readBranch, plan: () => modules.plan ? plan!.state() : { enabled: false, tools: [] }, jobs, paint, saved: warnEphemeral,
          assertMutation: params => activeAgents()?.assertTodoMutation(params), afterMutation: (params, before) => activeAgents()?.afterTodoMutation(params, before),
          cleanupProtection: tasks => activeAgents()?.cleanupProtection(tasks) ?? new Set(), cleanupRecords: (scope, before, after) => activeAgents()?.cleanupRecords(scope, before, after) ?? 0,
          show, spawn: async (task, ctx) => { const agent = activeAgents(); if (!agent) throw new Error(msg('未启用 Agents，不能派发子任务')); await agent.spawn({ task: [task.subject, task.description].filter(Boolean).join('\n'), todoId: task.id }, undefined, ctx); }, retryStatus: () => activeRetry()?.snapshot(), userPrompt: async (title, run) => { userPrompts.add(title); try { return await run(); } finally { userPrompts.delete(title); } } });
      }
      if (feature === 'plan') {
        const { attachPlan } = await import('../plan/index.ts');
        plan = await attachPlan(owner, { msg, panel, api, branch: readBranch, todos: () => modules.todos, goal: () => modules.goal, paint, saved: warnEphemeral,
          modeChanged: () => { activeRetry()?.cancel(msg('模式已改变，旧计时已取消')); todos?.checkpoints.changed(); },
          state, loadConfig: () => readConfig('plan'), assertCanEnter: () => activeAgents()?.assertPlanEntry(), onEnter: ctx => activeGoal()?.pause(msg('进入 Plan'), ctx), summary: () => visible('plan'), setSummary: (show, ctx) => setSummary('plan', show, ctx) });
      }
      if (feature === 'agents') {
        const { registerAgents } = await import("../agents/commands/register.ts");
        agents = registerAgents(owner, { msg, panel, state, mutate, paint,
          validateDispatch: (before, id) => todos!.validateDispatch(before, id), resetTasks: params => todos!.resetTasks(params),
          userPrompt: async (title, run) => { userPrompts.add(title); try { return await run(); } finally { userPrompts.delete(title); } }, protected: () => plan?.protected() ?? false, ui: () => visible('agents'), branch: readBranch,
          summary: () => visible('agents'), setSummary: (show, ctx) => setSummary('agents', show, ctx),
          holdingRecovery: () => activeRetry()?.pending() ?? false,
          canWake: () => !activeRetry()?.pending() && (!modules.goal || (activeGoal()?.canWake() ?? false)),
          reserveWake: ctx => !activeRetry()?.pending() && (!modules.goal || (activeGoal()?.reserveWake(ctx, true) ?? false)),
          pauseAuto: ctx => activeGoal()?.pause(msg('用户暂停自动工作'), ctx), resumeAuto: () => !modules.goal || (activeGoal()?.resumeAgentReports() ?? false),
          beforeWake: ctx => { if (activeGoal()) activeGoal()!.beforeWake(ctx); else { todos?.checkpoints.beforeWake(ctx); plan?.beforeWake(ctx, message => api().sendMessage(message, { triggerTurn: false })); } },
          compacting: () => activeGoal()?.isCompacting() ?? false });
      }
      if (feature === 'goal') {
        const { registerGoal } = await import("../goal/commands/register.ts");
        goals = registerGoal(owner, { msg, panel, state, jobs, paint, protected: () => plan?.protected() ?? false, branch: readBranch, loadConfig: () => readConfig('goal'),
          pauseAgents: () => activeAgents()?.pauseAutomatic(), resumeAgents: () => activeAgents()?.resumeAutomatic(), onSaved: ctx => { activeRetry()?.refreshScope(ctx); warnEphemeral(ctx); },
          summary: () => visible('goal'), setSummary: (show, ctx) => setSummary('goal', show, ctx),
          retryEnabled: () => activeRetry()?.snapshot().enabled ?? false, retryConfigured: () => activeRetry()?.snapshot().intervals !== undefined, retryResumeAfterCompaction: () => activeRetry()?.snapshot().resumeAfterCompaction === true, cancelRecovery: () => activeRetry()?.cancel(), retryStatus: () => activeRetry()?.snapshot(),
          isUserPrompt: title => title !== undefined && (userPrompts.has(title) || activeRetry()?.isPrompt(title) === true),
          beforeWake: ctx => { todos?.checkpoints.beforeWake(ctx); plan?.beforeWake(ctx, message => api().sendMessage(message, { triggerTurn: false })); } });
      }
      if (feature === 'team') {
        const { registerTeam } = await import('../team/commands/register.ts');
        registerTeam(owner, {
          msg, panel,
          retrying: () => activeRetry()?.pending() ?? false,
          background: () => backgroundProcess(),
          // Liveness is probed, never assumed: a dead pid must read as offline, not as a phantom holder.
          alive: (candidate: number) => { try { process.kill(candidate, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === 'EPERM'; } },
        });
      }
      if (feature === 'retry') {
        const [{ registerRetry }, { safeDiagnostic }] = await Promise.all([import('../retry/commands/register.ts'), import("../agents/domain/diagnostics.ts")]);
        retry = registerRetry(owner, { msg, panel, diagnostic: safeDiagnostic, branch: readBranch, scope: retryScope, mode: () => state().plan ? 'plan' : activeGoal()?.recoveryGoal() ? 'goal' : 'normal', protected: () => plan?.protected() ?? false,
          failed: (ctx, waiting) => activeGoal()?.failedRequest(ctx, waiting), prepare: ctx => activeGoal()?.prepareErrorRecovery(ctx) ?? true, undoPrepare: ctx => activeGoal()?.undoErrorRecovery(ctx),
          beforeRetry: ctx => { if (activeGoal()) activeGoal()!.beforeWake(ctx); else { todos?.checkpoints.beforeWake(ctx); plan?.beforeWake(ctx, message => owner.sendMessage(message, { triggerTurn: false })); } },
          onChanged: paint, summary: () => visible('retry'), setSummary: (show, ctx) => setSummary('retry', show, ctx) });
        owner.on('session_start', (_event, ctx) => retry?.restore(ctx));
      }
    },
  };
}
