import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { applyGoal, GoalParamsSchema, goalAutoresearch, type GoalParams, type GoalState } from '../domain/state.ts';
import { configPaths, parseToolList, writeConfig } from '../../shared/config.ts';
import { choose, readView, withMenuScope, isMenuPrompt, menuPrompt as ownedMenuPrompt, panelOptions, type MenuItem, type MenuCursor, type PanelNavigation, panelInput, panelEdit, panelConfirm } from '../../shared/ui/menu.ts';
import { goalSummary, toolDisplay } from '../../shared/ui/presentation.ts';
import { clean, notify } from '../../shared/terminal.ts';
import { workflowNamespace, sessionMutation } from '../../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../../shared/completion.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { createGoalOwner, type Hooks } from '../domain/owner.ts';
import { glyph } from '../../shared/ui/symbols.ts';

export function registerGoal(pi: ExtensionAPI, hooks: Hooks & { panel?: PanelNavigation }) {
  const msg = hooks.msg ?? chinese;
  const dialogs = hooks.panel ?? { input: panelInput, edit: panelEdit, confirm: panelConfirm };
  const owner = createGoalOwner(pi, { ...hooks, menuOwned: (title, ctx) => isMenuPrompt(title, ctx.sessionManager ?? ctx.ui) });
  const activatable = new Set(['enable', 'nopause', 'nolimit', 'autoresearch']);
  const goalStatusLabel = (msg: Translator): Record<GoalState['goals'][number]['status'], string> => ({ active: msg('活动'), paused: msg('暂停'), completed: msg('已完成'), deleted: msg('已删除') });
  const completion: CompletionSpec = {
    actions: [
      { action: 'new', description: msg('创建目标（不启动）：new 标题') },
      { action: 'list', description: msg('查看目标与预算') },
      { action: 'enable', description: msg('启用并推进目标：enable [ #编号]') },
      { action: 'disable', description: msg('停用或暂停目标：disable [ #编号]') },
      { action: 'complete', description: msg('标记完成：complete #编号') },
      { action: 'delete', description: msg('删除目标：delete #编号') },
      { action: 'edit', description: msg('修改标题：edit #编号 新标题') },
      { action: 'get', description: msg('查看目标详情：get #编号') },
      { action: 'nopause', description: msg('切换运行中是否允许模型中断：nopause [ #编号] [on|off]（省略为当前目标；默认切换）') },
      { action: 'nolimit', description: msg('切换续跑轮数上限：nolimit [ #编号] [on|off]（省略为当前目标；默认切换）') },
      { action: 'autoresearch', description: msg('切换持续研究：autoresearch [ #编号] [on|off]（省略为当前目标；默认切换；不自行完成、不限轮数、自主执行）') },
      { action: 'config', description: msg('查看配置路径与值') },
      { action: 'reset', description: msg('清除 Goal 状态') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
    freeText: ['new'],
    arguments: (tokens, trailing) => {
      if (!['autoresearch', 'nopause', 'nolimit'].includes(tokens[0] ?? '') || tokens.length < 2 || tokens.length > 3 || tokens.length === 3 && trailing) return null;
      if (!/^#?[1-9]\d*$/.test(tokens[1] ?? '')) return null;
      if (tokens.length === 2 && !trailing) return null;
      const typed = tokens.length === 3 ? tokens[2]! : '';
      return ['on', 'off'].filter((name) => name.startsWith(typed)).map((name) => ({ token: `${tokens[0]} ${tokens[1]} ${name}`, label: name }));
    },
    tokens: (action) => ['enable', 'disable', 'edit', 'complete', 'delete', 'get', 'nopause', 'nolimit', 'autoresearch'].includes(action) ? owner.state().goals
      .filter((goal) => goal.status !== 'deleted' && (!activatable.has(action) || goal.status !== 'completed'))
      .map((goal) => ({ token: `#${goal.id}`, label: `#${goal.id} ${goal.title}`, description: goalStatusLabel(msg)[goal.status] })) : null,
  };
  const panel = (id: string) => {

    // The information band owns the status/turn fields, even before the first Goal exists.
    // No hint line here: the panel already shows the focused row's own description, and a `lines` entry
    // would additionally be projected into the upper zone as a readonly row (a sentence that is not a row).
    return panelOptions(hooks.panel, { id: 'goal', label: 'Goal' }, `goal:${id}`);
  };
  async function goalMenu(ctx: ExtensionContext, selectedId?: number) {
    const epoch = owner.epoch(), title = msg('Goal'), cursor: MenuCursor = {}, detailCursor: MenuCursor = {};
    if (ctx.mode === 'tui') selectedId ??= owner.state().focusId;
    const root = owner.openMenu(title);
    const limits = (() => { const config = owner.config(); return { goalMaxTurns: config.goalMaxTurns, goalNoProgressLimit: config.goalNoProgressLimit, goalErrorRetries: config.goalErrorRetries, goalNoPauseTools: [...config.goalNoPauseTools] }; })();
    const current = () => epoch === owner.epoch() && !hooks.panel?.requested();
    const validateTitle = (value: string) => value.trim() && Array.from(value.trim()).length <= 80 ? undefined : msg('目标标题需为 1–80 个字符。');
    try {
      while (current()) {
        let inlineAction: string | undefined, inlineGoal: GoalState['goals'][number] | undefined;
        if (ctx.mode === 'tui') {
          const saveNumber = async (key: 'goalMaxTurns' | 'goalNoProgressLimit' | 'goalErrorRetries', value: unknown, min: number, max: number) => {
            const number = Number(String(value).trim());
            if (!Number.isInteger(number) || number < min || number > max) { notify(ctx, msg`需为 ${min}–${max} 的整数`, 'error'); return; }
            try { await writeConfig({ [key]: number }, msg); limits[key] = number; notify(ctx, msg('配置已保存，/reload 后生效；不会自动恢复 Goal。'), 'info'); }
            catch (cause) { notify(ctx, cause instanceof Error ? cause.message : String(cause), 'error'); }
          };
          const settings = (): MenuItem[] => [
            { id: 'new', label: msg('新建目标'), kind: 'input' as const, icon: glyph('new'), input: { title: msg('目标标题'), validate: validateTitle }, run: (value: unknown) => { if (current() && String(value).trim()) owner.mutate({ action: 'create', title: String(value).trim() }, ctx, true); } },
            { id: 'goal-max-turns', label: msg('默认续跑轮数'), kind: 'input' as const, icon: glyph('count'), input: { title: msg('每轮最多续跑轮数（1–200）'), value: String(limits.goalMaxTurns), validate: (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 200 ? undefined : msg('需为 1–200 的整数') }, run: (value: unknown) => saveNumber('goalMaxTurns', value, 1, 200), value: String(limits.goalMaxTurns), description: msg('新目标的默认轮数上限；已有目标按各自的 nolimit／轮数上限。') + '\n' + msg('保存到配置文件的 goalMaxTurns。') },
            { id: 'goal-no-progress', label: msg('无进展上限'), kind: 'input' as const, icon: glyph('intervals'), input: { title: msg('可容忍的连续无进展轮数（1–100）'), value: String(limits.goalNoProgressLimit), validate: (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 100 ? undefined : msg('需为 1–100 的整数') }, run: (value: unknown) => saveNumber('goalNoProgressLimit', value, 1, 100), value: String(limits.goalNoProgressLimit), description: msg('允许暂停的目标超过此轮数无进展时停下；自主模式不会因此自行暂停。') + '\n' + msg('保存到配置文件的 goalNoProgressLimit。') },
            { id: 'goal-error-retries', label: msg('错误重试次数'), kind: 'input' as const, icon: glyph('retry'), input: { title: msg('每轮最多错误重试几次（0–20）'), value: String(limits.goalErrorRetries), validate: (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 0 && Number(value) <= 20 ? undefined : msg('需为 0–20 的整数') }, run: (value: unknown) => saveNumber('goalErrorRetries', value, 0, 20), value: String(limits.goalErrorRetries), description: msg('Goal 自愈的失败重试上限；Retry 启用时由 Retry 接管。') + '\n' + msg('保存到配置文件的 goalErrorRetries。') },
            { id: 'goal-nopause-tools', label: msg('自主模式禁止工具'), kind: 'input' as const, icon: glyph('config-tools'), input: { title: msg('工具名，逗号分隔；留空清除'), value: limits.goalNoPauseTools.join(','), validate: (value: string) => parseToolList(value) === undefined ? msg('工具名需为非空且不重复；逗号分隔') : undefined }, run: async (value: unknown) => { const names = parseToolList(String(value)); if (!names) return; try { await writeConfig({ goalNoPauseTools: names }, msg); limits.goalNoPauseTools = names; notify(ctx, msg`已保存 ${names.length} 个禁止工具`, 'info'); } catch (cause) { notify(ctx, cause instanceof Error ? cause.message : String(cause), 'error'); } }, value: msg`${limits.goalNoPauseTools.length} 项`, description: msg('自主模式禁止模型调用的工具清单。') + '\n' + msg('保存到配置文件的 goalNoPauseTools。') },
            { id: 'reset', label: msg('重置 Goal 记录'), kind: 'action' as const, destructive: true, confirmation: { title: msg`重置 ${owner.state().goals.filter(goal => goal.status !== 'deleted').length} 个 Goal 记录？`, consequences: msg('清除 Goal 记录和续跑状态；不删除 Task、Job、历史或项目文件。'), action: msg('重置') }, icon: glyph('delete'), run: async () => { await owner.reset(ctx, owner.epoch()); }, value: String(owner.state().goals.filter(goal => goal.status !== 'deleted').length) },
          ].map(row => ({ ...row, description: ('description' in row && row.description) || (row.id === 'new' ? msg('创建独立目标记录，不会自动启动。') + '\n' + msg('Enter 行内填写标题；Esc 放弃输入。') : msg('清除全部 Goal 记录与运行状态。') + '\n' + msg('再按一次确认；不撤销文件修改，也不删历史记录。')), ...(row.id === 'reset' && !owner.state().goals.some(goal => goal.status !== 'deleted') ? { disabledReason: msg('没有可清除的记录') } : {}) }));
          // Built per call (and per refresh) from live state: a goal that runs, pauses or finishes shows up
          // without the user moving the cursor.
          const targets = new Map<string, { goal: GoalState['goals'][number]; action: string }>();
          const buildEntities = (): MenuItem[] => {
            const live = owner.state(), rows = live.goals.filter(goal => goal.status !== 'deleted');
            targets.clear();
            const entities: MenuItem[] = rows.map(goal => ({ id: String(goal.id), label: goal.id === live.focusId && goal.status !== 'completed' ? msg('当前目标') : msg('目标'), kind: 'entity', icon: glyph('goal'), values: [{ text: `#${goal.id} ${goal.title}` }, { text: goal.nolimit || goalAutoresearch(goal) ? msg('不限') : String(goal.maxTurns), tone: 'muted' as const }], description: goalSummary(goal, goal.id === live.focusId ? live.run : undefined, msg).slice(0, 2).join('\n'), children: [
              { id: 'toggle', kind: 'toggle' as const, checked: goal.id === live.focusId && !live.run.paused, run: (value: unknown) => { if (owner.sameGoal(goal, owner.state().goals.find(item => item.id === goal.id))) owner.mutate({ action: value === true ? 'enable' : 'disable', id: goal.id }, ctx, true); }, label: goal.id === live.focusId && !live.run.paused ? msg('暂停 Goal') : msg('启动或恢复 Goal'), icon: goal.id === live.focusId && !live.run.paused ? glyph('pause') : glyph('toggle'), ...(goal.status === 'completed' || hooks.state().plan ? { disabledReason: goal.status === 'completed' ? msg('已完成目标不能重启；新建目标记录返工') : msg('先退出 Plan 才能恢复 Goal') } : {}) },
              { id: 'settings', kind: 'entity' as const, icon: glyph('settings'), label: msg('运行设置'), children: [
                { id: `${goal.id}/autoresearch`, kind: 'toggle' as const, icon: glyph('autoresearch'), label: msg('持续研究'), checked: goalAutoresearch(goal), value: goalAutoresearch(goal) ? msg('开启') : msg('关闭'), description: msg('开启后持续研究、不自行完成且不设续跑上限；改变设置不会启动目标。'), run: (value: unknown) => { if (owner.sameGoal(goal, owner.state().goals.find(item => item.id === goal.id))) owner.setAutoresearchControl(goal.id, value === true, ctx); } },
                { id: `${goal.id}/nopause`, kind: 'toggle' as const, icon: glyph('nopause'), label: msg('禁止模型自行暂停'), checked: goalAutoresearch(goal) || goal.modelPause === 'deny', value: goalAutoresearch(goal) || goal.modelPause === 'deny' ? msg('开启') : msg('关闭'), ...(goalAutoresearch(goal) ? { disabledReason: msg('持续研究强制禁止模型中断；先关闭持续研究再改。') } : {}), description: msg('只限制运行中的模型；你始终可以暂停目标。'), run: (value: unknown) => { if (owner.sameGoal(goal, owner.state().goals.find(item => item.id === goal.id))) owner.setPauseControl(goal.id, value === true, ctx); } },
                { id: `${goal.id}/nolimit`, kind: 'toggle' as const, icon: glyph('nolimit'), label: msg('不限续跑轮数'), checked: goalAutoresearch(goal) || goal.nolimit === true, value: goalAutoresearch(goal) || goal.nolimit ? msg('开启') : msg('关闭'), ...(goalAutoresearch(goal) ? { disabledReason: msg('持续研究强制不限轮数；先关闭持续研究再改。') } : {}), description: msg('只取消续跑轮数上限，不增加错误重试次数，也不清零已用轮数。'), run: (value: unknown) => { if (owner.sameGoal(goal, owner.state().goals.find(item => item.id === goal.id))) owner.setLimitControl(goal.id, value === true, ctx); } },
              ], ...(goal.status === 'completed' ? { disabledReason: msg('已完成目标不能重启；新建目标记录返工') } : {}) },
              { id: 'read', kind: 'action' as const, icon: glyph('summary'), label: msg('查看范围与进展') }, { id: 'edit', kind: 'input' as const, icon: glyph('edit'), input: { title: msg('目标标题'), value: goal.title, validate: validateTitle }, label: msg('编辑标题与范围') },
              { id: 'complete', kind: 'action' as const, icon: glyph('complete'), label: msg('标记目标完成'), ...(goal.status === 'completed' ? { disabledReason: msg('目标已完成') } : {}) },
              { id: 'delete', kind: 'action' as const, icon: glyph('delete'), label: msg('删除目标'), destructive: true, confirmation: { title: msg`删除 Goal #${goal.id}：${goal.title}？`, consequences: msg('删除此目标并停止其续跑；不停止工具或子 Agent，不撤销文件修改。'), action: msg('删除') } },
            ].map(action => { const id = `${goal.id}/${action.id}`; targets.set(id, { goal, action: action.id }); return { ...action, id, description: `Goal #${goal.id} · ${goal.title}\n` + (action.id === 'read' ? msg('只读查看范围、进展和下一步；不启动目标。') : action.id === 'edit' ? msg('先编辑标题，再编辑范围；全部提交后才保存，Esc 取消。') : action.id === 'complete' ? msg('核验全部要求后标记完成；不会替你检查结果。') : action.id === 'delete' ? msg('删除目标记录并停止相关续跑；不删除 Task、Job 或项目文件。再按一次确认。') : action.id === 'settings' ? msg('展开修改此目标的运行策略；修改策略不会启动目标。') : msg('只控制这个目标的续跑，不停止正在运行的工具或子 Agent。')) }; }) }));
            return entities;
          };
          // The band describes the same goal; only the focus owns the live counters.
          const informationState = () => {
            const fresh = owner.state(), rows = fresh.goals.filter(goal => goal.status !== 'deleted');
            const shown = rows.find(goal => goal.id === fresh.focusId) ?? rows[0];
            return { fresh, shown, counts: shown?.id === fresh.focusId };
          };
          // Keep band metadata as data, with computed values materialized when building each page.
          const information = [
            { label: msg('目标状态'), get value() { const { fresh, shown } = informationState(); return shown ? shown.id === fresh.focusId ? fresh.run.paused ? msg('暂停') : msg('活动') : goalStatusLabel(msg)[shown.status] : msg('暂无'); }, line: 0 as const },
            { label: msg('轮次进度'), get value() { const { fresh, shown, counts } = informationState(); return shown ? `${counts ? fresh.run.used : 0}/${shown.nolimit || goalAutoresearch(shown) ? msg('不限') : shown.maxTurns}` : msg('暂无'); }, line: 1 as const, tone: 'muted' as const },
            { label: msg('异常重试'), get value() { const { fresh, shown, counts } = informationState(); return shown ? `${counts ? fresh.run.errorRetries ?? 0 : 0}/${limits.goalErrorRetries}` : msg('暂无'); }, line: 1 as const, tone: 'muted' as const },
          ];
          const selected = await choose(ctx, title, buildEntities, { msg, refreshInterval: 1000, panel: { ...panel('root'), single: false, itemsZone: 'upper', info: () => information.map(field => ({ ...field })) }, cursor, searchable: true, isCurrent: current, actions: () => { const rows = settings(); return [...rows.filter(row => row.id === 'new'), { id: 'defaults', kind: 'entity', icon: glyph('settings'), label: msg('默认设置'), description: msg('重载后生效。轮数默认只用于新目标，其余设置属于全局运行策略；不会自动启动目标。'), children: rows.filter(row => row.id.startsWith('goal-')) }, rows.find(row => row.id === 'reset')!]; } });
          if (!current() || selected === undefined) return;
          if (cursor.handled) continue;
          const target = targets.get(selected);
          selectedId = target?.goal.id ?? owner.state().focusId; inlineAction = target?.action ?? selected;
          inlineGoal = target?.goal ?? owner.state().goals.find(goal => goal.id === selectedId && goal.status !== 'deleted');
        } else if (selectedId === undefined) {
          const choice = await choose(ctx, title, owner.state().goals.filter((goal) => goal.status !== 'deleted').map((goal) => ({ id: String(goal.id), label: `#${goal.id} ${goal.title}`, value: goal.id === owner.state().focusId && owner.state().run.paused ? msg('暂停') : goalStatusLabel(msg)[goal.status], description: goalAutoresearch(goal) ? msg('持续研究') : msg('普通目标'), })), { msg, panel: { ...panel('directory'), itemsZone: 'upper' }, cursor, searchable: true, isCurrent: current, lines: (item) => { const goal = owner.state().goals.find((value) => String(value.id) === item.id); return goal ? goalSummary(goal, goal.id === owner.state().focusId ? owner.state().run : undefined, msg) : []; }, actions: [{ id: 'new', label: msg('新建目标') }] });
          if (!current() || choice === undefined) return;
          if (choice === 'new') { const value = await ownedMenuPrompt(ctx, msg('目标标题'), () => dialogs.edit({ ctx, multiline: false, title: msg('目标标题'), value: '', isCurrent: current })); if (current() && value?.trim()) owner.mutate({ action: 'create', title: value.trim() }, ctx, true); continue; }
          selectedId = Number(choice);
        }
        const goal = inlineGoal ?? owner.state().goals.find((value) => value.id === selectedId && value.status !== 'deleted');
        if (!goal) { selectedId = undefined; continue; }
        const running = goal.id === owner.state().focusId && !owner.state().run.paused;
        const pageTitle = `Goal #${goal.id} · ${goal.title}`; root.title = pageTitle;
        const detail = goalSummary(goal, goal.id === owner.state().focusId ? owner.state().run : undefined, msg);
        const short = detail.slice(1, goal.id === owner.state().focusId ? 4 : 3);
        const research = goalAutoresearch(goal);
        const row = (rowId: string, label: string, value: string, disabledReason?: string) => ({ id: rowId, label, value, ...(rowId === 'nolimit' ? { valueTone: 'muted' as const } : {}), ...(disabledReason ? { disabledReason } : {}) });
        const entries: MenuItem[] = [
          { id: 'read', label: msg('查看范围与进展') },
          { id: 'edit', label: msg('编辑标题与范围') },
          { id: 'toggle', label: running ? msg('暂停 Goal') : msg('启动或恢复 Goal'), ...(goal.status === 'completed' || hooks.state().plan ? { disabledReason: goal.status === 'completed' ? msg('已完成目标不能重启；新建目标记录返工') : msg('先退出 Plan 才能恢复 Goal') } : {}) },
          row('autoresearch', msg('持续研究'), (research ? msg('开启') : msg('关闭')), goal.status === 'completed' ? msg('目标已完成') : undefined),
          row('nopause', msg('禁止模型自行暂停'), research ? msg('开启（持续研究）') : (goal.modelPause === 'deny' ? msg('开启') : msg('关闭')), research ? msg('持续研究强制禁止模型中断；先关闭持续研究再改。') : undefined),
          row('nolimit', msg('不限续跑轮数'), research ? msg`开启（持续研究，不限轮数）` : goal.nolimit ? msg('开启（不限轮数）') : msg`关闭（最多 ${goal.maxTurns} 轮）`, research ? msg('持续研究强制不限轮数；先关闭持续研究再改。') : undefined),
          { id: 'complete', label: msg('标记目标完成'), ...(goal.status === 'completed' ? { disabledReason: msg('目标已完成') } : {}) },
          { id: 'delete', label: msg('删除目标'), tone: 'error', destructive: true, confirmation: { title: msg`删除 Goal #${goal.id}：${goal.title}？`, consequences: msg('删除此目标并停止其续跑；不停止工具或子 Agent，不撤销文件修改。'), action: msg('删除') } },
        ];
        const order = ['toggle', 'read', 'edit', 'complete', 'delete', 'autoresearch', 'nopause', 'nolimit'];
        const rows = ctx.mode === 'tui' ? [...entries].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : entries;
        if (ctx.mode === 'tui') rows.splice(5, 0, { id: 'settings-heading', label: msg('运行设置'), kind: 'heading', icon: glyph('settings') });
        const item = ctx.mode === 'tui' ? inlineAction : await choose(ctx, pageTitle, rows, { msg, panel: panel(`goal:${goal.id}`), cursor: detailCursor, isCurrent: current, lines: short });
        if (!current()) return;
        if (!owner.sameGoal(goal, owner.state().goals.find(value => value.id === goal.id))) continue;
        if (item === undefined) { selectedId = undefined; root.title = title; continue; }
        if (item === 'read') { await readView(ctx, pageTitle, goalSummary(goal, goal.id === owner.state().focusId ? owner.state().run : undefined, msg).join('\n'), { msg, isCurrent: current }); continue; }
        // Text clients close the list after a pick: without a notice the toggle would be invisible.
        if (item === 'toggle') { notify(ctx, owner.mutate({ action: running ? 'disable' : 'enable', id: goal.id }, ctx, true).text, 'info'); continue; }
        if (item === 'autoresearch') { owner.setAutoresearchControl(goal.id, undefined, ctx); continue; }
        if (item === 'nopause') { owner.setPauseControl(goal.id, undefined, ctx); continue; }
        if (item === 'nolimit') { owner.setLimitControl(goal.id, undefined, ctx); continue; }
        if (item === 'edit') {
          const input = ctx.mode === 'tui' ? String(cursor.value) : await ownedMenuPrompt(ctx, msg('目标标题'), () => dialogs.edit({ ctx, multiline: false, title: msg('目标标题'), value: goal.title, isCurrent: current }));
          if (!current() || input === undefined) continue;
          const description = await ownedMenuPrompt(ctx, msg('目标范围与要求'), () => dialogs.edit({ ctx, title: msg('目标范围与要求'), value: goal.description ?? '', validate: value => Buffer.byteLength(value) <= 8192 ? undefined : msg('目标范围最多 8 KiB。'), isCurrent: current }));
          if (current() && description !== undefined && owner.sameGoal(goal, owner.state().goals.find((value) => value.id === goal.id))) owner.mutate({ action: 'update', id: goal.id, title: input, description }, ctx, true);
        }
        if (item === 'complete' || item === 'delete') {
          const confirmTitle = item === 'complete' ? msg('确认目标完成？') : msg('删除目标？');
          const accepted = item === 'delete' || await ownedMenuPrompt(ctx, confirmTitle, () => dialogs.confirm({ ctx, title: confirmTitle, value: goal.title, isCurrent: current }));
          if (current() && accepted && owner.sameGoal(goal, owner.state().goals.find((value) => value.id === goal.id))) owner.mutate({ action: item, id: goal.id }, ctx, true);
        }
      }
    } finally { owner.closeMenu(root); }
  }
  pi.registerTool({ name: 'goal', label: 'Goal', namespace: workflowNamespace, annotations: sessionMutation, description: 'Manage goals create/update/list/get/enable/disable/complete/delete. Use only fields for that action; complete takes id, not progress. Enable one; complete only after verifying every original requirement. Update only a verified milestone, reproducible finding, key decision, changed blocker or changed next action; skip routine activity, repeated notes and Todo status. Notes cannot narrow scope. nopause forbids questions, model disable/delete and empty nextStep. Default continuation cap32; user nolimit removes that cap, not used count or /retry settings. User autoresearch enforces continuous autonomous work with no Goal completion; verify milestones and continue within scope.',
    promptSnippet: 'Use goal to track an objective and continue it across turns',
    promptGuidelines: [
      'Create a goal only when the user asks for autonomous multi-turn work or progress tracking; ordinary tasks belong in the todo list. Enable one at a time. Ordinary Goals complete only after verification; autoresearch Goals continue verified research until the user stops.',
      'Update important new evidence/decisions, not every turn, tool call, wait or Todo update; combine it with independent work in the same tool batch, not a reporting-only model turn.',
      'While a Goal is enabled, pursue its full original objective across turns; a final answer, failed attempt, uncertainty, or completed Todo list does not stop it. Inspect evidence, try alternatives, and verify all requirements before complete. Under nopause, never ask the user, request routine confirmation, or hand work back; resolve gaps autonomously within scope. Wait for real running children, answer their questions yourself, and continue independent work.',
    ], parameters: GoalParamsSchema, executionMode: 'sequential',
    async execute(_id, params, _signal, _update, ctx) {
      try { const result = owner.mutate(params, ctx); return { content: [{ type: 'text', text: result.text }], details: { goalState: structuredClone(owner.state()), action: params.action, ...(params.id !== undefined ? { targetId: params.id } : params.action === 'create' ? { targetId: owner.state().goals.at(-1)?.id } : {}) } }; }
      catch (cause) { return { isError: true, content: [{ type: 'text', text: String(cause) }], details: { error: String(cause) } }; }
    },
    renderCall(args, theme) { return new Text(theme.fg('toolTitle', `${glyph('goal')} goal ${clean(args.action ?? '')}${args.id ? ` #${args.id}` : ''}`), 0, 0); },
    renderResult(result, _options, theme) { return new Text(theme.fg(result.isError ? 'error' : 'text', toolDisplay(result.details, result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n'), msg)), 0, 0); },
  });
  const command = async (args: string, ctx: ExtensionContext) => withMenuScope(ctx, async () => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify(msg('/goal new 标题 · list（文字） · enable/disable [ #编号] · complete/delete #编号 · edit #编号 标题 · get #编号（文字） · nopause/nolimit/autoresearch [ #编号] [on|off] · config（文字） · reset；裸 /goal 打开管理页；创建不启动，查看不重置预算，停用后需明确 enable 恢复。'), 'info'); return; }
      const id = (value?: string) => { if (value === undefined && owner.state().focusId !== undefined) return owner.state().focusId!; if (!value || !/^#?[1-9]\d*$/.test(value)) throw new Error(msg('请给出目标编号')); return Number(value.replace(/^#/, '')); };
      if (!args.trim()) { if (ctx.hasUI) await goalMenu(ctx); else notify(ctx, applyGoal(owner.state(), { action: 'list' }, owner.config().goalMaxTurns, msg).text, 'info'); return; }
      if (action === 'show' || action === 'hide') { hooks.setSummary?.(action === 'show', ctx); return; }
      if (action === 'list') { notify(ctx, applyGoal(owner.state(), { action: 'list' }, owner.config().goalMaxTurns, msg).text, 'info'); return; }
      if (action === 'get') {
        const goal = owner.state().goals.find((value) => value.id === id(parts[0])); if (!goal) throw new Error(msg('找不到目标；请给出 id'));
        notify(ctx, goalSummary(goal, goal.id === owner.state().focusId ? owner.state().run : undefined, msg).join('\n'), 'info'); return;
      }
      if (action === 'config') { notify(ctx, [configPaths().config, msg`默认续跑轮数：${owner.config().goalMaxTurns}`, msg`无进展规划阈值：${owner.config().goalNoProgressLimit}`, msg`自主模式禁止工具：${owner.config().goalNoPauseTools.join(', ')}`, msg('配置文件保存后重载生效；运行设置由各目标控制')].join('\n'), 'info'); return; }
      if (action === 'nopause' || action === 'nolimit' || action === 'autoresearch') {
        if (parts.length > 2) throw new Error(msg('此命令最多接受编号和 on/off'));
        if (parts.filter((part) => /^#?[1-9]\d*$/.test(part)).length > 1) throw new Error(msg('此命令只接受一个编号'));
        let value: boolean | undefined;
        for (const part of parts) {
          if (part === 'on' || part === 'off') { if (value !== undefined) throw new Error(msg('此命令最多接受一个 on/off')); value = part === 'on'; }
          else if (!/^#?[1-9]\d*$/.test(part)) throw new Error(msg('用法：[ #编号] [on|off]'));
        }
        const target = id(parts.find((part) => part !== 'on' && part !== 'off'));
        if (action === 'autoresearch') owner.setAutoresearchControl(target, value, ctx);
        else if (action === 'nopause') owner.setPauseControl(target, value, ctx);
        else owner.setLimitControl(target, value, ctx);
        return;
      }
      if (action === 'reset') {
        const ownEpoch = owner.epoch();
        if (!ctx.hasUI || !await dialogs.confirm({ ctx, msg, title: msg('清除 Goal 状态？'), value: msg('保留历史、Todos、Job 和项目文件；自动续跑停止。'), isCurrent: () => ownEpoch === owner.epoch() })) return;
        if (ownEpoch !== owner.epoch()) return;
        await owner.reset(ctx, ownEpoch);
        return;
      }
      let params: GoalParams | undefined;
      if (action === 'new') params = { action: 'create', title: parts.join(' ') };
      else if (action === 'edit') params = { action: 'update', id: id(parts[0]), title: parts.slice(1).join(' ') };
      else if (['enable', 'disable', 'complete', 'delete', 'get'].includes(action ?? '')) {
        if (parts.length > 1) throw new Error(msg('此命令只接受一个编号'));
        params = { action: action as GoalParams['action'], id: id(parts[0]) };
      }
      if (params) { notify(ctx, owner.mutate(params, ctx, true).text, 'info'); return; }
      pi.sendUserMessage(`Manage the current Goal: ${args}`, { deliverAs: 'followUp' });
    } catch (cause) { notify(ctx, String(cause), 'error'); }
  });
  hooks.panel?.register(ctx => command('', ctx));
  pi.registerCommand('goal', { description: msg('目标 new/list/enable/disable/complete/delete/edit/get/nopause/nolimit/autoresearch/config/reset，或自然语言'), getArgumentCompletions: prefix => completeArguments(prefix, completion), handler: async (args, ctx) => {
    if (!args.trim() && ctx.mode === 'tui' && hooks.panel) { await hooks.panel.open(ctx); return; }
    await command(args, ctx);
  } });
  const { title, canWake, resumeAgentReports, reserveWake, beforeWake, failedRequest, recoveryGoal, prepareErrorRecovery, undoErrorRecovery, isCompacting, pause, snapshot } = owner;
  return { title, canWake, resumeAgentReports, reserveWake, beforeWake, failedRequest, recoveryGoal, prepareErrorRecovery, undoErrorRecovery, isCompacting, pause, snapshot };
}
