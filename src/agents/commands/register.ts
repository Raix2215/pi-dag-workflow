import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveChildExtensionPaths } from '../../shared/config.ts';
import { Text } from '@earendil-works/pi-tui';
import { AgentSendError, type JobSummary } from '../domain/runtime.ts';
import { safeDiagnostic } from '../domain/diagnostics.ts';
import type { Profile } from '../domain/profiles.ts';
import { choose, readView, withMenuScope, panelOptions, type MenuCursor, type MenuItem, type PanelNavigation, panelInput, panelEdit, panelConfirm } from '../../shared/ui/menu.ts';
import { jobSummary, jobProfileLabel, modelBudget, modelLabel, modelSummary, profileSummary, sendFailureLines, toolDisplay } from '../../shared/ui/presentation.ts';
import { notify } from '../../shared/terminal.ts';
import { workflowNamespace, readOnly } from '../../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../../shared/completion.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { createAgentsOwner, type Hooks } from '../domain/owner.ts';
import { AgentSpawnParamsSchema, AgentInspectParamsSchema, AgentSendParamsSchema, AgentCancelParamsSchema } from '../domain/schema.ts';
import { glyph } from '../../shared/ui/symbols.ts';
export { AGENTS_TYPE, claimedBy } from '../domain/owner.ts';

