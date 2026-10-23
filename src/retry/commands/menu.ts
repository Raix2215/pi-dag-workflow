import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeArguments } from '../../shared/completion.ts';
import { notify } from '../../shared/terminal.ts';
import { chinese } from '../../shared/i18n.ts';
import { choose, withMenuScope, panelOptions, type MenuCursor, type MenuItem, type PanelNavigation, panelInput, panelEdit, panelConfirm } from '../../shared/ui/menu.ts';
import { retrySummary, retryPhaseText, modelBudget, modelLabel } from '../../shared/ui/presentation.ts';
import { defaultRetrySettings, defaultRetryModels, modelRefText, parseModelRefs, validateRetryModels, type RetryModels, intervalText, parseCount, parseRetrySettings } from '../domain/state.ts';
import type { createRetryOwner, Hooks } from '../domain/owner.ts';
import { glyph } from '../../shared/ui/symbols.ts';

export function registerRetryCommand(pi: ExtensionAPI, hooks: Hooks & { panel?: PanelNavigation }, owner: ReturnType<typeof createRetryOwner>) {
  const t = hooks.msg ?? chinese, safeDiagnostic = hooks.diagnostic;
  const dialogs = hooks.panel ?? { input: panelInput, edit: panelEdit, confirm: panelConfirm };
  const fail = (ctx: ExtensionContext, cause: unknown) => notify(ctx, safeDiagnostic(String(cause)), 'error');

  async function confirmModels(next: RetryModels, ctx: ExtensionContext, active: () => boolean = () => true): Promise<boolean> {
    validateRetryModels(next, t);
    if (JSON.stringify(next) === JSON.stringify(owner.state.models ?? defaultRetryModels())) return true;
    if (owner.starting || owner.admitted || owner.switching) throw new Error(t('模型请求正在恢复，请稍后修改替代设置'));
    if (owner.error || hooks.protected()) throw new Error(owner.error ?? t('工作流状态受保护'));
    const revision = owner.settingsRevision, generation = owner.sessionGeneration, scope = hooks.scope();
    if (!ctx.hasUI) throw new Error(t('替代模型设置需要交互确认，请使用 /retry models 菜单'));
    const title = t('确认替代模型设置？');
    const accepted = await owner.prompt(title, () => dialogs.confirm({ ctx, title,
      value: t`候选：${next.candidates.map(modelRefText).join(' → ') || '-'}；每模型 ${next.after} 次；${next.enabled ? t('开启') : t('关闭')}。跨服务会发送当前上下文，可能增加费用和缓存开销；成功后保留替代模型，不改全局默认。`, isCurrent: active }));
    if (!active() || generation !== owner.sessionGeneration || scope !== hooks.scope()) return false;
    if (revision !== owner.settingsRevision) { notify(ctx, t('重试设置已改变，未保存过期输入'), 'warning'); return false; }
    if (!accepted) return false;
    if (owner.starting || owner.admitted || owner.switching) throw new Error(t('模型请求正在恢复，请稍后修改替代设置'));
    owner.setModels(next, ctx); return true;
  }
  async function modelsCommand(parts: string[], ctx: ExtensionContext) {
    if (!parts.length) { notify(ctx, retrySummary(owner.snapshot(), t).join('\n'), 'info'); return; }
    const before = owner.state.models ?? defaultRetryModels();
    if (parts[0] === 'after') {
      if (parts.length !== 2) throw new Error(t('用法：/retry models after 次数'));
      await confirmModels({ ...before, after: parseCount(parts[1]!, t) }, ctx);
    } else if (parts[0] === 'off') {
      if (parts.length !== 1) throw new Error(t('用法：/retry models off'));
      owner.disableModels(ctx);
    } else {
      const candidates = parseModelRefs(parts, t);
      for (const ref of candidates) if (!ctx.modelRegistry.find(ref.provider, ref.id)) throw new Error(t`找不到模型 ${modelRefText(ref)}`);
      await confirmModels({ ...before, candidates, enabled: true }, ctx);
    }
  }

  async function menu(ctx: ExtensionContext) {
    if (!ctx.hasUI) throw new Error(t('当前界面没有菜单，请使用 /retry when-error、off 或 status'));
    const session = owner.openMenu(), cursor: MenuCursor = {};
    // A reload replaces the runtime: the open menu must stop before it touches a context Pi has retired.
    const opened = owner.sessionGeneration;
    const active = () => session.active() && !hooks.panel?.requested() && opened === owner.sessionGeneration && ctx.signal?.aborted !== true;
    let draft: { models: RetryModels; revision: number } | undefined;
    const editModels = (change: (value: RetryModels) => void) => {
      draft ??= { models: structuredClone(owner.state.models ?? defaultRetryModels()), revision: owner.settingsRevision };
      change(draft.models);
    };
    try {
      // Each idle refresh captures a coherent view and fresh revision guards; the draft stays outside it.
      const buildRows = () => {
        const snapshot = owner.snapshot(), enabled = owner.state.enabled, base = owner.state.settings, revision = owner.settingsRevision, generation = owner.sessionGeneration;
        const actual = owner.state.models ?? defaultRetryModels(), models = draft?.models ?? actual;
        const settings = base ?? defaultRetrySettings();
        // A reload or session change replaces the runtime: a confirmation answered afterwards is expired,
        // not an invitation to write through a stale context.
        const current = () => active() && revision === owner.settingsRevision && generation === owner.sessionGeneration;
        const guarded = (run: () => void | Promise<void>) => async () => { try { if (current()) await run(); else if (generation === owner.sessionGeneration && active()) notify(ctx, t('重试设置已改变，未保存过期输入'), 'warning'); } catch (cause) { if (active() && generation === owner.sessionGeneration) fail(ctx, cause); } };
        const parseSetting = (kind: 'intervals' | 'count', value: string) => parseRetrySettings([
          kind === 'intervals' ? value : intervalText(settings),
          ...(kind === 'count' ? value.trim() ? ['count', value.trim()] : [] : settings.count === undefined ? [] : ['count', String(settings.count)]),
        ], t);
        const validate = (kind: 'intervals' | 'count') => (value: string) => { try { parseSetting(kind, value); return undefined; } catch (cause) { return safeDiagnostic(String(cause)); } };
        const saveSetting = (kind: 'intervals' | 'count') => async (value: unknown) => {
          try {
            // A replaced runtime must not be touched: only an in-session revision change is worth a notice.
            if (!current()) { if (generation === owner.sessionGeneration && active()) notify(ctx, t('重试设置已改变，未保存过期输入'), 'warning'); return; }
            const next = parseSetting(kind, String(value));
            if (base && next.count === base.count && next.intervals.length === base.intervals.length && next.intervals.every((interval, index) => interval === base.intervals[index])) return;
            const title = t('确认重试设置？');
            const accepted = await owner.prompt(title, () => dialogs.confirm({ ctx, title, value: t`间隔：${intervalText(next)}；次数：${next.count ?? t('不限')}；${enabled ? t('开启') : t('关闭')}`, isCurrent: active }));
            if (!current()) { if (generation === owner.sessionGeneration && active()) notify(ctx, t('重试设置已改变，未保存过期输入'), 'warning'); return; }
            if (accepted) owner.editSettings(next.intervals, next.count, ctx);
          } catch (cause) { fail(ctx, cause); }
        };
        const candidates: MenuItem[] = models.candidates.map((ref, index) => ({
          id: `candidate:${encodeURIComponent(modelRefText(ref))}`, kind: 'entity', icon: glyph('models'), label: `${index + 1} ${modelLabel(ref.id, modelBudget(process.stdout.columns ?? 80), false)}`, value: ref.provider,
          description: modelRefText(ref), children: [
            { id: `candidate:${encodeURIComponent(modelRefText(ref))}/up`, kind: 'action', icon: glyph('up'), label: t('上移'), ...(index ? {} : { disabledReason: t('已是第一个') }), run: () => editModels(value => { [value.candidates[index - 1], value.candidates[index]] = [value.candidates[index]!, value.candidates[index - 1]!]; }) },
            { id: `candidate:${encodeURIComponent(modelRefText(ref))}/down`, kind: 'action', icon: glyph('down'), label: t('下移'), ...(index < models.candidates.length - 1 ? {} : { disabledReason: t('已是最后一个') }), run: () => editModels(value => { [value.candidates[index], value.candidates[index + 1]] = [value.candidates[index + 1]!, value.candidates[index]!]; }) },
            { id: `candidate:${encodeURIComponent(modelRefText(ref))}/remove`, kind: 'action', icon: glyph('remove'), label: t('从草稿移除'), description: t('仅修改草稿；保存前不改变当前候选。'), run: () => editModels(value => { value.candidates.splice(index, 1); }) },
          ],
        }));
        const available = ctx.modelRegistry.getAvailable().filter(model => !models.candidates.some(ref => modelRefText(ref) === modelRefText(model)));
        const modelRows: MenuItem[] = [
          { id: 'models-enabled', kind: 'toggle', icon: glyph('toggle'), label: t('启用替代（草稿）'), checked: models.enabled, value: models.enabled ? t('开启') : t('关闭'), description: t('修改后选择“保存候选设置”才生效；不立即切换当前模型。'), run: value => editModels(next => { next.enabled = value === true; }) },
          { id: 'models-after', kind: 'input', icon: glyph('count'), label: t('每模型尝试次数'), value: String(models.after), input: { title: t('每个模型最多尝试几次？输入正整数'), value: String(models.after), validate: value => { try { parseCount(value.trim(), t); return undefined; } catch (cause) { return safeDiagnostic(String(cause)); } } }, run: value => editModels(next => { next.after = parseCount(String(value).trim(), t); }) },
          ...candidates,
          { id: 'models-add', kind: 'entity', icon: glyph('new'), label: t('添加候选模型'), ...(models.candidates.length >= 8 ? { disabledReason: t('最多八个候选模型') } : !available.length ? { disabledReason: t('没有可添加的可用模型：核对模型配置或凭据。') } : {}), children: available.map(model => ({ id: `models-add/${encodeURIComponent(modelRefText(model))}`, kind: 'action', icon: glyph('models'), label: modelLabel(model.id, modelBudget(process.stdout.columns ?? 80), false), value: model.provider, description: modelRefText(model), run: () => editModels(next => { if (next.candidates.length < 8) next.candidates.push({ provider: model.provider, id: model.id }); }) })) },
          { id: 'models-save', kind: 'action', icon: glyph('complete'), label: t('保存候选设置'), ...(!draft ? { disabledReason: t('没有未保存的更改') } : {}), description: t('保存开关、次数与候选顺序；跨服务传递上下文前需要确认。'), run: guarded(async () => {
            if (!draft) return;
            if (draft.revision !== owner.settingsRevision) { notify(ctx, t('重试设置已改变，未保存过期输入'), 'warning'); return; }
            if (await confirmModels(draft.models, ctx, active)) draft = undefined;
          }) },
          { id: 'models-clear', kind: 'action', icon: glyph('remove'), label: t('清空草稿候选'), ...(!models.candidates.length ? { disabledReason: t('没有候选模型') } : {}), description: t('清空并关闭草稿中的模型替代；保存前不影响运行设置。'), run: () => editModels(next => { next.candidates = []; next.enabled = false; }) },
          { id: 'models-discard', kind: 'action', icon: glyph('remove'), label: t('放弃草稿'), ...(!draft ? { disabledReason: t('没有未保存的更改') } : {}), run: () => { draft = undefined; } },
        ];
        const stateRows: MenuItem[] = [
          { id: 'enabled', kind: 'toggle', icon: glyph('retry'), label: t('自动重试'), checked: enabled, value: enabled ? t('开启') : t('关闭'), description: t`失败后按 ${intervalText(settings)} 循环等待；最多 ${settings.count ?? t('不限')} 次。关闭会取消等待，不停止正在执行的工具。`, run: value => guarded(() => { if (value === true) owner.enable(ctx); else owner.off(ctx); })() },
          { id: 'phase', kind: 'readonly', icon: glyph('status'), label: t('当前阶段'), value: retryPhaseText(snapshot.phase, t) + (snapshot.phase === 'waiting' && snapshot.nextAt !== undefined ? ` · ${Math.ceil(Math.max(0, snapshot.nextAt - Date.now()) / 1000)}s` : '') },
          ...(snapshot.error || snapshot.reason || snapshot.lastError ? [{ id: 'reason', kind: 'readonly' as const, icon: glyph('status'), label: t('最近状态'), value: snapshot.error ?? snapshot.reason ?? snapshot.lastError ?? '', description: snapshot.error ?? snapshot.reason ?? snapshot.lastError ?? '' }] : []),
          { id: 'models', kind: 'entity', icon: glyph('models'), label: t('替代模型'), values: [{ text: actual.enabled ? t('开启') : t('关闭'), tone: 'muted' }, ...(draft ? [{ text: t('未保存'), tone: 'warning' as const }] : [])], description: t('展开编辑候选顺序、开关和次数；修改先留在草稿，保存后才生效。'), children: modelRows },
          { id: 'stop', kind: 'action', icon: glyph('stop'), label: t('停止本轮恢复'), value: owner.failure ? t('等待重试') : t('无'), valueTone: 'muted' as const, ...(!owner.failure ? { disabledReason: t('当前没有待恢复请求') } : {}), description: t('取消这次失败请求的恢复；保留自动重试开关和设置。'), run: guarded(() => owner.stop(ctx)) },
        ];
        const settingsRows: MenuItem[] = [
          { id: 'intervals', kind: 'input', icon: glyph('intervals'), label: t('重试间隔'), value: intervalText(settings).replaceAll(',', ', '), valueTone: 'muted' as const, input: { title: t('间隔列表，如 30s,2m,5m'), value: intervalText(settings), validate: validate('intervals') }, description: t('按填写顺序循环；保存不自动开启重试。'), run: saveSetting('intervals') },
          { id: 'count', kind: 'input', icon: glyph('count'), label: t('重试次数'), value: String(settings.count ?? t('不限')), valueTone: 'muted' as const, input: { title: t('每轮最多重试几次？输入正整数，留空表示不限'), value: settings.count === undefined ? '' : String(settings.count), validate: validate('count') }, description: t('只限制每次错误恢复的尝试次数，不是 Goal 续跑轮数。'), run: saveSetting('count') },
          { id: 'resume-after-compaction', kind: 'toggle', icon: glyph('autoresearch'), label: t('压缩后自动继续'), checked: snapshot.resumeAfterCompaction, value: snapshot.resumeAfterCompaction ? t('开启') : t('关闭'), description: t('上下文压缩后允许继续；不会解除用户对 Goal 的暂停。'), run: value => guarded(() => owner.editSettings(settings.intervals, settings.count, ctx, value === true))() },
        ];
        return { stateRows, settingsRows, information: [{ label: t('实际使用模型'), value: ctx.model ? modelRefText(ctx.model) : t('未记录'), line: 0 as const }, { label: t('本轮尝试次数'), value: `${snapshot.attempts}/${settings.count ?? t('不限')}`, line: 1 as const }] };
      };
      while (active()) {
        // choose reads items before actions/info, so all three sources share this exact build.
        let view: ReturnType<typeof buildRows>;
        const settings = owner.state.settings ?? defaultRetrySettings();
        const title = t`重试恢复 · ${owner.state.enabled ? t('开启') : t('关闭')} · ${intervalText(settings)} · ${settings.count ?? t('不限')} 次`;
        const selected = await owner.prompt(title, () => choose(ctx, title, () => { view = buildRows(); return view.stateRows; }, { msg: t, cursor, refreshInterval: 1000, backLabel: t('退出菜单'),
          panel: { ...panelOptions(hooks.panel, { id: 'retry', label: 'Retry' }, 'root'), single: false, itemsZone: 'upper', info: () => view.information },
          isCurrent: active, lines: () => retrySummary(owner.snapshot(), t), actions: () => view.settingsRows }));
        // A closed panel and an exited row are different events: the panel wins.
        if (!active() || selected === undefined) return;
        if (cursor.handled) continue;
      }
    } finally { session.close(); }
  }

  const command = async (args: string, ctx: ExtensionContext) => withMenuScope(ctx, async () => {
    let internal = false;
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (owner.isDelivery(action, parts)) { internal = true; await owner.deliver(ctx); return; }
      if (action && !parts.length && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(action)) return;
      if (!args.trim()) { await menu(ctx); return; }
      if (action === 'show' || action === 'hide') { hooks.setSummary?.(action === 'show', ctx); return; }
      if (action === 'models') { await modelsCommand(parts, ctx); hooks.onChanged?.(ctx); return; }
      if (action === 'when-error') { const settings = parseRetrySettings(parts, t); owner.configure(settings.intervals, settings.count, ctx); }
      else if (action === 'on' && !parts.length) owner.enable(ctx);
      else if (action === 'off' && !parts.length) owner.off(ctx);
      else if (action !== 'status' || parts.length) throw new Error(t('用法：/retry [when-error 5m,30s,10m [count 3] | off | status | models [provider/model ... | after N | off]]'));
      hooks.onChanged?.(ctx); notify(ctx, retrySummary(owner.snapshot(), t).join('\n'), 'info');
    } catch (cause) { if (internal) owner.internalFailed(cause, ctx); fail(ctx, cause); }
  });
  hooks.panel?.register(ctx => command('', ctx));
  pi.registerCommand('retry', { description: t('出错后重试：when-error 间隔列表 [count 次数]、off、status、models'), getArgumentCompletions: text => completeArguments(text, { actions: [{ action: 'when-error', description: t('设置并开启出错后重试') }, { action: 'on', description: t('开启自动重试：使用已保存或默认间隔；/retry status 查看') }, { action: 'off', description: t('关闭并取消计时') }, { action: 'status', description: t('查看重试状态') }, { action: 'models', description: t('设置替代模型：models、models 候选列表、models after 次数、models off') }], freeText: ['when-error', 'models'] }), handler: async (args, ctx) => {
    if (!args.trim() && ctx.mode === 'tui' && hooks.panel) { await hooks.panel.open(ctx); return; }
    await command(args, ctx);
  } });
}
