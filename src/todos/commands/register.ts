import { translatedTaskStatusLabels as statusLabel } from '../../shared/state-types.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { CHECKPOINT_RULE } from './checkpoints.ts';
import type { TodoResult } from "../domain/state.ts";
import { TodoParamsSchema, type TodoParams } from "../../shared/task-schema.ts";
import { TODO_FILTERS, type ClearScope, type TodoFilter, type Todo, type WorkflowState } from "../../shared/task-types.ts";
import type { Preset } from '../domain/presets.ts';
import { choose, readView, withMenuScope, panelOptions, panelInput, panelEdit, panelConfirm, type MenuCursor, type PanelNavigation } from '../../shared/ui/menu.ts';
import { todoSummary, toolDisplay } from '../../shared/ui/presentation.ts';
import { filteredView } from '../../shared/ui/filter.ts';
import { renderDag, renderTasks, renderTaskTree } from "../../shared/ui/render.ts";
import { clean, notify } from "../../shared/terminal.ts";
import type { AgentView } from "../../shared/agent-view.ts";
import { workflowNamespace, sessionMutation } from '../../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../../shared/completion.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { glyph } from '../../shared/ui/symbols.ts';

interface Hooks { spawn?(task: Todo, ctx: ExtensionContext): Promise<void>; panel?: PanelNavigation; jobs?(): readonly AgentView[]; previewClear?(scope: ClearScope): string; msg?: Translator; state(): WorkflowState; protected(): boolean; mutate(params: TodoParams, ctx: ExtensionContext, source?: 'tool' | 'command'): TodoResult; commit(next: WorkflowState, ctx: ExtensionContext): void; reset(ctx: ExtensionContext): void; show(ctx: ExtensionContext, view: 'list' | 'dag', filter?: TodoFilter): Promise<void>; userPrompt?<T>(title: string, run: () => Promise<T>): Promise<T>; presets?(): Preset[]; refreshPresets?(): Promise<void>; retryStatus?(): unknown }
const asId = (text?: string, msg: Translator = chinese): number => {
  if (!text || !/^#?[1-9]\d*$/.test(text)) throw new Error(msg('请给出任务编号，例如 #2'));
  return Number(text.replace(/^#/, ''));
};
/** Register this resource's tools/commands using the runtime-shared state. */
export function registerTodos(pi: ExtensionAPI, hooks: Hooks): void {
  const { mutate, commit, show } = hooks;
  const msg = hooks.msg ?? chinese;
  const dialogs = hooks.panel ?? { input: panelInput, edit: panelEdit, confirm: panelConfirm };
  let sessionEpoch = 0;
  let clearPrompt: { epoch: number } | undefined;
  const resetPrompt = () => { sessionEpoch++; clearPrompt = undefined; };
  pi.on('session_start', resetPrompt); pi.on('session_tree', resetPrompt); pi.on('session_shutdown', resetPrompt);
  const completion: CompletionSpec = {
    actions: [
      { action: 'add', description: msg('新建任务：add 标题 [--after 1,2]') },
      { action: 'start', description: msg('开始任务：start #编号') },
      { action: 'done', description: msg('完成任务：done #编号') },
      { action: 'pending', description: msg('回到待执行：pending #编号') },
      { action: 'failed', description: msg('标记失败：failed #编号') },
      { action: 'cancelled', description: msg('标记取消：cancelled #编号') },
      { action: 'delete', description: msg('删除任务：delete #编号') },
      { action: 'edit', description: msg('修改标题：edit #编号 新标题') },
      { action: 'list', description: msg('查看任务列表') },
      { action: 'view', description: msg('切换视图：view list/dag [full/pending/completed/failed/cancelled]') },
      { action: 'paths', description: msg('按路径树展示') },
      { action: 'flat', description: msg('按平铺展示') },
      { action: 'show', description: msg('显示任务面板') },
      { action: 'hide', description: msg('隐藏任务面板') },
      { action: 'clear', description: msg('清理记录：clear completed/closed/all，省略打开菜单') },
      { action: 'presets', description: msg('查看片段预设：presets') },
      { action: 'apply', description: msg('套用片段：apply 名称 [键=值 ...]') },
      { action: 'reset', description: msg('重开片段：reset 名称 [步骤键]') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
    subActions: {
      view: [
        { action: 'list', description: msg('列表视图') },
        { action: 'dag', description: msg('依赖图视图') },
      ],
      clear: [
        { action: 'completed', description: msg('清理已完成记录') },
        { action: 'closed', description: msg('清理已完成／失败／取消记录') },
        { action: 'all', description: msg('清空全部可清理记录') },
      ],
    },
    freeText: ['add'],
    arguments: (tokens, trailing) => {
      if (tokens[0] !== 'view' || !['list', 'dag'].includes(tokens[1] ?? '') || tokens.length < 2 || tokens.length > 3 || tokens.length === 3 && trailing) return null;
      const typed = tokens.length === 3 ? tokens[2]! : '';
      if (tokens.length === 2 && !trailing) return null;
      return TODO_FILTERS.filter((name) => name.startsWith(typed)).map((name) => ({ token: `view ${tokens[1]} ${name}`, label: name }));
    },
    tokens: (action) => {
      if (action === 'list') return TODO_FILTERS.map((name) => ({ token: name, label: name }));
      if (['apply', 'reset'].includes(action)) return (hooks.presets?.() ?? []).map((preset) => ({ token: preset.name, label: preset.name, ...(preset.description ? { description: preset.description } : {}) }));
      if (!['start', 'done', 'pending', 'failed', 'cancelled', 'delete', 'edit'].includes(action)) return null;
      const tasks = hooks.state().tasks;
      const keepCompleted = action === 'delete' || action === 'edit';
      return tasks
        .filter((task) => task.status !== 'deleted' && (keepCompleted || task.status !== 'completed'))
        .map((task) => ({ token: `#${task.id}`, label: `#${task.id} ${task.subject}`, description: statusLabel(msg)[task.status] }));
    },
  };
  const panel = (id: string) => panelOptions(hooks.panel, { id: 'todos', label: 'Todos' }, `todos:${id}`);
  async function dagPanel(ctx: ExtensionContext, filter = hooks.state().filter ?? 'full', selected?: readonly Todo[]) {
    const epoch = sessionEpoch;
    await readView(ctx, 'Todos · DAG', renderDag(selected ? { ...hooks.state(), tasks: [...selected] } : hooks.state(), Math.max(16, (process.stdout.columns ?? 80) - 8), ctx.ui.theme, undefined, hooks.jobs?.() ?? [], { msg, filter }).join('\n') || msg('暂无任务'), { msg, panel: panel('dag'), isCurrent: () => epoch === sessionEpoch && !hooks.panel?.requested() });
  }
  async function tasksMenu(ctx: ExtensionContext, initialClearScope: ClearScope = 'completed') {
    const epoch = sessionEpoch, cursor: MenuCursor = {}, detailCursor: MenuCursor = {};
    const current = () => epoch === sessionEpoch && !hooks.panel?.requested();
    await hooks.refreshPresets?.(); if (!current()) return;
    let selectedFilter: TodoFilter | 'in_progress' = hooks.state().filter ?? 'full';
    let clearScope: ClearScope = initialClearScope;
    const presetVariables = new Map<string, Record<string, string>>();
    const taskFilters = ['full', 'pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
    const owned = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
    const targets = new Map<string, { task: Todo; action: string }>();
    const actions = (task: Todo) => {
      const blocked = task.blockedBy.filter(id => hooks.state().tasks.find(value => value.id === id)?.status !== 'completed');
      // A prerequisite that is gone (deleted or never created) can never complete: say so instead of
      // leaving the row looking like something that will eventually unblock.
      const gone = blocked.filter(id => { const value = hooks.state().tasks.find(task => task.id === id); return !value || value.status === 'deleted'; });
      const waiting = blocked.filter(id => !gone.includes(id));
      const startReason = hooks.state().plan ? msg('Plan 模式为只读；先 /plan off 再执行。') : task.status === 'completed' ? msg('已完成任务不能重开；如需返工，请新建任务。') : gone.length ? msg`前置任务已删除或不存在：${gone.map(id => `#${id}`).join(', ')}；这条依赖无法满足：让模型用 removeBlockedBy 去掉它，或重建此任务` : waiting.length ? msg`前置任务尚未完成：${waiting.map(id => `#${id}`).join(', ')}` : undefined;
      return [
      { id: 'complete', label: msg('核验后完成任务'), icon: glyph('complete'), ...(task.status === 'completed' ? { disabledReason: msg('任务已完成') } : startReason ? { disabledReason: startReason } : {}) },
      { id: 'edit', kind: 'input' as const, input: { title: msg('任务要求'), value: task.description ?? '', multiline: true, validate: (value: string) => Buffer.byteLength(value) <= 8192 ? undefined : msg('任务要求最多 8 KiB。') }, label: msg('编辑任务要求'), icon: glyph('edit') },
      { id: 'spawn', label: msg('指派子 Agent'), icon: glyph('new'), ...(!hooks.spawn || hooks.panel?.tabs().some(tab => tab.id === 'agents') === false ? { disabledReason: msg('未启用 Agents，不能派发。') } : startReason ? { disabledReason: startReason } : {}) },
      { id: 'delete', label: msg('删除任务'), icon: glyph('delete'), destructive: true, confirmation: { title: msg`删除 Task #${task.id}：${task.subject}？`, consequences: msg('删除这条任务记录；不删除项目文件，也不撤销已执行的工作。'), action: msg('删除') } },
      { id: 'start', label: msg('开始任务'), icon: glyph('toggle'), ...(startReason ? { disabledReason: startReason } : {}) },
      { id: 'read', label: msg('读取完整要求'), icon: glyph('summary') },
      { id: 'pending', label: msg('回到待执行'), icon: glyph('toggle'), ...(task.status === 'pending' ? { disabledReason: msg('已经是待执行') } : task.status === 'completed' ? { disabledReason: msg('已完成任务不能重开；如需返工，请新建任务。') } : {}) },
      { id: 'failed', label: msg('标记失败'), icon: glyph('stop'), ...(task.status === 'failed' ? { disabledReason: msg('已经标记失败') } : task.status === 'completed' ? { disabledReason: msg('已完成任务不能改为失败。') } : {}) },
      { id: 'cancelled', label: msg('标记取消'), icon: glyph('stop'), ...(task.status === 'cancelled' ? { disabledReason: msg('已经标记取消') } : task.status === 'completed' ? { disabledReason: msg('已完成任务不能改为取消。') } : {}) },
    ].map(row => { const id = `${task.id}/${row.id}`; targets.set(id, { task, action: row.id }); return { ...row, id, kind: row.kind ?? 'action' as const, description: task.subject + '\n' + (row.id === 'delete' ? msg('删除任务记录，不删除项目文件。再按一次确认。') : row.id === 'spawn' ? msg('派发绑定这个 Task 的子 Agent；报告返回不代表任务完成。') : row.id === 'complete' ? msg('仅在核验需求与结果后完成；不会替你验证工作。') : row.id === 'edit' ? msg('编辑此任务的完整要求；Esc 取消，不保存。') : row.id === 'read' ? msg('只读查看完整要求、依赖与引用；不会更改任务状态。') : row.id === 'start' ? msg('标记为进行中；不会自动执行任务或派发子 Agent。') : msg('只修改这条任务的记录，不撤销已有文件修改。')) }; });
    };
    while (current()) {
      targets.clear();
      const title = msg('任务清单');
      const state = hooks.state();
      const base = filteredView(state.tasks, selectedFilter === 'in_progress' ? 'full' : selectedFilter, hooks.jobs?.() ?? []).tasks;
      const list = selectedFilter === 'in_progress' || selectedFilter === 'pending' ? base.filter(task => task.status === selectedFilter) : base;
      const presets = hooks.presets?.() ?? [];
      const clearScopeLabel = clearScope === 'completed' ? msg('仅已完成') : clearScope === 'closed' ? msg('已完成／失败／取消') : msg('全部记录');
      const rootPanel = { ...panel('root'), single: false, upper: (width: number, query: string) => {
        // The tree is the panel's content: read the tasks again on every render so a status change does not
        // need a keystroke. A protected/restoring state cannot answer, so the snapshot stays as the fallback.
        let live = list, liveState = state;
        try {
          const now = hooks.state();
          const base = filteredView(now.tasks, selectedFilter === 'in_progress' ? 'full' : selectedFilter, hooks.jobs?.() ?? []).tasks;
          liveState = now;
          live = selectedFilter === 'in_progress' || selectedFilter === 'pending' ? base.filter(task => task.status === selectedFilter) : base;
        } catch { /* keep the snapshot */ }
        const matching = query ? live.filter(task => [String(task.id), task.subject, task.description].some(value => value?.toLowerCase().includes(query.toLowerCase()))) : live;
        const tree = renderTaskTree({ ...liveState, tasks: [...matching] }, width, { maxRows: Infinity, theme: ctx.ui.theme, jobs: hooks.jobs?.() ?? [], msg, filter: 'full' });
        const taskRows = tree.rows.map((row, index) => ({ id: row.taskId === undefined ? `tail:${index}` : String(row.taskId), label: row.taskId === undefined ? row.text : matching.find(task => task.id === row.taskId)!.subject, text: row.text, kind: row.taskId === undefined ? 'tail' as const : 'entity' as const, description: row.taskId === undefined ? '' : todoSummary(matching.find(task => task.id === row.taskId)!, msg).slice(0, 2).join('\n'), ...(row.taskId === undefined ? {} : { children: actions(matching.find(task => task.id === row.taskId)!), prefix: (stripTerminalSequences(row.text).match(/^([│ ├└─]+)#/)?.[1] ?? '').replace(/├─ $/, '│  ').replace(/└─ $/, '   ') + '  ' }) }));
        const presetRows = presets.filter(preset => !query || preset.name.toLowerCase().includes(query.toLowerCase()) || preset.description?.toLowerCase().includes(query.toLowerCase())).map(preset => ({ id: `preset:${preset.name}`, kind: 'entity' as const, label: preset.name, icon: glyph('presets'), value: msg`${preset.steps.length} 步`, valueTone: 'muted' as const, description: preset.description ?? '', children: [
          ...[...new Set(preset.steps.flatMap(step => [step.subject, step.description ?? ''].flatMap(text => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]!))))].map(name => ({ id: `preset:${preset.name}/var/${name}`, kind: 'input' as const, icon: glyph('edit'), label: name, value: presetVariables.get(preset.name)?.[name] ?? msg('未填写'), input: { title: name, value: presetVariables.get(preset.name)?.[name] ?? '' }, description: msg('应用片段时替换同名变量；这里只编辑本次草稿。'), run: (value: unknown) => { const vars: Record<string, string> = presetVariables.get(preset.name) ?? Object.create(null); vars[name] = String(value); presetVariables.set(preset.name, vars); } })),
          { id: `preset:${preset.name}/reset`, kind: 'action' as const, icon: glyph('autoresearch'), label: msg('重开片段'), destructive: true, confirmation: { title: msg`重开片段 ${preset.name}？`, consequences: msg('重开最近一轮片段及依赖它的任务；不创建另一份任务库，不撤销文件修改。'), action: msg('重开') }, description: msg('重开最近一轮片段及依赖它的任务，不创建另一份任务库。') },
          { id: `preset:${preset.name}/apply`, kind: 'action' as const, icon: glyph('toggle'), label: msg('应用片段'), description: msg('按上面填写的变量套用这个片段的步骤；创建任务，不改已有任务状态。') },
          { id: `preset:${preset.name}/read`, kind: 'action' as const, icon: glyph('summary'), label: msg('查看步骤'), description: msg('只读查看片段的全部步骤与变量；不创建任务。') },
        ] }));
        return { title: tree.title || 'Todos', rows: [
          { id: 'group:tasks', kind: 'heading' as const, collapsible: true, groupCount: taskRows.length, label: msg('任务树'), description: msg('Enter 或 l 展开，h 收起。') },
          ...taskRows,
          { id: 'group:presets', kind: 'heading' as const, collapsible: true, groupCount: presetRows.length, label: msg('Task 片段'), description: msg('Enter 或 l 展开，h 收起。') },
          ...presetRows,
        ] };
      } };
      const filterLabel = selectedFilter === 'full' ? msg('全部') : selectedFilter === 'pending' ? msg('待执行') : selectedFilter === 'in_progress' ? msg('进行中') : statusLabel(msg)[selectedFilter];
      const items = ctx.mode === 'tui' ? [] : [
        ...rootPanel.upper(76, '').rows.filter(row => list.some(task => String(task.id) === row.id)).map(row => ({ id: row.id, label: ('text' in row && row.text) || row.label, description: ('description' in row && row.description) || '' })),
        // Text clients keep the fragment entries, mirroring how /agents keeps its Profile row.
        ...presets.map(preset => ({ id: `preset:${preset.name}`, label: preset.name, description: preset.description ?? '' })),
        ...presets.map(preset => ({ id: `preset:${preset.name}/apply`, label: msg`应用片段：${preset.name}`, description: msg('套用片段步骤，与面板里的「应用片段」一致。') })),
      ];
      const selected = await owned(title, () => choose(ctx, title, items, { msg, refreshInterval: 1000, panel: rootPanel, cursor, searchable: true, isCurrent: current, lines: (item) => { const task = hooks.state().tasks.find((value) => String(value.id) === item.id); return task ? todoSummary(task, msg) : []; }, actions: [{ id: 'add', kind: 'input' as const, input: { title: msg('任务标题'), validate: value => value.trim() && Array.from(value.trim()).length <= 60 ? undefined : msg('标题需为 1–60 个字符；详细指示请写 description') }, label: msg('新建任务'), icon: glyph('new'), description: msg('行内填写标题后创建待执行任务。') + '\n' + msg('Enter 提交；Esc 取消，不创建任务。'), run: value => { const subject = String(value).trim(); if (current() && subject) mutate({ action: 'create', subject }, ctx, 'command'); } }, { id: 'filter', kind: 'cycle', icon: glyph('filter'), choices: [msg('全部'), msg('待执行'), msg('进行中'), msg('已完成'), msg('失败'), msg('取消')], run: value => { selectedFilter = taskFilters[[msg('全部'), msg('待执行'), msg('进行中'), msg('已完成'), msg('失败'), msg('取消')].indexOf(String(value))]!; }, label: msg('筛选'), value: filterLabel, valueTone: 'muted', description: msg('筛选显示的任务范围；不修改任务状态。') + '\n' + msg('仅筛选当前面板；常驻小组件的筛选在 Display 中设置。') }, { id: 'view', kind: 'cycle' as const, icon: glyph('mode'), choices: [msg('路径树'), msg('平铺')], run: value => commit({ ...hooks.state(), treeStyle: value === msg('平铺') ? 'flat' : 'paths' }, ctx), label: msg('树样式'), value: state.treeStyle === 'flat' ? msg('平铺') : msg('路径树'), valueTone: 'muted', description: msg('切换路径树与平铺两种显示。') + '\n' + msg('只改变展示，不修改任务定义或依赖。') }, { id: 'graph', kind: 'directory', icon: glyph('graph'), label: msg('查看依赖图'), description: msg('查看当前任务的依赖关系。') + '\n' + msg('只读查看；返回后保留当前筛选和光标。') }, { id: 'clear-scope', kind: 'cycle' as const, icon: glyph('settings'), choices: [msg('仅已完成'), msg('已完成／失败／取消'), msg('全部记录')], run: value => { clearScope = value === msg('仅已完成') ? 'completed' : value === msg('已完成／失败／取消') ? 'closed' : 'all'; }, label: msg('清理范围'), value: clearScopeLabel, valueTone: 'muted', description: msg('选择清理记录的范围。') + '\n' + msg('清理会保留活动、待交付、待核验与依赖必需记录。') }, { id: 'clear', kind: 'action' as const, label: msg('清理记录'), icon: glyph('delete'), destructive: true, confirmation: { title: msg`清理任务记录：${clearScopeLabel}？`, consequences: msg('仅清理所选范围；活动、待交付、待核验和依赖必需记录保留，不删除文件。'), action: msg('清理') }, description: msg('再按一次确认清理；先选好上面的清理范围。') + '\n' + msg('不删除文件，也不改 Goal 或历史记录。') }] }));
      if (!current() || selected === undefined) return;
      if (cursor.handled) continue;
      if (selected === 'graph') { await dagPanel(ctx, 'full', list); if (!current()) return; continue; }
      if (selected === 'clear') {
        if (hooks.protected()) { if (clearScope !== 'all') { notify(ctx, msg('当前任务状态受恢复保护；如需重置，请选择全部记录再确认清理。'), 'warning'); continue; } hooks.reset(ctx); }
        else notify(ctx, mutate({ action: 'clear', scope: clearScope }, ctx, 'command').text, 'info');
        continue;
      }
      if (selected.startsWith('preset:')) {
        const [name, action] = selected.slice('preset:'.length).split('/');
        const preset = presets.find(value => value.name === name);
        if (!preset) continue;
        if (action === 'apply' || action === 'reset') {
          try {
            await hooks.refreshPresets?.();
            if (!current()) return;
            const live = hooks.presets?.().find(item => item.name === preset.name);
            if (!live || JSON.stringify(live) !== JSON.stringify(preset)) { notify(ctx, msg('片段定义已改变，未执行；请核对更新后的步骤与变量。'), 'warning'); continue; }
            // Applying a fragment creates several tasks: report the count like the command path does.
            notify(ctx, mutate({ action, preset: preset.name, ...(action === 'apply' ? { vars: presetVariables.get(preset.name) ?? {} } : {}) }, ctx, 'command').text, 'info');
          }
          catch (cause) { notify(ctx, cause instanceof Error ? cause.message : String(cause), 'error'); }
          continue;
        }
        await owned(preset.name, () => readView(ctx, preset.name, toolDisplay({ version: 2, preset }, '', msg), { msg, isCurrent: current }));
        continue;
      }
      if (selected === 'filter') {
        selectedFilter = taskFilters[(taskFilters.indexOf(selectedFilter as typeof taskFilters[number]) + 1) % taskFilters.length]!;
        continue;
      }
      const target = targets.get(selected);
      const task = target?.task ?? state.tasks.find(value => String(value.id) === selected); if (!task) continue;
      const detailTitle = `Task #${task.id} · ${task.subject}`;
      // Text clients get the same specific reasons as the panel, not "the current mode or prerequisites".
      const blocked = task.blockedBy.filter((id) => state.tasks.find((value) => value.id === id)?.status !== 'completed');
      const gone = blocked.filter((id) => { const value = state.tasks.find((task) => task.id === id); return !value || value.status === 'deleted'; });
      const waiting = blocked.filter((id) => !gone.includes(id));
      const startBlocked = state.plan ? msg('先 /plan off 再执行。') : task.status === 'completed' ? msg('已完成任务不能重开；返工请新建任务。') : gone.length ? msg`前置任务已删除或不存在：${gone.map((id) => `#${id}`).join(', ')}；这条依赖无法满足：让模型用 removeBlockedBy 去掉它，或重建此任务` : waiting.length ? msg`前置任务尚未完成：${waiting.map((id) => `#${id}`).join(', ')}` : undefined;
      const action = target?.action ?? (ctx.mode !== 'tui' ? await owned(detailTitle, () => choose(ctx, detailTitle, [
        { id: 'read', label: msg('读取完整要求') }, { id: 'edit', label: msg('编辑任务要求') },
        { id: 'start', label: msg('开始任务'), ...(startBlocked ? { disabledReason: startBlocked } : {}) },
        { id: 'complete', label: msg('核验后完成任务'), ...(state.plan ? { disabledReason: msg('先 /plan off，再核验完成。') } : {}) },
      ], { msg, panel: panel(`task:${task.id}`), cursor: detailCursor, isCurrent: current, lines: todoSummary(task, msg) })) : undefined);
      if (!current() || action === undefined || hooks.state().tasks.find((value) => value.id === task.id) !== task) continue;
      if (action === 'read') await readView(ctx, detailTitle, todoSummary(task, msg).join('\n'), { msg, isCurrent: current });
      if (action === 'edit') {
        const description = ctx.mode === 'tui' ? String(cursor.value) : await owned(msg('任务要求'), () => dialogs.edit({ ctx, title: msg('任务要求'), value: task.description ?? '', isCurrent: current }));
        if (current() && description !== undefined) {
          // The record must be the one this editor opened: a recovered or externally changed task
          // must not receive a draft typed against older text.
          if (hooks.state().tasks.find((value) => value.id === task.id) === task) mutate({ action: 'update', id: task.id, description }, ctx, 'command');
          else notify(ctx, msg('任务已被外部改动，未保存过期输入'), 'warning');
        }
      }
      if (action === 'delete') mutate({ action: 'update', id: task.id, status: 'deleted' }, ctx, 'command');
      if (action === 'spawn') await hooks.spawn?.(task, ctx);
      if (action === 'start') mutate({ action: 'update', id: task.id, status: 'in_progress' }, ctx, 'command');
      if (action === 'pending' || action === 'failed' || action === 'cancelled') mutate({ action: 'update', id: task.id, status: action }, ctx, 'command');
      if (action === 'complete' && await owned(msg('确认任务已核验？'), () => dialogs.confirm({ ctx, title: msg('确认任务已核验？'), value: task.subject, isCurrent: current }))) {
        if (!current()) continue;
        // Same rule as the description editor: the confirmed task must still be the one on screen.
        if (hooks.state().tasks.find((value) => value.id === task.id) === task) mutate({ action: 'update', id: task.id, status: 'completed' }, ctx, 'command');
        else notify(ctx, msg('任务已被外部改动，未完成，也没有覆盖新状态'), 'warning');
      }
    }
  }
  pi.registerTool({
    name: "todo", label: "Todos", namespace: workflowNamespace, annotations: sessionMutation,
    description: "Manage one Todo DAG: create/update/list/get/delete/clear, apply/reset fragments, presets discovery, read-only status summary, or atomic batch definition edits. blockedBy defines prerequisites; failed/cancelled never unblock work. Create pending/in_progress; complete after verification. list is paged (use continuation); ready selects executable pending tasks; get includes blocks/unmetPrerequisites. status returns one small JSON summary (mode, per-status counts, deleted, protected). clear preserves active, undelivered, unverified and required dependency records; files, Goal and history are unchanged. Plan edits definitions only.",
    promptSnippet: "Use todo to plan and track multi-step work in one dependency-aware list, discovering fragments on demand",
    promptGuidelines: [
      "Discover task fragments on demand: action presets lists configured names, and passing preset with it returns one full definition. Never guess a fragment name or list the catalog unprompted.",
      "Use todo for work with three or more steps or explicit task-tracking requests; skip simple questions and small fixes.",
      "Keep one list and update existing tasks when scope changes. Mark in_progress before work and complete only after verification; keep at most one in_progress task per work stream.",
      "Never complete a task whose work is unfinished, failing, or blocked; create a task for the blocker instead.",
      "For verified completion or a closed attempt, normally update only id/status. Keep description for task requirements, not progress logs; report evidence in the conversation or reference artifacts instead of copying long reports into the Todo.",
      "blockedBy lists indispensable prerequisite outputs, never scheduling or shared files. Start or complete only after prerequisites complete. New redundant paths among unfinished tasks are rejected; record verified background in text instead.",
      CHECKPOINT_RULE,
    ],
    parameters: TodoParamsSchema,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        if (params.action === 'apply' || params.action === 'reset' || params.action === 'presets') await hooks.refreshPresets?.();
        const result = mutate(params, ctx);
        // Status is a short read-only query: readable JSON in content, no tasks snapshot in details.
        if (params.action === 'status') {
          const status = { ...result.status!, protected: hooks.protected(), ...(hooks.retryStatus ? { retry: hooks.retryStatus() } : {}) };
          return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: { version: 2, action: params.action, status } };
        }
        // Catalog discovery is a read-only query: its details carry the answer, never a task snapshot.
        const details = params.action === 'presets'
          ? { version: 2, action: params.action, ...(result.presets ? { presets: result.presets } : {}), ...(result.preset ? { preset: result.preset } : {}) }
          : { version: 2, action: params.action, tasks: structuredClone(params.action === 'clear' ? [] : result.tasks ?? []), nextId: hooks.state().nextId, ...(result.page ? { page: result.page } : {}), ...(result.relations ? { relations: result.relations } : {}), ...(result.removedIds ? { removedIds: result.removedIds } : {}), ...(result.refs ? { refs: result.refs } : {}) };
        return { content: [{ type: "text", text: result.text }], details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: msg`错误：${message}` }], details: { action: params.action, error: message } };
      }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `${glyph('complete')} todo ${args.action}${args.id ? ` #${args.id}` : ""}${args.subject ? ` ${clean(args.subject)}` : ""}`), 0, 0); },
    renderResult(result, options, theme) {
      const text = toolDisplay(result.details, result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), msg);
      const lines = text.split("\n").map(clean);
      const preview = !options.expanded && lines.length > 6 ? [...lines.slice(0, 4), msg`… 另 ${lines.length - 5} 行，展开查看`, lines.at(-1)!] : lines;
      if (!options.expanded) return { render: (width: number) => preview.map((line) => truncateToWidth(theme.fg(result.isError ? 'error' : 'text', line), width)), invalidate() {} };
      return new Text(theme.fg(result.isError ? "error" : "text", preview.join("\n")), 0, 0);
    },
  });

  const command = async (args: string, ctx: ExtensionContext) => withMenuScope(ctx, async () => {
      try {
        const trimmed = args.trim();
        const [action, ...parts] = trimmed.split(/\s+/);
        if (action === 'help') { ctx.ui.notify(msg('/todos · add 标题 [--after 1,2] · start/done/pending/failed/cancelled/delete #编号 · edit #编号 标题 · clear [completed/closed/all] · paths/flat · show/hide · view list/dag [full/pending/completed/failed/cancelled] · list [筛选] · presets · apply 名称 [键=值] · reset 名称 [步骤键]；/dag [筛选] 查看完整图'), 'info'); return; }
        if (action === 'presets') {
          await hooks.refreshPresets?.();
          const list = hooks.presets?.() ?? [];
          notify(ctx, list.length ? toolDisplay({ version: 2, presets: list.map((preset) => ({ name: preset.name, description: preset.description, steps: preset.steps.length })) }, '', msg) : msg('未配置 Task 片段'), 'info');
          return;
        }
        if (action === 'apply' || action === 'reset') {
          await hooks.refreshPresets?.();
          const name = parts[0];
          if (!name) throw new Error(msg`用法：/todos ${action} 名称${action === 'apply' ? ' [键=值 ...]' : ' [步骤键]'}`);
          let params: TodoParams;
          if (action === 'apply') {
            const vars: Record<string, string> = Object.create(null);
            for (const pair of parts.slice(1)) {
              const at = pair.indexOf('=');
              if (at < 1) throw new Error(msg`变量需要 键=值：${pair}`);
              vars[pair.slice(0, at)] = pair.slice(at + 1);
            }
            params = { action: 'apply', preset: name, ...(Object.keys(vars).length ? { vars } : {}) };
          } else {
            if (parts.length > 2) throw new Error(msg`用法：/todos ${action} 名称${' [步骤键]'}`);
            params = { action: 'reset', preset: name, ...(parts[1] ? { step: parts[1] } : {}) };
          }
          notify(ctx, mutate(params, ctx, 'command').text, 'info');
          return;
        }
        const filter = (value?: string): TodoFilter => {
          if (value === undefined) return hooks.state().filter ?? 'full';
          if (!TODO_FILTERS.includes(value as TodoFilter)) throw new Error(msg('筛选只支持 full/pending/completed/failed/cancelled'));
          return value as TodoFilter;
        };
        if (!trimmed) {
          if (ctx.mode === 'tui') { await tasksMenu(ctx); return; }
          return await show(ctx, "list", filter());
        }
        if (action === "list") {
          if (parts.length > 1) throw new Error(msg('用法：/todos list [筛选]'));
          const width = Math.max(16, (process.stdout.columns ?? 80) - 4) - 2;
          const lines = renderTasks(hooks.state(), width, { maxRows: Infinity, theme: ctx.ui.theme, jobs: hooks.jobs?.() ?? [], msg, filter: filter(parts[0]) });
          notify(ctx, lines.join('\n') || msg('暂无任务'), 'info');
          return;
        }
        if (action === "view") {
          if (!["list", "dag"].includes(parts[0] ?? "") || parts.length < 1 || parts.length > 2) throw new Error(msg('用法：/todos view list|dag [筛选]'));
          commit({ ...hooks.state(), visible: true, view: parts[0] as "list" | "dag", filter: filter(parts[1]) }, ctx);
          return;
        }
        if (action === "paths" || action === "flat") {
          if (parts.length) throw new Error(msg('用法：/todos paths 或 /todos flat'));
          commit({ ...hooks.state(), visible: true, treeStyle: action }, ctx);
          return;
        }
        if (action === "show" || action === "hide") { commit({ ...hooks.state(), visible: action === "show" }, ctx); return; }
        if (action === "clear") {
          if (clearPrompt) throw new Error(msg('清理菜单已打开'));
          const prompt = { epoch: sessionEpoch }; clearPrompt = prompt;
          try {
            if (parts.length > 1) throw new Error(msg('用法：/todos clear [completed/closed/all]'));
            let scope = parts[0] as ClearScope | undefined;
            if (scope !== undefined && !['completed', 'closed', 'all'].includes(scope)) throw new Error(msg('用法：/todos clear [completed/closed/all]'));
            if (!ctx.hasUI) throw new Error(msg('清理菜单需要交互界面；工具可明确指定 scope'));
            const userPrompt = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
            if (ctx.mode === 'tui') {
              await tasksMenu(ctx, scope ?? 'completed');
              return;
            } else if (scope === undefined) {
              const title = msg('清理 Todos 与子 Agent 记录');
              const options = [msg('清理已完成记录'), msg('清理已完成／失败／取消记录'), msg('清空全部可清理记录')];
              const selected = await userPrompt(title, () => choose(ctx, title, options.map(label => ({ id: label, kind: 'action', icon: glyph('toggle'), label })), { msg }));
              if (selected === undefined || prompt.epoch !== sessionEpoch) return;
              scope = (['completed', 'closed', 'all'] as const)[options.indexOf(selected)];
              if (scope === undefined) return;
            }
            const scopeLabel = scope === 'completed' ? msg('已完成记录') : scope === 'closed' ? msg('已完成／失败／取消记录') : msg('全部可清理记录');
            const title = msg`确认清理 ${scopeLabel}？`;
            const preview = hooks.previewClear?.(scope) ?? msg('保留运行／待交付／待核验和依赖必需记录，不修改文件、Goal或对话历史；编号不复用。');
            if (!await userPrompt(title, () => dialogs.confirm({ ctx, title, value: preview, isCurrent: () => prompt.epoch === sessionEpoch }))) return;
            if (prompt.epoch !== sessionEpoch) return;
            if (hooks.protected()) { if (scope !== 'all') throw new Error(msg('状态受保护时只能明确 clear all 重置')); hooks.reset(ctx); }
            else notify(ctx, mutate({ action: "clear", scope }, ctx, 'command').text, 'info');
            return;
          } finally { if (clearPrompt === prompt) clearPrompt = undefined; }
        }
        let params: TodoParams | undefined;
        if (action === "add") {
          const body = trimmed.slice(3).trim();
          const match = /^(.*?)\s+--after\s+(#?\d+(?:,#?\d+)*)$/.exec(body);
          params = { action: "create", subject: match ? match[1]!.trim() : body, ...(match ? { blockedBy: match[2]!.split(',').map((value) => asId(value, msg)) } : {}) };
        } else if (["start", "done", "pending", "failed", "cancelled", "delete"].includes(action ?? "")) {
          if (parts.length !== 1) throw new Error(msg`用法：/todos ${action} #编号`);
          params = action === "delete" ? { action: "delete", id: asId(parts[0], msg) } : { action: "update", id: asId(parts[0], msg), status: action === "start" ? "in_progress" : action === "done" ? "completed" : action === 'failed' ? 'failed' : action === 'cancelled' ? 'cancelled' : "pending" };
        } else if (action === "edit") params = { action: "update", id: asId(parts[0], msg), subject: parts.slice(1).join(" ") };
        if (params) { notify(ctx, mutate(params, ctx, 'command').text, "info"); return; }
        pi.sendUserMessage(`Manage the current Todos: ${trimmed}`, { deliverAs: "followUp" });
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
    });
  hooks.panel?.register(ctx => command('', ctx));
  pi.registerCommand('todos', { description: msg('当前 Todos：查看、编辑与视图切换；也可直接描述需求'), getArgumentCompletions: prefix => completeArguments(prefix, completion), handler: async (args, ctx) => {
    if (ctx.mode === 'tui' && hooks.panel && (!args.trim() || args.trim().split(/\s+/)[0] === 'clear')) { await hooks.panel.open(ctx, args.trim() ? ctx => command(args, ctx) : undefined); return; }
    await command(args, ctx);
  } });
  pi.registerCommand("dag", { description: msg('查看当前 Todos 的依赖图'), getArgumentCompletions: (prefix) => {
    const value = prefix.trim();
    if (TODO_FILTERS.includes(value as TodoFilter)) return null;
    const matches = TODO_FILTERS.filter((name) => name.startsWith(value));
    return matches.length ? matches.map((name) => ({ value: name, label: name })) : null;
  }, handler: async (args, ctx) => {
    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length > 1 || parts[0] !== undefined && !TODO_FILTERS.includes(parts[0] as TodoFilter)) { notify(ctx, msg('用法：/dag [full/pending/completed/failed/cancelled]'), 'error'); return; }
    if (!parts.length) {
      if (ctx.mode === 'tui') { if (hooks.panel) await hooks.panel.open(ctx, ctx => dagPanel(ctx)); else await withMenuScope(ctx, () => dagPanel(ctx)); }
      else await withMenuScope(ctx, () => show(ctx, 'dag'));
      return;
    }
    const width = Math.max(16, (process.stdout.columns ?? 80) - 4) - 2;
    const lines = renderDag(hooks.state(), width, ctx.ui.theme, undefined, hooks.jobs?.() ?? [], { msg, ...(parts[0] ? { filter: parts[0] as TodoFilter } : {}) });
    notify(ctx, lines.join('\n') || msg('暂无任务'), 'info');
  } });
}