const active = (job: JobSummary) => ["starting", "running", "waiting"].includes(job.status);
export function registerAgents(pi: ExtensionAPI, hooks: Hooks & { panel?: PanelNavigation }) {
  const msg = hooks.msg ?? chinese;
  const dialogs = hooks.panel ?? { input: panelInput, edit: panelEdit, confirm: panelConfirm };
  pi.registerFlag("dag-workflow-test-child-provider", { type: "string", description: "Test-only: explicit trusted offline child provider extension" });
  const owner = createAgentsOwner(pi, hooks);
  const jobStatusLabel = (msg: Translator): Record<JobSummary['status'], string> => ({ starting: msg('启动中'), running: msg('运行中'), waiting: msg('等待回复'), completed: msg('已返回'), failed: msg('失败'), cancelled: msg('已取消'), interrupted: msg('已中断') });
  const statusLabel = (job: { status: JobSummary['status']; reportDelivery?: JobSummary['reportDelivery']; reportEmpty?: true }) => job.status === 'completed' ? (job.reportEmpty ? msg('已结束·无报告') : job.reportDelivery === 'pending' ? msg('待交付') : jobStatusLabel(msg)[job.status]) : jobStatusLabel(msg)[job.status];
  const activeStatuses = new Set<JobSummary['status']>(['starting', 'running', 'waiting']);
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
      if (action === 'unprofile') return (owner.profiles()?.list() ?? []).map((profile) => ({ token: profile.name, label: profile.name, description: profile.model ? `${profile.model.provider}/${profile.model.id}` : msg('继承主会话') }));
      if (!['wait', 'send', 'cancel', 'remove'].includes(action)) return null;
      return (owner.runtime()?.viewSummaries() ?? [])
        .filter((job) => action !== 'send' || activeStatuses.has(job.status))
        .map((job) => ({ token: job.id, label: `${job.id}${job.todoId ? ` / #${job.todoId}` : ''} · ${jobProfileLabel(job)}`, description: statusLabel(job) }));
    },
  };
  const renderResult = (result: { content: { type: string; text?: string }[]; details?: unknown; isError?: boolean }, _options: unknown, theme: ExtensionContext["ui"]["theme"]) => new Text(theme.fg(result.isError ? "error" : "text", toolDisplay(result.details, result.content.map((item) => item.text ?? "").join("\n"), msg)), 0, 0);
  /** AgentSendError carries structured direction/preflight details; ordinary causes keep safeDiagnostic. */
  const structuredFailure = (cause: unknown): Record<string, unknown> | undefined => cause instanceof AgentSendError ? cause.details as unknown as Record<string, unknown> : undefined;
  const diagnostic = async (cause: unknown): Promise<string> => {
    const details = structuredFailure(cause);
    if (details) return sendFailureLines(details, msg).join('\n');
    const original = safeDiagnostic(String(cause));
    const rejected = /Child tool is not trusted or supported: ([^\s]+)\. Allowed:/.exec(original);
    if (rejected) {
      const source = (await owner.parentTools()).find(tool => tool.delegable && tool.name === rejected[1])?.path;
      if (source) return `${original}\n${msg`${rejected[1]} 由 ${source} 提供；`}\n${msg('把该扩展加入某个 Profile 的 childExtensions（/agents → 展开 Profile）后可用。')}`;
    }
    return original;
  };
  const fail = async (cause: unknown) => { const details = structuredFailure(cause); const error = await diagnostic(cause); return { isError: true, content: [{ type: 'text' as const, text: error }], details: details ? { ...details, error } : { error } }; };

  pi.registerTool({ name: "subagent_spawn", label: "Agent", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Start a child and return jobId, status and resolved configuration. Parent defaults, selected profile, then call overrides apply. resumeFrom reuses the last actual configuration; profile:inherit resets it. Discover available tools with subagent_inspect tools:true. Skills are local references, not auto-discovered or system prompts; read is never added implicitly.",
    promptSnippet: "Use subagent_spawn to start one isolated child agent for independent work",
    parameters: AgentSpawnParamsSchema, executionMode: "sequential", renderResult,
    async execute(_id, params, signal, _update, ctx) { try { return await owner.spawn(params, signal, ctx); } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_inspect", label: "Agents", namespace: workflowNamespace, annotations: readOnly, description: "Inspect child status or discover tools/profiles/models. tools:true lists delegable tools with name, description and core/extension origin; exclusive with model/job/profile/output/wait fields. models:true returns available provider/id/name/reasoning and context limits; query searches provider/id/name, limit defaults to 20 (max100), offset defaults to 0; total and nextOffset paginate. Model discovery is exclusive with job/profile/output/wait fields; query/limit/offset require models:true. With output:true and jobId, collect output/question and todoStatus; timeout:0 is immediate. Default until:update waits up to 5s; until:finish up to 30s, max300s; after selects a newer reportVersion. Timeout/abort only ends waiting, not the child. Verify work yourself; do independent work instead of polling. profiles:'summary' lists profile settings; profile:NAME fetches one; profiles:true fetches all instructions. Directory queries cannot collect output.",
    promptSnippet: "Use subagent_inspect for child status, output and profile/model discovery",
    promptGuidelines: ["Discover profiles on demand: profiles:'summary' lists names/model/thinking/tools, profile:NAME returns one full profile with instructions, and profiles:true returns everything. Never guess a profile name or bulk-read instructions. Discover available models with models:true and optional query/limit/offset; use exact provider/id for spawn overrides."],
    parameters: AgentInspectParamsSchema, executionMode: 'parallel', renderResult,
    async execute(_id, params, signal, _update, ctx) { try { return await owner.inspect(params, signal, ctx); } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_send", label: "Agent message", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Send direction to a recipient job or answer a requestId; exactly one target. interrupt:true clears queued direction/questions and resumes the same child context. tools replaces its active set and requires recipient + interrupt:true. Returns delivery status and confirmed tools.",
    promptSnippet: "Use subagent_send to direct a child job or answer its question", parameters: AgentSendParamsSchema, executionMode: "sequential", renderResult,
    async execute(_id, params, signal, _update, ctx) { try { return await owner.send(params, signal, ctx); } catch (cause) { return fail(cause); } },
  });
  pi.registerTool({ name: "subagent_cancel", label: "Stop Agent", namespace: workflowNamespace, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, description: "Stop a child. Optional remove discards its retained record and pending notices; never completes/deletes the Todo or reverts files.",
    promptSnippet: "Use subagent_cancel to stop one child job", parameters: AgentCancelParamsSchema, executionMode: "sequential", renderResult,
    async execute(_id, params, signal, _update, ctx) { try { return await owner.cancel(params, signal, ctx); } catch (cause) { return fail(cause); } },
  });

  const panel = (id: string) => panelOptions(hooks.panel, { id: 'agents', label: 'Agents' }, `agents:${id}`);
  async function modelsMenu(ctx: ExtensionContext) {
    const epoch = owner.generation(), cursor: MenuCursor = {}, current = () => epoch === owner.generation() && !hooks.panel?.requested();
    const owned = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
    const title = msg('模型目录');
    while (current()) {
      const models = owner.availableModels(ctx);
      const selected = await owned(title, () => choose(ctx, title, models.map((model, index) => ({ id: String(index), kind: 'action', icon: glyph('models'), label: model.name, value: model.provider, valueTone: 'muted', description: model.id })), { msg, panel: { ...panel('models'), itemsZone: 'upper' }, cursor, searchable: true, isCurrent: current, lines: [msg('仅查看准确 provider/id；不切换主模型或保存 Profile')] }));
      if (!current() || selected === undefined) return;
      const model = models[Number(selected)];
      if (model) await owned(title, () => readView(ctx, title, modelSummary(model, msg).join('\n'), { msg, isCurrent: current }));
    }
  }
  function profileText(profile: Profile, field: string, value: string): Profile {
    const next = { ...profile }, text = value.trim();
    if (field === 'model') {
      if (!text) delete next.model;
      else { const slash = text.indexOf('/'); if (slash < 1 || slash === text.length - 1) throw new Error(msg('模型要写成 provider/id')); next.model = { provider: text.slice(0, slash), id: text.slice(slash + 1) }; }
    } else if (field === 'thinking') {
      if (!text || text === 'inherit') delete next.thinking;
      else next.thinking = text as NonNullable<Profile['thinking']>;
    } else if (field === 'tools') {
      if (!text || text === 'inherit') delete next.tools;
      else next.tools = text === 'none' ? [] : text.split(',').map(tool => tool.trim());
    } else if (field === 'instructions') {
      if (!text) delete next.instructions; else next.instructions = value;
    } else if (field === 'skills') next.skills = value.split('\n').map(path => path.trim()).filter(Boolean);
    return next;
  }
  function profileEntity(profile: Profile, width: number, english: boolean, availableExtensions: readonly { path: string; tools: number }[] = [], onAdd?: (path: string) => Promise<void>) {
    const model = profile.model ? modelLabel(profile.model.id, modelBudget(width)) : msg('继承主会话');
    const tools = profile.tools === undefined ? (english ? 'Inherit tools' : '继承工具') : english ? `${profile.tools.length} tools` : `${profile.tools.length} 工具`;
    const field = (id: string, label: string, value: string, icon: string) => ({ id: `${profile.name}/field/${id}`, label, value, icon, kind: 'readonly' as const, valueTone: 'muted' as const });
    const instructions = Boolean(profile.instructions?.trim());
    const skillsValue = profile.skills?.length ? english ? `${profile.skills.length} items` : `${profile.skills.length} 项` : english ? 'Not configured' : '未配置';
    const extensions = profile.childExtensions ?? [];
    // ProfileStore speaks English because its messages are written for tool callers. The panel is where a
    // human types, so the same rules are restated in the session language; anything unrecognised keeps the raw
    // diagnostic rather than inventing a translation.
    const storeText = (text: string): string => {
      if (/^instructions must be at most \d+ characters/.test(text)) return msg('Profile 指令最多 2000 个字符。');
      if (/^instructions must contain text/.test(text)) return msg('Profile 指令不能为空；留空表示移除此 Profile 的指令。');
      if (/^Skill paths must be text|^Skill path must contain text/.test(text)) return msg('技能入口需要非空的本地 Markdown 路径。');
      if (/^Skill path must be at most \d+ characters/.test(text)) return msg('技能入口路径过长：每个最多 2048 个字符。');
      if (/^Skill path must not contain control characters/.test(text)) return msg('技能入口路径里不能有控制字符。');
      if (/^Skill must be a local Markdown file path, not a URL/.test(text)) return msg('技能入口必须是本地 Markdown 文件，不能是网址。');
      if (/^Profile skills accepts at most \d+ files/.test(text)) return msg('一个 Profile 最多 8 个技能文件。');
      if (/^Invalid thinking level/.test(text)) return msg('thinking 取值不合法：inherit/off/minimal/low/medium/high/xhigh/max。');
      if (/^Selected model does not support thinking/.test(text)) return msg('所选模型不支持 thinking：请设为 off 或改用支持推理的模型。');
      if (/^Select a parent model or configure a named profile model/.test(text)) return msg('没有可继承的模型：先选主模型，或给这个 Profile 指定 model。');
      if (/^Unknown model: /.test(text)) return msg('这个模型不在本机注册表里：检查模型配置或凭据。');
      if (/^Profile name must be /.test(text)) return msg('Profile 名只能是 1–48 个字母、数字、_ 或 -，且不能叫 inherit。');
      return safeDiagnostic(text);
    };
    const validate = (field: string) => (value: string): string | undefined => {
      try { owner.profiles()!.validateDraft(profileText(profile, field, value)); return undefined; }
      catch (cause) { return storeText(String(cause)); }
    };
    // The four fields a user owns are editable here; the saved Profile is what a later dispatch reads.
    const modelText = profile.model ? `${profile.model.provider}/${profile.model.id}` : '';
    const thinkingText = profile.thinking ?? '';
    const toolsText = profile.tools === undefined ? '' : profile.tools.join(',');
    const toolsValue = profile.tools === undefined ? (english ? 'Inherit parent built-in tools' : '继承父会话内置工具') : profile.tools.length ? (english ? `${profile.tools.length} items` : `${profile.tools.length} 项`) : (english ? 'Empty set (no tools)' : '空集（不加载工具）');
    const children = [
      { id: `${profile.name}/model`, label: english ? 'Model' : '模型', value: modelText || msg('继承主会话'), icon: glyph('models'), kind: 'input' as const, valueTone: 'muted' as const, input: { title: msg('模型 provider/id（留空=继承主会话）'), value: modelText, validate: validate('model') }, description: msg('必须是与注册表一致的 provider/id；留空即继承主会话模型。只影响之后的派发，不切换当前模型。') },
      { id: `${profile.name}/thinking`, label: 'thinking', value: thinkingText || msg('继承主会话'), icon: glyph('settings'), kind: 'input' as const, valueTone: 'muted' as const, input: { title: msg('thinking：inherit/off/minimal/low/medium/high/xhigh/max'), value: thinkingText || 'inherit', validate: validate('thinking') }, description: msg('inherit（或留空）表示继承；其余取现有枚举。只影响之后的派发。') },
      { id: `${profile.name}/tools`, label: msg('工具（tools）'), value: toolsValue, icon: glyph('config-tools'), kind: 'input' as const, valueTone: 'muted' as const, input: { title: msg('工具：inherit / none / 逗号分隔的工具名'), value: toolsText || (profile.tools === undefined ? 'inherit' : 'none'), validate: validate('tools') }, description: msg('inherit（或留空）= 继承父会话当时可用的内置工具选择集（不是固定四个 core 工具）；none = 空集，一个工具都不加载；否则是逗号分隔的工具名。三者不混同。') },
      { id: `${profile.name}/isolate`, label: msg('隔离'), value: profile.isolate === true ? msg('开启') : msg('关闭'), icon: glyph('toggle'), kind: 'toggle' as const, checked: profile.isolate === true, description: msg('Team／手工会话启动时的扩展隔离选项：子进程的派发与工具集不受它影响（执行快照里没有这个字段），也不改当前模型或运行中的 Job。') },
      field('skills', english ? 'Skills' : '技能', skillsValue, glyph('skills')),
      field('instructions-state', english ? 'Instructions' : msg('指令'), instructions ? (english ? 'Configured' : '已配置') : (english ? 'Not configured' : '未配置'), glyph('edit')),
      field('extensions-state', msg('子扩展'), extensions.length ? (english ? `${extensions.length} files` : `${extensions.length} 项`) : (english ? 'Not configured' : '未配置'), glyph('extensions')),
      ...extensions.map((path, index) => ({ id: `${profile.name}/extension/${index}`, label: path, kind: 'action' as const, path: true, destructive: true, confirmation: { title: msg`从 Profile ${profile.name} 移除扩展 ${path}？`, consequences: msg('只修改此 Profile 的子扩展配置；不删除扩展文件，不影响运行中的 Job。'), action: msg('移除') }, icon: glyph('extensions'), description: msg('再按一次确认移除该扩展。') + '\n' + msg('只影响这个 Profile 的子进程；工具权限仍由派发时的选择集决定。') })),
      { id: `${profile.name}/add-extension`, label: msg('从已加载扩展选择'), icon: glyph('new'), kind: 'entity' as const, ...(!availableExtensions.some(source => !extensions.includes(source.path)) ? { disabledReason: msg('没有可添加的已加载扩展；可手动填写本地扩展路径。') } : {}), description: msg('展开选择本会话已加载的可信扩展；不改变当前会话的工具。'), children: availableExtensions.filter(source => !extensions.includes(source.path)).map((source, index) => ({ id: `${profile.name}/add-extension-path/${index}`, kind: 'action' as const, label: source.path, path: true, icon: glyph('extensions'), value: msg`${source.tools} 个工具`, valueTone: 'muted' as const, run: () => onAdd?.(source.path) })) },
      { id: `${profile.name}/add-extension-manual`, label: msg('手动输入扩展路径'), icon: glyph('edit'), kind: 'input' as const, input: { title: msg('子扩展路径'), validate: (value: string) => { const path = value.trim(); if (!path) return msg('子扩展路径不能为空。'); if (/\p{Cc}|\p{Bidi_Control}/u.test(value)) return msg('子扩展路径里不能有控制字符。'); if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return msg('子扩展必须是本地文件路径，不能是网址。'); return undefined; } }, description: msg('填一个本地扩展文件路径；保存前会验证它可加载，仅影响之后的派发。') },
      { id: `${profile.name}/instructions`, label: msg('编辑 Profile 指令'), icon: glyph('edit'), kind: 'input' as const, description: msg('最多 2000 个字符；留空移除此 Profile 的指令，不改变运行中的 Job。'), input: { title: msg('Profile 指令'), value: profile.instructions ?? '', multiline: true, validate: validate('instructions') } },
      { id: `${profile.name}/skills`, label: msg('编辑技能文件入口'), icon: glyph('skills'), kind: 'input' as const, description: msg('每行一个本地 Markdown 文件，最多 8 个；留空清空，仅影响后续派发。'), input: { title: msg('技能文件：每行一个本地 Markdown 路径'), value: (profile.skills ?? []).join('\n'), multiline: true, validate: validate('skills') } },
      { id: `${profile.name}/read`, label: msg('读取完整指令'), icon: glyph('summary'), kind: 'action' as const, description: msg('只读查看这个 Profile 的指令全文；不派发、不修改配置。'), ...(!instructions ? { disabledReason: english ? 'Instructions are not configured' : '指令未配置' } : {}) },
      { id: `${profile.name}/delete`, label: english ? 'Delete Profile' : '删除 Profile', icon: glyph('delete'), kind: 'action' as const, destructive: true, confirmation: { title: msg`删除 Profile ${profile.name}？`, consequences: msg('删除配置定义并保存；会话、项目文件和运行中的 Job 保留。'), action: msg('删除') }, description: msg('删除这条 Profile 定义并保存；不删除任何会话、文件或运行中的 Job。再按一次确认。') },
    ];
    return { id: `profile:${profile.name}`, kind: 'entity' as const, label: profile.name, icon: glyph('agents'), values: [{ text: model, tone: 'muted' as const }, { text: tools, tone: 'muted' as const }], description: msg`Profile ${profile.name}`, children };
  }
  async function agentsMenu(ctx: ExtensionContext) {
    const epoch = owner.generation(), cursor: MenuCursor = {}, detailCursor: MenuCursor = {}, current = () => epoch === owner.generation() && !hooks.panel?.requested();
    const owned = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
    let filter: 'attention' | 'all' = 'attention';
    const help: Record<string, string> = {
      spawn: msg('行内填写子任务的完整范围。') + '\n' + msg('明确提交后派发；不自动完成关联的 Todo。'),
      wait: msg('并行等待所有 Job，最多等待 5 秒。') + '\n' + msg('显示当前报告；超时不会停止子进程。'),
      models: msg('查看准确的 provider/id 与模型能力。') + '\n' + msg('查看不会切换主模型或修改 Profile。'),
      delivery: msg('关闭报告自动唤醒，也会暂停当前 Goal（如有）；子 Agent 继续运行。恢复 Goal 仍需明确启用。'),
      summary: msg('切换当前模块的常驻小组件。') + '\n' + msg('隐藏显示不会停止子 Agent。'),
      filter: msg('切换需要关注与全部 Job。') + '\n' + msg('只过滤显示，不移除记录。'),
      profiles: msg('查看并管理 Profile、指令、技能与子扩展。') + '\n' + msg('只有明确保存才会写入配置。'),
      reset: msg('清除 Agent 运行记录。') + '\n' + msg('先停止所有子 Agent，不撤销文件修改；键入 /agents 可重新开始。'),
    };
    const targets = new Map<string, { job?: JobSummary; profile?: Profile; action: string }>(), profileById = new Map<string, Profile>();
    let assignments = new Set<string>();
    const actions = (job: JobSummary) => [
      { id: 'output', icon: glyph('summary'), label: msg('阅读报告与诊断') },
      { id: 'send', icon: glyph('skills'), label: msg('发送方向'), ...(!active(job) ? { disabledReason: msg('子 Agent 已停止') } : {}) },
      { id: 'answer', icon: glyph('skills'), label: msg('回答问题'), ...(job.pendingRequests === 0 ? { disabledReason: msg('当前没有待答复问题') } : {}) },
      { id: 'cancel', icon: glyph('stop'), label: msg('停止此子 Agent'), destructive: true, confirmation: { title: msg`停止 Job ${job.id}？`, consequences: msg('停止子 Agent；保留记录和已有输出，不撤销文件修改。'), action: msg('停止') }, ...(!active(job) ? { disabledReason: msg('子 Agent 已停止') } : {}) },
      { id: 'remove', icon: glyph('delete'), label: msg('移除记录'), destructive: true, confirmation: { title: msg`移除 Job ${job.id} 的记录？`, consequences: msg('停止仍在运行的子 Agent，并丢弃保留报告和记录；项目文件保留。'), action: msg('移除') } },
      ...(['failed', 'interrupted'].includes(job.status) ? [{ id: 'redispatch', icon: glyph('autoresearch'), label: msg('重派（保留范围）'), ...(hooks.state().plan ? { disabledReason: msg('Plan 模式为只读；先 /plan off 再执行。') } : !assignments.has(job.id) ? { disabledReason: msg('原任务范围不可用') } : {}) }] : []),
    ].map(row => { const id = `${job.id}/${row.id}`; targets.set(id, { job, action: row.id }); return { ...row, id, kind: 'action' as const, description: job.id + '\n' + msg('不撤销文件修改；移除会丢弃保留报告和记录。') }; });
    /** Profile actions mutate only the freshly reloaded definition, never a stale copy. */
    async function profileAction(profile: Profile, action: string, value?: string | boolean) {
      const profileName = profile.name, english = msg('模型目录') === 'Model catalog';
      // A missing extension path must never block editing the list that contains it.
      try { await owner.childEnvironment(); } catch { /* refreshed again before saving */ }
      if (!current()) return;
      await owner.profiles()!.load(); if (!current()) return;
      const fresh = owner.profiles()!.get(profileName); if (!fresh) return;
      if (action === 'read') { await owned(msg`Profile ${profileName}`, () => readView(ctx, msg`Profile ${profileName}`, fresh.instructions?.trim() || msg('指令：未配置'), { msg, isCurrent: current })); return; }
      if (action === 'delete') {
        if (JSON.stringify(fresh) !== JSON.stringify(profile)) { notify(ctx, english ? 'Profile changed; the stale definition was not deleted' : 'Profile 已改变，未删除过期定义', 'warning'); return; }
        owner.profiles()!.delete(profileName); await owner.profiles()!.save(); return;
      }
      /** `remove` clears a field back to "inherit": a saved Profile may not keep an empty placeholder. */
      const save = async (patch: Partial<Profile>, remove: readonly (keyof Profile)[] = []) => {
        if (JSON.stringify(fresh) !== JSON.stringify(profile)) { notify(ctx, msg('Profile 已改变，未保存过期输入'), 'warning'); return; }
        // Re-read the live child environment immediately before saving so new extension tools are trusted.
        try { await owner.childEnvironment(); } catch { /* a broken path stays editable so it can be removed */ }
        if (!current()) return;
        await owner.profiles()!.load();
        if (!current()) return;
        const live = owner.profiles()!.get(profileName);
        if (!live || JSON.stringify(live) !== JSON.stringify(profile)) { notify(ctx, msg('Profile 已改变，未保存过期输入'), 'warning'); return; }
        const next = { ...live, ...patch } as Record<string, unknown>;
        for (const key of remove) delete next[key as string];
        owner.profiles()!.set(next as unknown as Profile); await owner.profiles()!.save();
      };
      const extensions = fresh.childExtensions ?? [];
      if (action.startsWith('extension/')) {
        const index = Number(action.slice('extension/'.length));
        if (!Number.isSafeInteger(index) || index < 0 || index >= extensions.length) return;
        await save({ childExtensions: extensions.filter((_, at) => at !== index) }); return;
      }
      if (action === 'add-extension') {
        const loaded = [...new Set((await owner.parentTools()).filter(tool => tool.delegable && tool.path).map(tool => tool.path!))].filter(path => !extensions.includes(path));
        const counts = new Map<string, number>();
        for (const tool of await owner.parentTools()) if (tool.delegable && tool.path) counts.set(tool.path, (counts.get(tool.path) ?? 0) + 1);
        const pickerTitle = msg('从已加载扩展中选择');
        const picked = await owned(pickerTitle, () => choose(ctx, pickerTitle, loaded.map(path => ({ id: path, kind: 'action' as const, icon: glyph('extensions'), label: path, path: true, value: msg`${counts.get(path) ?? 0} 个工具`, valueTone: 'muted' as const })), { msg, panel: panel('extension-picker'), isCurrent: current }));
        if (!current() || picked === undefined) return;
        try { await resolveChildExtensionPaths([picked], msg); } catch (cause) { notify(ctx, await diagnostic(cause), 'error'); return; }
        if (!current()) return;
        await save({ childExtensions: [...extensions, picked] }); return;
      }
      if (value === undefined) return;
      // A toggle arrives as a boolean, not as text: the isolation flag is stored as such.
      if (action === 'isolate') { await save({ isolate: value === true }); return; }
      // Everything below is text; a non-text value never reaches the text handlers.
      if (typeof value !== 'string') return;
      if (action === 'add-extension-manual') {
        const entry = value.trim();
        if (!entry) return;
        try { await resolveChildExtensionPaths([entry], msg); } catch (cause) { notify(ctx, await diagnostic(cause), 'error'); return; }
        if (!current()) return;
        await save({ childExtensions: [...new Set([...extensions, entry])] }); return;
      }
      if (['model', 'thinking', 'tools', 'instructions', 'skills'].includes(action)) {
        const next = profileText(fresh, action, value);
        const removed = (['model', 'thinking', 'tools', 'instructions', 'skills'] as const).filter(key => !(key in next));
        await save(next, removed);
      }
    }
    while (current()) {
      targets.clear(); profileById.clear();
      // A broken extension list or profile file must not block the root menu; profile edits reload below.
      try { await owner.childEnvironment(); } catch { /* reported by the extensions sub-screen */ }
      try { await owner.profiles()!.load(); } catch { /* shown on edit */ }
      if (!current()) return;
      const english = msg('模型目录') === 'Model catalog';
      const profiles = owner.profiles()!.list();
      const all = owner.ready(ctx, false).exportSummaries();
      assignments = new Set((owner.runtime()?.exportRecords() ?? []).filter(job => job.assignment?.trim()).map(job => job.id));
      // One row per loaded source, with the number of tools it can delegate: deduplicated here once.
      const extensionSources = [...(await owner.parentTools()).filter(tool => tool.delegable && tool.path).reduce((counts, tool) => counts.set(tool.path!, (counts.get(tool.path!) ?? 0) + 1), new Map<string, number>())].map(([path, tools]) => ({ path, tools }));
      const matchesFilter = (job: JobSummary) => filter === 'all' || active(job) || job.reportDelivery === 'pending' || job.todoId !== undefined && owner.todoStatusOf(job.todoId) !== 'completed' || ['failed', 'interrupted'].includes(job.status) && !job.dismissed;
      const rows = all.filter(matchesFilter), title = msg('子 Agent');
      const elapsedLabel = (job: JobSummary) => { const elapsed = Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt); return elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : `${Math.floor(elapsed / 60_000)}m`; };
      const jobTone = (job: JobSummary) => job.reportDelivery === 'pending' ? 'warning' as const : job.status === 'failed' ? 'error' as const : job.status === 'completed' ? 'success' as const : job.status === 'waiting' ? 'warning' as const : active(job) ? 'accent' as const : 'muted' as const;
      const jobEntity = (job: JobSummary) => ({
        id: job.id, kind: 'entity' as const, label: `${job.id} ${job.label ?? (job.todoId ? `Task #${job.todoId}` : msg('独立任务'))}`, icon: job.status === 'completed' ? glyph('complete') : glyph('settings'),
        values: [{ text: statusLabel(job), tone: jobTone(job) }, { text: job.todoId ? `Task #${job.todoId}` : elapsedLabel(job), tone: 'muted' as const }],
        tone: jobTone(job), description: jobSummary(job, msg).slice(0, 2).join('\n'), children: actions(job).map(action => ({ ...action, kind: 'action' as const })),
      });
      const selected = await owned(title, () => choose(ctx, title, [...rows.map(job => ({ id: job.id, label: `${job.id} ${job.label ?? ''}`, value: statusLabel(job), description: jobSummary(job, msg).slice(1, 3).join(' · ') }))], {
        msg, refreshInterval: 1000, panel: { ...panel('root'), single: false, itemsZone: 'upper', upper: (width, _query) => {
          // Read the roster and the job list again on every render: the panel repaints once a second, so a
          // job that starts, reports or fails shows up without the user moving the cursor.
          // A protected or restoring runtime cannot answer: fall back to the snapshot instead of throwing mid-render.
          const live = (() => { try { return owner.ready(ctx, false).exportSummaries().filter(matchesFilter); } catch { return rows; } })();
          return { rows: [
          { id: 'group:jobs', kind: 'heading' as const, collapsible: true, groupCount: live.length, label: msg('Job'), description: msg('Enter 或 l 展开，h 收起；g/G 跳到上区/下区首行。') },
          ...live.map(jobEntity),
          { id: 'group:profiles', kind: 'heading' as const, collapsible: true, groupCount: profiles.length, label: msg('Profile'), description: msg('Enter 或 l 展开；展开后可直接编辑指令、技能与子扩展。') + '\n' + msg('Profile 只能由你在面板里修改：模型侧只有派发时的只读引用，没有写入 Profile 的工具。') },
          ...profiles.map(profile => { const entity = profileEntity(profile, width, english, extensionSources, async path => { try { await profileAction(profile, 'add-extension-manual', path); } catch (cause) { notify(ctx, await diagnostic(cause), 'error'); } }); profileById.set(entity.id, profile); for (const child of entity.children) targets.set(child.id, { profile, action: child.id.slice(profile.name.length + 1) }); return entity; }),
        ] }; } }, cursor, searchable: true, isCurrent: current, lines: item => { const job = targets.get(item.id)?.job ?? owner.runtime()?.exportSummaries().find(value => value.id === item.id); if (job) return jobSummary({ ...job, ...(owner.todoStatusOf(job.todoId) ? { todoStatus: owner.todoStatusOf(job.todoId)! } : {}) }, msg); const profile = profileById.get(item.id); return profile ? profileSummary(profile, msg) : []; }, actions: [...(ctx.mode === 'tui' ? [{ id: 'spawn', kind: 'input' as const, icon: glyph('spawn'), ...(hooks.state().plan ? { disabledReason: msg('Plan 模式为只读；先 /plan off 再执行。') } : {}), input: { title: msg('子任务范围'), multiline: true }, run: async (value: unknown) => { const task = String(value); if (current() && task.trim()) await owner.spawn({ task }, undefined, ctx); }, label: msg('派发新 Job') }, { id: 'wait', kind: 'action' as const, icon: glyph('wait'), label: msg('等待所有 Job') }, { id: 'new-profile', kind: 'input' as const, icon: glyph('new'), input: { title: msg('Profile 名（字母、数字、_ 或 -）'), validate: (value: string) => { const name = value.trim(); try { owner.profiles()!.validateDraft({ name }); if (owner.profiles()!.get(name)) return msg`Profile ${name} 已存在；请选择该 Profile 编辑，或使用其他名称。`; return undefined; } catch (cause) { return safeDiagnostic(String(cause)); } } }, run: async (value: unknown) => { const name = String(value).trim(); if (!current() || !name) return; try { await owner.profiles()!.load(); // `set` upserts: an existing name would silently replace that Profile, so a duplicate is refused here.
          if (owner.profiles()!.get(name)) { notify(ctx, msg`Profile ${name} 已存在：未新建，也未改动它`, 'warning'); return; }
          owner.profiles()!.set({ name }); await owner.profiles()!.save(); notify(ctx, msg`已新建 Profile ${name}：模型、thinking、工具与隔离都继承`, 'info'); } catch (cause) { if (current()) notify(ctx, await diagnostic(cause), 'error'); } }, label: msg('新建 Profile'), description: msg('只写名称，其余全部继承：模型、thinking、工具、技能、指令与隔离。') + '\n' + msg('Enter 行内填写名称；Esc 取消，不创建。') }] : []), { id: 'models', kind: 'directory' as const, label: msg('模型目录'), icon: glyph('catalog'), description: msg('打开可用模型列表，按名称搜索并查看准确 provider/id；只读，不切换主模型或保存 Profile。') }, { id: 'filter', kind: 'cycle' as const, icon: glyph('filter'), choices: [msg('需要关注'), msg('全部')], run: (value: unknown) => { filter = value === msg('全部') ? 'all' : 'attention'; cursor.page = 0; }, label: msg('筛选'), value: filter === 'attention' ? msg('需要关注') : msg('全部'), valueTone: 'muted' as const }, { id: 'delivery', kind: 'toggle' as const, icon: glyph('delivery'), checked: !owner.paused(), run: (value: unknown) => { if (value !== true) { owner.pauseAutomatic(); hooks.pauseAuto?.(ctx); } else if (!hooks.resumeAuto || hooks.resumeAuto()) owner.resumeAutomatic(); else notify(ctx, msg('Goal 续跑仍暂停；先明确 /goal enable'), 'warning'); }, label: msg('结果自动唤醒'), value: owner.paused() ? msg('暂停') : msg('开启') }, { id: 'reset', kind: 'action' as const, icon: glyph('delete'), destructive: true, confirmation: { title: msg`清除 ${all.length} 个 Agent 运行记录？`, consequences: msg('先停止全部子 Agent，再清除运行记录；不撤销文件修改，历史保留。'), action: msg('清除') }, label: msg('清除 Agent 运行记录'), value: String(all.length) }, ...(ctx.mode === 'tui' ? [] : [{ id: 'profiles', kind: 'directory' as const, icon: glyph('profiles'), label: msg('Profile 列表') }])].map(item => ({ ...item, description: ('description' in item && item.description) || help[item.id] || msg('展开查看可用操作。') })) }));
      if (!current() || selected === undefined) return;
      if (cursor.handled) continue;
      if (selected === 'spawn') { const task = await dialogs.edit({ ctx, title: msg('子任务范围'), value: '', isCurrent: current }); if (current() && task?.trim()) await owner.spawn({ task }, undefined, ctx); continue; }
      if (selected === 'wait') { const results = await Promise.all(all.map(job => owner.ready(ctx, false).wait(job.id, { timeout: 5, until: 'finish', ...(ctx.signal ? { signal: ctx.signal } : {}) }))); if (current()) await readView(ctx, msg('等待所有 Job'), results.map(job => jobSummary(job, msg).join('\n')).join('\n\n') || msg('暂无 Job'), { msg, isCurrent: current }); continue; }
      if (selected === 'models') { await modelsMenu(ctx); continue; }
      if (selected === 'filter') { filter = filter === 'all' ? 'attention' : 'all'; cursor.page = 0; continue; }
      if (selected === 'summary') { hooks.setSummary?.(hooks.summary?.() === false, ctx); continue; }
      if (selected === 'delivery') { if (!owner.paused()) { owner.pauseAutomatic(); hooks.pauseAuto?.(ctx); } else if (!hooks.resumeAuto || hooks.resumeAuto()) { owner.resumeAutomatic(); } else notify(ctx, msg('Goal 续跑仍暂停；先明确 /goal enable'), 'warning'); continue; }
      if (selected === 'reset') {
        const ownGeneration = owner.generation();
        if (current() && ownGeneration === owner.generation()) await owner.reset(ctx, ownGeneration);
        continue;
      }
      if (selected === 'profiles') {
        const title = msg('Profile'), list = owner.profiles()!.list();
        const name = await owned(title, () => choose(ctx, title, list.map(profile => ({ id: profile.name, label: profile.name, value: profile.model ? `${profile.model.provider}/${profile.model.id}` : msg('继承主会话'), description: profile.tools?.join(', ') ?? msg('继承主会话核心工具') })), { msg, panel: panel('profile'), isCurrent: current, searchable: true }));
        if (!current() || name === undefined) continue;
        const profile = list.find(value => value.name === name); if (!profile) continue;
        const detail = msg`Profile ${profile.name}`;
        // The single-object Profile chooser is a text-client fallback only; TUI expands it in place.
        const action = ctx.mode !== 'tui' ? await owned(detail, () => choose(ctx, detail, profileEntity(profile, 96, msg('模型目录') === 'Model catalog').children.map((child: MenuItem) => ({ id: child.id.slice(profile.name.length + 1), label: child.label, description: child.description ?? '', ...(child.destructive ? { destructive: true, ...(child.confirmation ? { confirmation: child.confirmation } : {}) } : {}) })), { msg, panel: panel(`profile:${profile.name}`), isCurrent: current, searchable: true, lines: profileSummary(profile, msg) })) : undefined;
        if (!current() || action === undefined) continue;
        const inputTitle = action === 'instructions' ? msg('Profile 指令') : action === 'skills' ? msg('技能文件：每行一个本地 Markdown 路径') : action === 'add-extension-manual' ? msg('子扩展路径') : undefined;
        const input = inputTitle === undefined ? undefined : await owned(inputTitle, () => dialogs.edit({ ctx, title: inputTitle, value: action === 'instructions' ? profile.instructions ?? '' : action === 'skills' ? (profile.skills ?? []).join('\n') : '', isCurrent: current }));
        if (!current()) continue;
        try { await profileAction(profile, action, input === undefined ? undefined : String(input)); } catch (cause) { if (current()) notify(ctx, await diagnostic(cause), 'error'); }
        continue;
      }
      const target = targets.get(selected);
      if (target?.profile) {
        // The panel hands back what the row declared: a text value or a toggle's boolean. `profileAction`
        // knows which action takes which, so nothing here decodes the row kind.
        try { await profileAction(target.profile, target.action, cursor.value as string | boolean | undefined); } catch (cause) { if (current()) notify(ctx, await diagnostic(cause), 'error'); }
        continue;
      }
      const job = owner.runtime()?.exportSummaries().find(job => job.id === (target?.job?.id ?? selected)); if (!job) continue;
      const jobTitle = `${job.id} · ${job.label ?? jobProfileLabel(job)}`;
      const snapshot = owner.ready(ctx, false).exportRecords().find(record => record.id === job.id)!;
      const action = target?.action ?? (ctx.mode !== 'tui' ? await owned(jobTitle, () => choose(ctx, jobTitle, [
        { id: 'output', label: msg('阅读报告与诊断') },
        { id: 'send', label: msg('发送方向'), ...(!active(job) ? { disabledReason: msg('子 Agent 已停止') } : {}) },
        { id: 'answer', label: msg('回答问题'), ...(job.pendingRequests === 0 ? { disabledReason: msg('当前没有待答复问题') } : {}) },
        { id: 'cancel', label: msg('停止此子 Agent'), destructive: true, confirmation: { title: msg`停止 Job ${job.id}？`, consequences: msg('停止子 Agent；保留记录和已有输出，不撤销文件修改。'), action: msg('停止') }, ...(!active(job) ? { disabledReason: msg('子 Agent 已停止') } : {}) },
        { id: 'remove', label: msg('移除记录'), tone: 'error', destructive: true, confirmation: { title: msg`移除 Job ${job.id} 的记录？`, consequences: msg('停止仍在运行的子 Agent，并丢弃保留报告和记录；项目文件保留。'), action: msg('移除') } },
        ...(['failed', 'interrupted'].includes(job.status) ? [{ id: 'redispatch', label: msg('重派（保留范围）'), ...(!snapshot.assignment ? { disabledReason: msg('原任务范围不可用') } : {}) }] : []),
      ], { msg, panel: panel(`job:${job.id}`), cursor: detailCursor, isCurrent: current, lines: () => jobSummary(owner.runtime()?.exportSummaries().find((value) => value.id === job.id) ?? job, msg) })) : undefined);
      if (!current() || action === undefined) continue;
      if (action === 'redispatch') { await owner.spawn({ resumeFrom: job.id, task: snapshot.assignment! }, undefined, ctx); if (!current()) return; continue; }
      if (action === 'output') { const output = await owner.ready(ctx, false).wait(job.id, { timeout: 0 }); if (current()) await owned(jobTitle, () => readView(ctx, jobTitle, jobSummary({ ...output, ...(owner.todoStatusOf(output.todoId) ? { todoStatus: owner.todoStatusOf(output.todoId)! } : {}) }, msg).join('\n'), { msg, isCurrent: current })); }
      if (action === 'send' || action === 'answer') {
        const requests = action === 'answer' ? (await owner.ready(ctx, false).wait(job.id, { timeout: 0 })).requests : [];
        if (!current()) return;
        const question = requests.length ? requests[0] : undefined;
        const inputTitle = action === 'answer' ? msg('答复子 Agent') : msg('调整子 Agent 方向');
        if (action === 'answer' && !question) { notify(ctx, msg('问题已被处理，请刷新后查看。'), 'warning'); continue; }
        const input = await owned(inputTitle, () => dialogs.edit({ ctx, title: question ? `${inputTitle} · ${question.message}` : inputTitle, value: '', isCurrent: current }));
        if (current() && input?.trim()) await owner.ready(ctx).send({ ...(action === 'answer' && question ? { requestId: question.requestId } : { recipient: job.id }), message: input });
      }
      if (action === 'cancel' || action === 'remove') {
        // choose owns the operation-specific confirmation in both terminal and text clients.
        if (current()) { if (action === 'remove' || job.status !== 'completed' || job.reportDelivery !== 'pending') owner.dropNotice(job.id); await owner.ready(ctx, false).cancel(job.id, { remove: action === 'remove' }); }
      }
    }
  }
  const command = async (args: string, ctx: ExtensionContext) => withMenuScope(ctx, async () => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify(msg('/agents list · wait jobId · send jobId 消息 · reply requestId 回答 · cancel/remove jobId · pause/resume · profiles · profile 名称 provider/model [thinking] [工具逗号列表] · unprofile 名称 · reset · Profile 的 instructions 写在配置文件里，作为该子任务的被动指导消息'), 'info'); return; }
      if (action === "reset") {
        const ownGeneration = owner.generation();
        if (!ctx.hasUI || !await dialogs.confirm({ ctx, msg, title: msg('清除 Agent 运行记录？'), value: msg('先停止所有子 Agent，不撤销文件修改；历史记录保留。'), isCurrent: () => ownGeneration === owner.generation() })) return;
        if (ownGeneration !== owner.generation()) return;
        await owner.reset(ctx, ownGeneration); return;
      }
      const agent = owner.ready(ctx, false);
      if (!args.trim()) { await agentsMenu(ctx); return; }
      if (action === 'list') {
        const jobs = agent.exportSummaries();
        ctx.ui.notify(jobs.length ? jobs.map((job) => jobSummary({ ...job, ...(owner.todoStatusOf(job.todoId) ? { todoStatus: owner.todoStatusOf(job.todoId)! } : {}) }, msg).join('\n')).join('\n\n') : msg('暂无 Job'), 'info');
        return;
      }
      if (action === 'show' || action === 'hide') { hooks.setSummary?.(action === 'show', ctx); return; }
      if (action === "pause") { owner.pauseAutomatic(); hooks.pauseAuto?.(ctx); ctx.ui.notify(msg("已关闭报告自动唤醒，并暂停当前 Goal（如有）。子 Agent 继续运行；停止请用 /agents cancel jobId。"), "info"); return; }
      if (action === "resume") { owner.ready(ctx); if (hooks.resumeAuto ? !hooks.resumeAuto() : hooks.canWake?.() === false) throw new Error(msg("Goal 续跑仍暂停；先明确 /goal enable")); owner.resumeAutomatic(); ctx.ui.notify(msg("后续新结果可自动唤醒；暂停期间旧报告仍可 /agents wait 查看"), "info"); return; }
      if (action === "cancel" || action === "remove") { if (parts.length !== 1) throw new Error(msg`/agents ${action} jobId`); const job = agent.inspect(parts[0]!)[0]!; if (action === 'remove' || job.status !== 'completed' || job.reportDelivery !== 'pending') owner.dropNotice(parts[0]!); await agent.cancel(parts[0]!, { remove: action === "remove" }); return; }
      if (action === 'wait') { if (parts.length !== 1) throw new Error(msg('/agents wait jobId')); const epoch = owner.generation(); const job = await agent.wait(parts[0]!, { timeout: 0 }); if (epoch !== owner.generation()) return; ctx.ui.notify(jobSummary({ ...job, ...(owner.todoStatusOf(job.todoId) ? { todoStatus: owner.todoStatusOf(job.todoId)! } : {}) }, msg).join('\n'), 'info'); return; }
      if (action === "send" || action === "reply") { owner.ready(ctx); const target = parts.shift(); if (!target || !parts.length) throw new Error(msg`/agents ${action} 编号 消息`); const interrupt = action === 'send' && parts[0] === '--interrupt'; if (interrupt) parts.shift(); if (!parts.length) throw new Error(msg('/agents send jobId [--interrupt] 消息')); await agent.send({ ...(action === "send" ? { recipient: target } : { requestId: target }), message: parts.join(" "), ...(interrupt ? { interrupt: true } : {}) }); if (action === "send") owner.adjusted(target); return; }
      if (action === 'profiles') {
        await owner.childEnvironment(); await owner.profiles()!.load();
        const all = owner.profiles()!.list();
        ctx.ui.notify(all.length ? all.map((profile) => profileSummary(profile, msg).join('\n')).join('\n\n') : msg('未配置 Profile'), 'info');
        return;
      }
      if (action === "profile") {
        owner.ready(ctx);
        const [name, model, thinking, tools] = parts;
        if (!name || !model || parts.length > 4 || !model.includes("/")) throw new Error(msg("/agents profile 名称 provider/model [thinking] [工具逗号列表]"));
        const split = model.indexOf("/");
        await owner.childEnvironment(); await owner.profiles()!.load();
        const previous = owner.profiles()!.get(name);
        owner.profiles()!.set({ ...previous, name, model: { provider: model.slice(0, split), id: model.slice(split + 1) }, ...(thinking ? { thinking: thinking as NonNullable<Profile["thinking"]> } : {}), ...(tools ? { tools: tools.split(",") } : {}), ...(previous?.instructions ? { instructions: previous.instructions } : {}), ...(previous?.skills !== undefined ? { skills: previous.skills } : {}) });
        await owner.profiles()!.save(); ctx.ui.notify(msg`已保存 Profile ${name}`, "info"); return;
      }
      if (action === "unprofile") { owner.ready(ctx); if (parts.length !== 1) throw new Error(msg("/agents unprofile 名称")); await owner.childEnvironment(); await owner.profiles()!.load(); owner.profiles()!.delete(parts[0]!); await owner.profiles()!.save(); return; }
      pi.sendUserMessage(`Manage the current child agents/Profiles: ${args}`, { deliverAs: "followUp" });
    } catch (cause) { notify(ctx, await diagnostic(cause), "error"); }
  });
  hooks.panel?.register(ctx => command('', ctx));
  pi.registerCommand('agents', { description: msg('子 Agent 状态／消息／取消与 Profile；也可直接描述需求'), getArgumentCompletions: prefix => completeArguments(prefix, completion), handler: async (args, ctx) => {
    if (!args.trim() && ctx.mode === 'tui' && hooks.panel) { await hooks.panel.open(ctx); return; }
    await command(args, ctx);
  } });
  const { pauseAutomatic, resumeAutomatic, summaries, cleanupProtection, cleanupRecords, assertPlanEntry, assertTodoMutation, afterTodoMutation } = owner;
  return { spawn: owner.spawn, pauseAutomatic, resumeAutomatic, summaries, cleanupProtection, cleanupRecords, assertPlanEntry, assertTodoMutation, afterTodoMutation };
}
