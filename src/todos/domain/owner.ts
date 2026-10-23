import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { clean, notify } from '../../shared/terminal.ts';
import type { AgentView } from '../../shared/agent-view.ts';
import type { ClearScope, Todo, WorkflowState } from '../../shared/task-types.ts';
import { latestBoundJobs, taskFilterStatus } from '../../shared/ui/filter.ts';
import { configPaths } from '../../shared/config.ts';
import { PresetStore, resetClosure } from './presets.ts';
import { appendTodoRecord } from '../io/records.ts';
import { STATE_TYPE, applyTodo, clearTodoRecords, emptyState, newlyReady, restoreState, validateState, validateTodoFields } from "./state.ts";
import type { TodoParams } from "../../shared/task-schema.ts";

interface Hooks {
  msg?: Translator;
  api(): ExtensionAPI;
  branch(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']>;
  plan(): { enabled: boolean; tools: string[] };
  jobs(): readonly AgentView[];
  paint(ctx: ExtensionContext): void;
  saved(ctx: ExtensionContext): void;
  changed(ids?: readonly number[]): void;
  assertMutation(params: TodoParams): void;
  afterMutation(params: TodoParams, before: WorkflowState): void;
  cleanupProtection(tasks: readonly Todo[]): ReadonlySet<number>;
  cleanupRecords(scope: ClearScope, before: readonly Todo[], after: readonly Todo[]): number;
}

export function createTodosOwner(hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  let tasks = emptyState(), error: string | undefined, epoch = 0;
  let legacyPlanFields: { plan?: unknown; planTools?: unknown } = {};
  const presets = new PresetStore({ path: configPaths().preset });
  let presetList = presets.list();
  const state = (): WorkflowState => ({ ...tasks, tasks: error ? [] : tasks.tasks, plan: hooks.plan().enabled, planTools: hooks.plan().tools });
  function commit(next: WorkflowState, ctx: ExtensionContext, source: 'tool' | 'command' = 'command') {
    if (error) throw new Error(msg`状态恢复失败，不能修改：${error}`);
    if (next.tasks === tasks.tasks && next.nextId === tasks.nextId && next.visible === tasks.visible && next.view === tasks.view && next.treeStyle === tasks.treeStyle && next.filter === tasks.filter) return;
    const changed = next.tasks !== tasks.tasks, before = tasks;
    appendTodoRecord(hooks.api(), STATE_TYPE, { ...next, plan: legacyPlanFields.plan ?? false, planTools: legacyPlanFields.planTools ?? [] });
    tasks = { ...next, plan: false, planTools: [] };
    if (source === 'command' && changed) {
      const previous = new Map(before.tasks.map(task => [task.id, task]));
      hooks.changed([...new Set([...next.tasks.filter(task => previous.get(task.id) !== task).map(task => task.id), ...before.tasks.filter(task => !next.tasks.some(item => item.id === task.id)).map(task => task.id)])]);
    }
    hooks.paint(ctx); hooks.saved(ctx);
  }
  function restore(ctx: ExtensionContext) {
    epoch++; legacyPlanFields = {};
    try {
      const branch = hooks.branch(ctx);
      const saved = branch.findLast(item => item.type === 'custom' && item.customType === STATE_TYPE);
      const legacy = saved?.type === 'custom' ? structuredClone(saved.data as WorkflowState) : restoreState(branch, msg);
      legacyPlanFields = { plan: legacy?.plan, planTools: legacy?.planTools };
      const value = { ...legacy, plan: false, planTools: [] };
      validateState(value, msg); tasks = value; error = undefined;
    } catch (cause) { tasks = emptyState(); error = String(cause); notify(ctx, msg`工作流状态恢复失败：${error}。保留原记录，修改已禁用；/todos clear 可明确重置。`, 'error'); }
  }
  async function refreshPresets() { await presets.load(); presetList = presets.list(); }
  async function restorePresets(ctx: ExtensionContext) {
    const own = epoch;
    try { await refreshPresets(); if (own === epoch) hooks.paint(ctx); }
    catch (cause) { if (own === epoch) notify(ctx, msg`Task 片段（preset）配置无效：${String(cause)}`, 'error'); }
  }
  function mutate(params: TodoParams, ctx: ExtensionContext, source: 'tool' | 'command' = 'tool') {
    if (error && !['list', 'get', 'status', 'presets'].includes(params.action)) throw new Error(msg`状态恢复失败，不能修改：${error}`);
    if (params.action === 'clear') {
      validateTodoFields(params, msg);
      const before = state(), scope = params.scope ?? 'all', latest = latestBoundJobs(hooks.jobs());
      const outcomes = new Map(before.tasks.filter(task => task.status !== 'deleted').map(task => [task.id, taskFilterStatus(task, latest.get(task.id))]));
      const result = clearTodoRecords(before, scope, hooks.cleanupProtection(before.tasks), outcomes, msg);
      commit(result.state, ctx, source);
      const removed = hooks.cleanupRecords(scope, before.tasks, tasks.tasks);
      return { ...result, text: `${result.text}\n${msg`已清理 ${removed} 个已结束子 Agent 记录；运行及待交付／核验记录保留`}` };
    }
    if (params.action !== 'batch') hooks.assertMutation(params);
    const before = state(), result = applyTodo(before, params, msg, presets);
    if (['list', 'get', 'status', 'presets'].includes(params.action)) return result;
    if (result.operations) for (const operation of result.operations) hooks.assertMutation(operation);
    const ready = newlyReady(before, result.state); commit(result.state, ctx, source);
    if (result.operations) {
      const updates = new Map<number, TodoParams>();
      for (const operation of result.operations) if (operation.action === 'update' && operation.id !== undefined) { const previous = updates.get(operation.id); updates.set(operation.id, { ...previous, ...operation, addBlockedBy: [...previous?.addBlockedBy ?? [], ...operation.addBlockedBy ?? []], removeBlockedBy: [...previous?.removeBlockedBy ?? [], ...operation.removeBlockedBy ?? []] }); }
      for (const operation of updates.values()) hooks.afterMutation(operation, before);
    } else hooks.afterMutation(params, before);
    if (ready.length) {
      const names = ready.slice(0, 5).map(task => `#${task.id} ${truncateToWidth(clean(task.subject), 24)}`).join('、');
      result.text += `\n${msg`前置已完成，可开始：${names}${ready.length > 5 ? msg` 等 ${ready.length} 项` : ''}`}`;
    }
    return result;
  }
  return {
    state, commit, restore, mutate, refreshPresets, restorePresets,
    validateDispatch(before: WorkflowState, id: number) { applyTodo(before, { action: 'update', id, status: 'in_progress' }, msg); },
    resetTasks(params: TodoParams) { return resetClosure(state().tasks, params.preset ?? '', params.step, params.run); },
    presets: () => presetList,
    protected: () => !!error,
    error: () => error,
    reset(ctx: ExtensionContext) { error = undefined; commit(emptyState(), ctx); },
    invalidate() { epoch++; },
    shutdown() { epoch++; tasks = emptyState(); error = undefined; },
    previewClear(scope: ClearScope) {
      const current = state(), latest = latestBoundJobs(hooks.jobs());
      const outcomes = new Map(current.tasks.filter(task => task.status !== 'deleted').map(task => [task.id, taskFilterStatus(task, latest.get(task.id))]));
      const preview = clearTodoRecords(current, scope, hooks.cleanupProtection(current.tasks), outcomes, msg);
      return `${msg`预计清理 ${preview.removedIds.length} 项，保留 ${preview.keptIds.length} 项`}\n${msg('运行、待交付、待核验和依赖必需记录保留；不修改文件、Goal或对话历史。')}`;
    },
  };
}
