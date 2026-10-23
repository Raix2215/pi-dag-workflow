import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { choose, readView, panelOptions, panelRow, type MenuCursor, type MenuItem, type PanelNavigation } from '../../shared/ui/menu.ts';
import { notify } from '../../shared/terminal.ts';
import { glyph } from '../../shared/ui/symbols.ts';
import { holderProcess, memberStatus, type MemberReason, type MemberSettings, type TeamMember, type TeamPointer } from '../domain/teams.ts';
import type { LaunchMode, LaunchPlan } from '../domain/launcher.ts';
import { DESKTOP_TERMINALS, validDesktopCommand, type DesktopTerminalName } from '../../shared/config.ts';
import { assignLead, dissolveTeam, listTeams, readMember, readMembers, readTeam, renameMember } from '../io/registry.ts';
import { inboxStamp, unreadFor } from '../io/inbox.ts';

/** A new session's manual configuration: unset means the host default, as in the Profile contract. */
export interface NewSessionConfig { name?: string; profile?: string; model?: string; thinking?: string }
export interface TeamMenuHooks {
  msg?: Translator;
  panel: PanelNavigation;
  currentTeamId(): string | undefined;
  setCurrentTeam(id: string | undefined): void;
  pointer(ctx: ExtensionContext): TeamPointer | undefined;
  join(ctx: ExtensionContext, name: string): Promise<boolean>;
  leave(ctx: ExtensionContext, options?: { authorized?: boolean }): Promise<void>;
  /** `name` targets one member's record; omitted means the pointed session. */
  takeover(ctx: ExtensionContext, force?: boolean, name?: string): Promise<string>;
  /** Real takeover: claim the record and load that member's session file in this process. */
  switchTo(ctx: ExtensionContext, name: string, force?: boolean): Promise<'switched' | 'degraded'>;
  /** Stop then remove a member record; saved sessions and mailboxes stay intact. */
  evict(ctx: ExtensionContext, name: string): Promise<void>;
  /** Stop from the panel: end the process, keep the record so a pull-up can resume it. */
  stop(ctx: ExtensionContext, name: string): Promise<void>;
  /**
   * Delete a member's saved session file and that SID's mailboxes in every team (dissolved ones included).
   * User-only, destructive, and refused unless no team has a live holder for the SID.
   */
  deleteSession(ctx: ExtensionContext, name: string): Promise<void>;
  /** Desktop-window settings: the same flat config keys the launcher reads. */
  desktop(): Promise<{ terminal: DesktopTerminalName; command: string }>;
  setDesktop(patch: { desktopTerminal?: DesktopTerminalName; desktopCommand?: string }): Promise<void>;
  /** What the record itself says about a member's saved session: a real path, an explicit none, or unknown. */
  sessionFileState?(ctx: ExtensionContext, sessionId: string): Promise<'present' | 'missing' | 'unknown'>;
  /** Rebuild a member as a blank session under its own SID (only for a confirmed-exited, file-less record). */
  rebuild?(ctx: ExtensionContext, teamName: string, name: string, mode: LaunchMode): Promise<{ plan?: LaunchPlan; spawned: boolean; confirmed?: boolean; reason?: string; kept?: number }>;
  /** Read-only history of one member's saved session; never navigates or writes. */
  history(ctx: ExtensionContext, name: string, sessionId: string): Promise<void>;
  /** The command that resumes a member's session file in this terminal. */
  resumeCommand(sessionId: string): string;
  /** Liveness probe; absent means this host cannot see the pid. */
  alive?(pid: number): boolean;
  renameSession(name: string): void;
  requestControl?(ctx: ExtensionContext, sessionId: string, patch: MemberSettings): Promise<void>;
  /** Creating a team is a panel entry point, not a second IO path. */
  create(ctx: ExtensionContext, name: string): Promise<string | undefined>;
  /** Launch adapters stay in the launcher module; the menu only picks a mode. `sessionId` continues a session. */
  launch(ctx: ExtensionContext, mode: LaunchMode | 'auto', teamName: string, sessionId?: string, config?: NewSessionConfig): Promise<{ plan?: LaunchPlan; spawned: boolean; confirmed?: boolean; reason?: string; kept?: number }>;
  /** Read-only mailbox for one member: previewing never marks read and never enters the viewer's context. */
  inbox?(ctx: ExtensionContext, sessionId: string): Promise<{ id: number; from: string; body: string; createdAt: number; readAt?: number; inflight?: boolean; sourceKind: 'agent' | 'human' | 'unknown'; kind: string }[]>;
  /** A user's delivery request: mailbox metadata for the target holder, not a chat message. */
  requestDelivery?(ctx: ExtensionContext, sessionId: string, ids: number[]): Promise<void>;
  /** A user's own new message: the only path that may write a human source. */
  userSend?(ctx: ExtensionContext, sessionId: string, body: string, deliverIds?: number[]): Promise<number>;
  /** One member's own inbox policy; the caller proves its own representation first, the target is a stable id. */
  setAutoMessages?(ctx: ExtensionContext, sessionId: string, mode: 'off' | 'background' | 'all'): Promise<void>;
  pid(): number;
}
const baseLabel = (state: string, msg: Translator): string => state === 'headless' ? msg('后台') : state === 'offline' ? msg('离线') : msg('终端');
const stateTone = (state: string): 'muted' | 'warning' => state === 'offline' ? 'warning' : 'muted';
/** A bare "offline" hides the cause; every non-ok state names why and what to press. */
const stateLabel = (state: string, reason: MemberReason, pid: number | undefined, msg: Translator): string => {
  const base = baseLabel(state, msg);
  if (reason === 'exited') return msg('离线 · 持有进程已退出；按 Enter 发起接管');
  // Silence proves nothing: an unprobeable pid is reported as unknown, never as offline or stale.
  if (reason === 'unknown') return msg`离线？无法确认进程${pid === undefined ? '' : `（pid ${pid}）`}存活；按 Enter 可强制接管`;
  return base;
};
const heldLabel = (holderPid: number, msg: Translator): string => msg`由其他进程运行（PID ${holderPid}）`;
/** A member pull-up continues that session; the root entry starts a new one. */
const pullLabel = (mode: 'background' | 'split' | 'window' | 'desktop' | 'copy', msg: Translator): string => mode === 'background' ? msg('后台拉起') : mode === 'split' ? msg('分屏拉起') : mode === 'window' ? msg('tmux 新窗口拉起') : mode === 'desktop' ? msg('桌面窗口拉起') : msg('复制拉起命令');
/** `desktopTerminal` values read as choices, not as file names. */
/** A member's own inbox policy: the same three values the poller reads, named for a human. */
const AUTO_MODES = ['off', 'background', 'all'] as const;
const autoLabel = (mode: 'off' | 'background' | 'all', msg: Translator): string =>
  mode === 'off' ? msg('手动') : mode === 'background' ? msg('排队') : msg('立即');
const terminalLabel = (name: DesktopTerminalName, msg: Translator): string => name === 'auto' ? msg('自动探测') : name === 'none' ? msg('不使用') : name;

export async function teamMenu(ctx: ExtensionContext, hooks: TeamMenuHooks): Promise<void> {
  const msg = hooks.msg ?? chinese;
  let copiedCommand: string | undefined;
  // What the user typed for the next *new* session. Unset means the host default, as the Profile contract says.
  const drafts = new Map<string, NewSessionConfig>();
  // How many messages into a member's mailbox the preview window starts; per member, in this panel.
  const inboxWindow = new Map<string, number>();
  type InboxItems = Awaited<ReturnType<NonNullable<TeamMenuHooks['inbox']>>>;
  const inboxCache = new Map<string, { stamp: string; unread: number; items: InboxItems; ordered: InboxItems }>();
  // A real takeover closes the panel and swaps the session file: the loop must not mount it again.
  let leaving = false;
  const cursor: MenuCursor = {};
  while (true) {
    const teams = await listTeams(ctx.cwd);
    const stored = hooks.currentTeamId();
    const currentId = stored && teams.some(team => team.id === stored) ? stored : teams.find(team => team.id === hooks.pointer(ctx)?.teamId)?.id ?? teams[0]?.id;
    hooks.setCurrentTeam(currentId);
    let team = teams.find(item => item.id === currentId);
    let members = currentId ? (await readMembers(currentId)).map(member => ({ ...member, holder: member.holder && typeof member.holder === 'object' ? member.holder : { pid: Number.NaN, since: 0 } })) : [];
    const savedPointer = hooks.pointer(ctx);
    const membership = savedPointer && teams.some(item => item.id === savedPointer.teamId)
      ? savedPointer.teamId === currentId ? members.find(item => item.sessionId === ctx.sessionManager.getSessionId()) : await readMember(savedPointer.teamId, ctx.sessionManager.getSessionId())
      : undefined;
    const pointer = membership ? savedPointer : undefined;
    const desktopConfig = await hooks.desktop();
    const self = pointer ? members.find(member => member.sessionId === ctx.sessionManager.getSessionId()) : undefined;
    const joined = !!team && !!self && pointer?.teamId === currentId;
    const canWrite = joined && pointer?.teamId === currentId && self!.holder.pid === hooks.pid();
    // The state is computed on every redraw from pid liveness; no timer needs to refresh it.
    const statusOf = (member: TeamMember) => {
      // A released record has no process: its pid must never reach the probe.
      const probePid = holderProcess(member);
      const alive = hooks.alive && probePid !== undefined ? hooks.alive(probePid) : undefined;
      const status = memberStatus(member, alive, member.state === 'headless');
      return { ...status, held: alive === true && member.holder.pid !== hooks.pid() };
    };
    const unread = new Map<string, number>();
    // A preview is read-only data; it never marks anything read and never reaches the viewer's context.
    const memberInbox = new Map<string, Awaited<ReturnType<NonNullable<TeamMenuHooks['inbox']>>>>();
    // What each record itself says about its saved session: a path that is there, an explicit none, or unknown.
    const fileStates = new Map<string, 'present' | 'missing' | 'unknown'>();
    for (const member of members) {
      if (!currentId) continue;
      const key = `${currentId}:${member.sessionId}`, stamp = await inboxStamp(currentId, member.sessionId).catch(() => 'unreadable');
      let cached = inboxCache.get(key);
      if (!cached || cached.stamp !== stamp) {
        const items = hooks.inbox ? await hooks.inbox(ctx, member.sessionId).catch(() => []) : [];
        cached = { stamp, items, ordered: [...items].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id), unread: hooks.inbox ? items.filter(message => message.readAt === undefined).length : await unreadFor(currentId, member.sessionId) };
        inboxCache.set(key, cached);
      }
      unread.set(member.sessionId, cached.unread);
      if (hooks.inbox) memberInbox.set(member.sessionId, cached.items);
      if (hooks.sessionFileState) fileStates.set(member.sessionId, await hooks.sessionFileState(ctx, member.sessionId).catch(() => 'unknown'));
    }
    const fail = (cause: unknown) => notify(ctx, cause instanceof Error ? cause.message : String(cause), 'error');
    const requireCurrentWriter = async (teamId: string): Promise<TeamMember> => {
      const current = hooks.pointer(ctx);
      if (!current || current.teamId !== teamId) throw new Error(msg('面板团队已切换；请重新打开面板后操作'));
      const member = (await readMembers(teamId)).find(item => item.sessionId === ctx.sessionManager.getSessionId());
      if (!member) throw new Error(msg('团队目录里没有该成员记录；先重新加入团队'));
      if (member.holder.pid !== hooks.pid()) throw new Error(msg('已被接管：本进程已不是该成员的持有者；先重新加入或接管'));
      return member;
    };
    // Built on every redraw so a pid verdict, a rename or a dissolve is not frozen at panel-open time.
    const teamRows = () => teams.map(item => ({ id: `team:${item.id}`, kind: 'entity' as const, label: item.name, icon: glyph('agents'),
      values: [...(item.id === currentId ? [{ text: msg('正在查看'), tone: 'muted' as const }] : []), ...(item.id === pointer?.teamId ? [{ text: msg('已加入'), tone: 'accent' as const }] : [])],
      description: item.workspaceRoot, children: [
        { id: `team:${item.id}/switch`, kind: 'action' as const, icon: glyph('toggle'), label: msg('查看成员'), description: msg('只切换浏览的团队，不改变当前会话的归属。'), run: () => hooks.setCurrentTeam(item.id) },
        ...(pointer?.teamId === item.id ? [
          { id: `team:${item.id}/leave`, kind: 'action' as const, icon: glyph('delete'), destructive: true, label: msg('退出团队'), confirmation: { title: msg`退出团队 ${item.name}？`, consequences: msg('只解除本会话的团队关联；会话、信箱和其他成员保留。'), action: msg('退出') }, ...(membership?.holder?.pid === hooks.pid() ? {} : { disabledReason: msg('当前会话的成员代表权已改变；请先确认或接管代表权。') }), description: msg('退出当前会话的团队关联；会话、信箱和其他成员保留。'), run: async () => { try { await requireCurrentWriter(item.id); await hooks.leave(ctx, { authorized: true }); } catch (cause) { fail(cause); } } },
        ] : [
          { id: `team:${item.id}/join`, kind: 'action' as const, icon: glyph('agents'), label: msg('加入当前会话'), description: msg`把正在使用的会话加入 ${item.name}；不创建新会话，也不更换当前对话。`, ...(pointer ? { disabledReason: msg('先退出当前团队，再加入另一个团队。') } : {}), run: async () => { try { if (await hooks.join(ctx, item.name)) hooks.setCurrentTeam(item.id); } catch (cause) { fail(cause); } } },
        ]),
        newSessionEntry(item),
        ...(pointer?.teamId === item.id ? [{ id: `team:${item.id}/management`, kind: 'entity' as const, icon: glyph('settings'), label: msg('团队管理'), children: [{ id: `team:${item.id}/dissolve`, kind: 'action' as const, icon: glyph('delete'), destructive: true, label: msg('解散团队'), confirmation: { title: msg`解散团队 ${item.name}？`, consequences: msg('归档团队登记；不停止成员进程，不删除会话、信箱或历史。'), action: msg('解散') }, ...(membership?.holder.pid === hooks.pid() ? {} : { disabledReason: msg('当前会话的成员代表权已改变；请先确认或接管代表权。') }), description: msg('仅归档团队登记；不停止进程、不删除会话、信箱或历史。再按一次确认。'), run: async () => { try { await requireCurrentWriter(item.id); await dissolveTeam(item.id); await hooks.leave(ctx, { authorized: true }); hooks.setCurrentTeam(undefined); notify(ctx, msg`团队 ${item.name} 已解散：会话与信箱保留，进程未停止`, 'info'); } catch (cause) { fail(cause); } } }] }] : []),
      ] }));
    let nextRosterRead = Date.now() + 1000, rosterRead: Promise<void> | undefined;
    const refreshRoster = () => {
      if (!currentId || rosterRead || Date.now() < nextRosterRead) return;
      nextRosterRead = Date.now() + 1000;
      rosterRead = Promise.all([readMembers(currentId), readTeam(currentId)]).then(([latest, manifest]) => { team = manifest; members = latest.map(member => ({ ...member, holder: member.holder && typeof member.holder === 'object' ? member.holder : { pid: Number.NaN, since: 0 } })); }).catch(() => {}).finally(() => { rosterRead = undefined; });
    };
    const submitControl = async (sessionId: string, patch: MemberSettings) => {
      try {
        await requireCurrentWriter(currentId!);
        if (!hooks.requestControl) throw new Error(msg('当前宿主不支持运行会话设置。'));
        await hooks.requestControl(ctx, sessionId, patch);
        notify(ctx, msg('设置请求已提交；以目标会话实际值和回执为准，忙时等待当前回复及工具结束。'), 'info');
      } catch (cause) { fail(cause); }
    };
    const memberRows = () => members.map(member => {
      const targetRef = `session:${member.sessionId}`;
      const status = statusOf(member), state = status.state, badge = unread.get(member.sessionId) ?? 0;
      const selfHeld = status.held && member.sessionId === self?.sessionId;
      const isSelf = member.sessionId === self?.sessionId;
      const label = selfHeld ? heldLabel(member.holder.pid, msg) : stateLabel(state, status.reason, status.pid, msg);
      // A user's delivery request needs a holder that can actually consume it: offline/unknown is refused.
      const requestable = status.reason === 'ok' && !selfHeld;
      // Attaching a running member to this session is only offered when another process (or a dead one) holds it.
      const canTakeover = member.holder.pid !== hooks.pid();
      // The record's own fact, read once per member above; "unknown" is never a reason to rebuild.
      const fileState = fileStates.get(member.sessionId) ?? 'unknown';
      // A rebuild needs a process this host *confirmed* gone and a file this record positively says is absent.
      const canRebuild = joined && status.reason === 'exited' && fileState === 'missing' && !!team && !!hooks.rebuild;
      const controlled = !!hooks.requestControl && joined && status.reason === 'ok';
      const controlDisabled = controlled ? {} : { disabledReason: msg('需要已加入团队、目标进程可确认运行且支持会话设置。') };
      const children: MenuItem[] = [
        { id: `member:${member.sessionId}/runtime-settings`, kind: 'entity', icon: glyph('settings'), label: msg('运行配置'), description: msg('仅修改目标会话；不改全局默认或 Profile。忙时在当前回复及工具结束后应用。'), children: [
          { id: `member:${member.sessionId}/model`, kind: 'input', icon: glyph('models'), label: msg('模型'), value: member.model ?? msg('未知'), input: { title: msg('provider/id'), value: member.model ?? '' }, ...controlDisabled, description: msg('切换目标会话模型；后续请求会把当前上下文发送给该提供方。'), run: value => submitControl(member.sessionId, { model: String(value).trim() }) },
          { id: `member:${member.sessionId}/thinking`, kind: 'input', icon: glyph('thinking'), label: msg('思考等级'), value: member.thinking ?? msg('未知'), input: { title: msg('off/minimal/low/medium/high/xhigh/max'), value: member.thinking ?? '' }, ...controlDisabled, description: msg('只改目标会话的思考等级；不支持时明确拒绝并保留原等级。'), run: value => submitControl(member.sessionId, { thinking: String(value).trim() }) },
          { id: `member:${member.sessionId}/control-state`, kind: 'readonly', icon: glyph('status'), label: msg('修改状态'), value: member.control?.status === 'pending' ? msg('等待当前回复及工具结束') : member.control?.status === 'applied' ? msg('已应用') : member.control?.status === 'failed' ? msg('应用失败') : msg('无待应用修改'), description: member.control?.error ?? msg('只有目标进程实际应用后才显示成功；上方值来自目标进程。') },
        ] },
        ...(member.bootstrap ? [{ id: `member:${member.sessionId}/bootstrap`, kind: 'readonly' as const, icon: glyph('status'), label: msg('启动确认'), value: member.bootstrap === 'confirmed' ? msg('已确认') : member.bootstrap === 'failed' ? msg('确认失败') : msg('等待首次回复') }] : []),
        { id: `member:${member.sessionId}/state`, kind: 'readonly' as const, icon: glyph('status'), label: msg('状态'), value: label, valueTone: stateTone(state), description: msg('按需检查本机 PID；忙闲来自真实回合与工具事件，不用心跳超时判死，也不代表模型服务健康。') },
        ...(member.retrying ? [{ id: `member:${member.sessionId}/retrying`, kind: 'readonly' as const, icon: glyph('wait'), label: msg('重试中'), value: msg('等待重试'), valueTone: 'warning' as const, description: msg('Retry 正在为这个成员等待下一次尝试；忙闲仍来自真实回合事件。') }] : []),
        // Pull-ups continue this member's session file (`--session`); the root entry starts a new one. When the
        // old process is confirmed gone and the file is confirmed absent, the same five rows become the blank
        // rebuild: same member, same SID, no old context, and a two-press confirmation.
        { id: `member:${member.sessionId}/launch`, kind: 'entity' as const, icon: glyph('launch'), label: canRebuild ? msg('重建空白会话') : msg('启动会话'), description: msg('展开选择启动位置；已运行的会话不能再次启动。'), children: (['background', 'split', 'window', 'desktop', 'copy'] as const).map(mode => ({
          id: `member:${member.sessionId}/launch/${mode}`,
          kind: 'action' as const,
          icon: glyph(mode === 'copy' ? 'output' : mode === 'window' ? 'mode' : mode === 'background' ? 'wait' : 'launch'),
          ...(canRebuild
            ? { destructive: true, label: msg`重建空白 · ${pullLabel(mode, msg)}`, confirmation: { title: msg`重建 ${member.name} 的空白会话？`, consequences: msg('沿用成员身份和信箱；新会话不恢复旧上下文。'), action: msg('重建') } }
            : { label: pullLabel(mode, msg) }),
          description: canRebuild
            ? msg`成员 ${member.name} 已经确认退出（pid ${status.pid ?? 0}），而且确实找不到它的会话文件：上一次会话可能从未发言，或文件已被移动、删除。重建会用同一个会话 ID（${member.sessionId}）开一条**空白**会话——不恢复旧上下文；团队名册与信箱身份保持不变。` + '\n' + msg('再按一次确认重建。')
            : fileState === 'missing'
              ? msg`成员 ${member.name} 还没有保存过会话文件（从未发言或文件被移走）：拉起会用同一个会话 ID（${member.sessionId}）开一条空白会话，没有旧上下文；记录与信箱沿用。`
              : msg`接着成员 ${member.name} 的会话（--session ${member.sessionId}）重新拉起一个进程；对话与成员记录沿用原记录。`,
          ...(!team ? { disabledReason: msg('还没有团队：先新建团队') } : mode !== 'copy' && status.reason === 'ok' ? { disabledReason: msg('会话仍在运行；先停止旧进程，或使用接管会话。') } : mode !== 'copy' && status.reason === 'unknown' ? { disabledReason: msg('无法确认旧进程状态；未启动第二个进程。') } : {}),
          run: () => canRebuild ? runRebuild(mode, team!.name, targetRef) : runLaunch(mode, team!.name, member.sessionId),
        })) },
        {
          id: `member:${member.sessionId}/auto`, kind: 'cycle' as const, icon: glyph('toggle'),
          choices: AUTO_MODES.map(mode => autoLabel(mode, msg)),
          label: msg('收信策略'),
          value: autoLabel(member.autoMessages ?? 'background', msg),
          valueTone: 'muted' as const,
          description: msg('手动：仅按请求投递；排队：在当前工作结束后处理；立即：在安全工具边界处理。只设置这个成员，不停止正在运行的工具。'),
          ...(canWrite && hooks.setAutoMessages ? {} : { disabledReason: !hooks.setAutoMessages ? msg('本宿主没有提供收信策略写入') : joined ? msg('已被接管：本进程已不是该成员的持有者；先重新加入或接管') : msg('还没有团队：先加入此团队再修改收信策略') }),
          run: async (value: unknown) => {
            const index = AUTO_MODES.map(mode => autoLabel(mode, msg)).indexOf(String(value));
            if (index < 0) return;
            if (!hooks.setAutoMessages) return;
            try { await requireCurrentWriter(currentId!); await hooks.setAutoMessages(ctx, member.sessionId, AUTO_MODES[index]!); } catch (cause) { fail(cause); }
          },
        },
        {
          // The mailbox is a child entity of the member, closed by default: opening it keeps the member row
          // and its siblings in place, and Esc/h closes the mailbox before the member.
          id: `member:${member.sessionId}/inbox`, kind: 'entity' as const, icon: glyph('output'),
          label: msg('信箱'),
          values: badge ? [{ text: msg`${badge} 条未读`, tone: 'warning' as const }] : [{ text: msg('已读完'), tone: 'muted' as const }],
          description: msg('这个成员的信箱：展开后按时间从新到旧显示，每页 10 条。预览不标记已读，也不把消息送进你当前的对话。'),
          children: (() => {
            const all = memberInbox.get(member.sessionId) ?? [];
            // Newest first for reading; ties fall back to the message id, so the order never depends on
            // file order. Delivery still uses the stored order: earliest unread first, FIFO untouched.
            const ordered = inboxCache.get(`${currentId}:${member.sessionId}`)?.ordered ?? [...all].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
            const pages = Math.max(1, Math.ceil(ordered.length / 10));
            const start = Math.min(Math.max(0, Math.floor((inboxWindow.get(member.sessionId) ?? hooks.panel.memory()?.get(`team:inbox:${member.sessionId}`)?.index ?? 0) / 10)), pages - 1);
            const page = ordered.slice(start * 10, start * 10 + 10);
            const goTo = (index: number) => {
              inboxWindow.set(member.sessionId, index);
              hooks.panel.memory()?.set(`team:inbox:${member.sessionId}`, { index, query: '', searching: false });
            };
            return [
              { id: `member:${member.sessionId}/inbox/page`, kind: 'readonly' as const, icon: glyph('catalog'), label: msg('页码'), value: msg`第 ${start + 1}/${pages} 页`, valueTone: 'muted' as const, description: msg('全部历史都保留；这里只换显示的那十条，按时间从新到旧。') },
              ...page.flatMap(message => ([
                {
                  id: `member:${member.sessionId}/inbox/${message.id}`, kind: 'action' as const, icon: glyph('skills'),
                  label: `#${message.id} ${message.sourceKind === 'human' ? msg('用户') : message.sourceKind === 'agent' ? msg('成员') : msg('来源未知')} · ${message.from}`,
                  value: message.readAt === undefined ? (message.inflight ? msg('已在途中') : msg('未读')) : msg('已读'),
                  valueTone: message.readAt === undefined ? ('warning' as const) : ('muted' as const),
                  description: message.body,
                  run: () => readView(ctx, msg('消息正文'), message.body, { msg }),
                },
                ...(joined && message.readAt === undefined ? [{
                  id: `member:${member.sessionId}/inbox/${message.id}/deliver`, kind: 'action' as const, icon: glyph('send'),
                  label: msg`投递并处理 #${message.id}`,
                  ...(!requestable ? { disabledReason: msg('目标成员没有可确认的进程：不能请求投递（消息仍可发送）') } : message.inflight ? { disabledReason: msg('已在途中') } : {}),
                  run: async () => { try { await requireCurrentWriter(currentId!); if (!hooks.requestDelivery) throw new Error(msg('本宿主没有提供投递请求')); await hooks.requestDelivery(ctx, member.sessionId, [message.id]); notify(ctx, msg`已请求 ${member.name} 投递 #${message.id}`, 'info'); } catch (cause) { fail(cause); } },
                }] : []),
              ])),
              {
                id: `member:${member.sessionId}/inbox/prev`, kind: 'action' as const, icon: glyph('up'), label: msg('上一页'), description: msg('翻到较早的十条；只换显示，不标记已读，也不改变投递顺序。'),
                ...(start === 0 ? { disabledReason: msg('已经是第一页') } : {}),
                run: () => goTo(Math.max(0, start - 1) * 10),
              },
              {
                id: `member:${member.sessionId}/inbox/next`, kind: 'action' as const, icon: glyph('down'), label: msg('下一页'), description: msg('翻到较新的十条；只换显示，不标记已读，也不改变投递顺序。'),
                ...(start >= pages - 1 ? { disabledReason: msg('已经是最后一页') } : {}),
                run: () => goTo(Math.min(pages - 1, start + 1) * 10),
              },
              {
                id: `member:${member.sessionId}/inbox/deliver-earliest`, kind: 'action' as const, icon: glyph('send'),
                label: msg('投递最早未读（最多 10 条）'),
                ...(requestable ? {} : { disabledReason: msg('目标成员没有可确认的进程：不能请求投递（消息仍可发送）') }),
                description: msg('以用户身份请这个成员处理最早未读的一批；旧 Agent 消息仍保持 Agent 来源。'),
                run: async () => { try {
                  await requireCurrentWriter(currentId!);
                  // Stored order, not the reading order above: earliest unread first, the same FIFO the poller uses.
                  const ids = all.filter(message => message.readAt === undefined && !message.inflight).slice(0, 10).map(message => message.id);
                  if (!ids.length) { notify(ctx, msg('没有未读消息'), 'info'); return; }
                  if (!hooks.requestDelivery) throw new Error(msg('本宿主没有提供投递请求'));
                  await hooks.requestDelivery(ctx, member.sessionId, ids);
                  notify(ctx, msg`已请求 ${member.name} 处理 ${ids.length} 条未读`, 'info');
                } catch (cause) { fail(cause); } },
              },
            ];
          })(),
        },
        {
          id: `member:${member.sessionId}/history`, kind: 'action' as const, icon: glyph('agents'),
          label: msg('会话历史'),
          description: msg`只读查看 ${member.name} 的已保存会话：原生树里的全部分支、Enter 展开该节点全文；不切换会话、不改文件。`,
          run: async () => { try { await hooks.history(ctx, member.name, member.sessionId); } catch (cause) { fail(cause); } },
        },
        // Its own row, not part of stop or evict: this destroys a saved session and every mailbox for that SID.
        // The description is the second confirmation: it names the target, the session id and the exact scope.
        {
          id: `member:${member.sessionId}/delete-session`, kind: 'action' as const, icon: glyph('delete'), destructive: true,
          label: msg('删除会话与信箱'),
          confirmation: { title: msg`删除 ${member.name} 的会话与信箱？`, consequences: msg('会话文件优先移入回收站、失败则永久删除；清理所有团队中的该会话信箱及本团队成员记录，其他成员保留。'), action: msg('删除') },
          description: msg`删除成员 ${member.name} 的 Pi 会话文件（${member.sessionId}），以及该会话在所有团队（含已解散残留）里的信箱。会话内容不可恢复；其它收件人的邮箱与团队任务、目标不受影响。` + '\n' + msg('再按一次确认删除。'),
          ...(isSelf || member.holder.pid === hooks.pid() ? { disabledReason: msg('不能删除当前正在使用的会话：先退出这个会话再删') } : status.reason === 'ok' ? { disabledReason: msg('会话仍在运行；先停止旧进程再删除。') } : status.reason === 'unknown' ? { disabledReason: msg('无法确认进程状态；不会删除会话。先让该成员写入状态，或确认它已退出后再删。') } : {}),
          run: async () => { try { await hooks.deleteSession(ctx, targetRef); } catch (cause) { fail(cause); } },
        },
        ...(joined && canTakeover ? [
          { id: `member:${member.sessionId}/takeover`, kind: 'action' as const, icon: glyph('send'), label: msg('接管会话'), ...(status.reason === 'ok' ? { disabledReason: msg('成员仍在运行；先停止旧进程，或明确选择强制接管。') } : status.reason === 'unknown' ? { disabledReason: msg('无法确认进程状态；不会切换会话。可用「强制接管」，或等该成员写入状态后重试。') } : fileState === 'missing' ? { disabledReason: msg('会话尚未保存；没有可供接管的对话文件。') } : {}), description: msg`在当前终端打开 ${member.name} 的已保存对话：先停下仍在运行的旧进程，它不再写共享状态，然后才打开文件；当前对话不会被删除。`, run: async () => { leaving = true; try { leaving = await hooks.switchTo(ctx, targetRef) === 'switched'; } catch (cause) { leaving = false; fail(cause); } } },
          { id: `member:${member.sessionId}/takeover-force`, kind: 'action' as const, icon: glyph('toggle'), destructive: true, label: msg('强制接管'), confirmation: { title: msg`强制接管 ${member.name}？`, consequences: msg('把该成员会话交给当前进程；等待旧进程退出后打开，不删除历史。'), action: msg('接管') }, ...(status.reason === 'unknown' ? { disabledReason: msg('无法确认进程状态；不会切换会话。可用「强制接管」，或等该成员写入状态后重试。') } : fileState === 'missing' ? { disabledReason: msg('会话尚未保存；没有可供接管的对话文件。') } : {}), description: msg`${member.name} 的进程仍在运行也硬换：旧进程在下一个边界停止并停写共享状态，成员代表权立即转给本会话。` + '\n' + msg('再按一次确认强制接管。'), run: async () => { leaving = true; try { leaving = await hooks.switchTo(ctx, targetRef, true) === 'switched'; } catch (cause) { leaving = false; fail(cause); } } },
        ] : []),
        ...(joined && !isSelf ? [
          { id: `member:${member.sessionId}/send`, kind: 'input' as const, icon: glyph('skills'), input: { title: msg('消息正文'), multiline: true, validate: (value: string) => !value.trim() ? msg('消息正文不能为空；写一句可执行的说明再发送') : Buffer.byteLength(value, 'utf8') > 8192 ? msg('消息正文超过 8 KiB：拆分要点、附上文件路径，或只发摘要后请对方读取文件') : undefined }, label: msg('发送消息'), description: msg('以你的身份向此成员发送新消息。发送成功不代表对方已读或已执行。'), run: async (value: unknown) => { try { await requireCurrentWriter(currentId!); if (!hooks.userSend) throw new Error(msg('本宿主没有提供用户写入')); await hooks.userSend(ctx, member.sessionId, String(value)); notify(ctx, msg`已发送给 ${member.name}`, 'info'); } catch (cause) { fail(cause); } } },
        ] : []),
        ...(joined && team && team.leadMemberName !== member.name ? [
          { id: `member:${member.sessionId}/assign-lead`, kind: 'action' as const, icon: glyph('agents'), label: msg('移交领队'), description: msg`把领队名分移给 ${member.name}；不改变成员代表权、会话记录或信箱。`, run: async () => { try { await requireCurrentWriter(currentId!); const target = (await readMembers(currentId!)).find(item => item.sessionId === member.sessionId); if (!target) throw new Error(msg('该会话已不在团队名册中；请刷新后重新选择。')); await assignLead(currentId!, target.name); notify(ctx, msg`已将领队移交给 ${member.name}`, 'info'); } catch (cause) { fail(cause); } } },
        ] : []),
        ...((isSelf || joined ? [
          { id: `member:${member.sessionId}/rename-member`, kind: 'input' as const, icon: glyph('edit'), input: { title: msg('成员名'), value: member.name, validate: (value: string) => !value.trim() ? msg('成员名不能为空。') : members.some(item => item.sessionId !== member.sessionId && item.name === value.trim()) ? msg('已有同名成员，请使用其他名称。') : undefined }, label: msg('重命名成员'), ...(!isSelf ? controlDisabled : {}), description: msg('只改团队名册里的成员名；不改 Pi 会话名、会话文件或信箱。'), run: async (value: unknown) => { if (hooks.requestControl) { await submitControl(member.sessionId, { memberName: String(value).trim() }); return; } if (!isSelf) return; try { await requireCurrentWriter(currentId!); const renamed = await renameMember(currentId!, member.sessionId, String(value)); if (!renamed) throw new Error(msg('该会话已不在团队名册中；请刷新后重新选择。')); notify(ctx, msg('成员名已更新（不修改 Pi 会话名）'), 'info'); } catch (cause) { fail(cause); } } },
          { id: `member:${member.sessionId}/rename-session`, kind: 'input' as const, icon: glyph('edit'), input: { title: msg('会话名'), value: member.sessionName ?? (isSelf ? ctx.sessionManager.getSessionName?.() ?? '' : ''), validate: (value: string) => value.trim() ? undefined : msg('会话名不能为空。') }, label: msg('重命名会话'), ...(!isSelf ? controlDisabled : {}), description: msg('只改目标 Pi 会话名；成员名、SID与历史保持。'), run: async (value: unknown) => { const name = String(value).trim(); if (!name) return; if (hooks.requestControl) { await submitControl(member.sessionId, { sessionName: name }); return; } if (!isSelf) return; hooks.renameSession(name); notify(ctx, msg`已重命名会话：${name}（成员名不变）`, 'info'); } },
        ] : [])),
        // Stopping needs a process to stop: a record without a live pid has nothing to end.
        ...(joined && !isSelf && member.holder.pid !== hooks.pid() && status.reason === 'ok' ? [
          { id: `member:${member.sessionId}/stop`, kind: 'action' as const, icon: glyph('stop'), destructive: true, label: msg('停止此成员进程'), confirmation: { title: msg`停止 ${member.name} 的进程？`, consequences: msg('停止进程并清理运行通道；成员记录、会话和信箱保留。'), action: msg('停止') }, description: msg`结束成员 ${member.name} 的进程并删掉它的 FIFO 与日志；记录保留为 offline，可用「拉起」重新接上这条会话。` + '\n' + msg('再按一次确认停止。'), run: async () => { try { await requireCurrentWriter(currentId!); await hooks.stop(ctx, targetRef); notify(ctx, msg`已停止 ${member.name} 的进程；记录转为 offline，可用「拉起」恢复`, 'info'); } catch (cause) { fail(cause); } } },
        ] : []),
        ...(isSelf ? [] : joined ? [
          { id: `member:${member.sessionId}/evict`, kind: 'action' as const, icon: glyph('remove'), destructive: true, label: status.reason === 'ok' ? msg('停止并移出团队') : msg('移出团队'), confirmation: { title: status.reason === 'ok' ? msg`停止并移出 ${member.name}？` : msg`移出成员 ${member.name}？`, consequences: status.reason === 'ok' ? msg('停止进程并移除名册记录；会话文件和信箱保留。') : msg('仅移除名册记录；会话文件和信箱保留。'), action: status.reason === 'ok' ? msg('停止并移出') : msg('移出') }, ...(status.reason === 'unknown' || member.holder.pid === hooks.pid() ? { disabledReason: msg('无法安全停止该成员；未提供移出操作。') } : {}), description: msg`把 ${member.name} 移出名册：先停它的进程，再删除成员记录；会话文件与信箱都保留。` + '\n' + msg('再按一次确认移出。'), run: async () => { try { await requireCurrentWriter(currentId!); await hooks.evict(ctx, targetRef); notify(ctx, msg`已将 ${member.name} 移出名册；会话文件保留`, 'info'); } catch (cause) { fail(cause); } } },
        ] : []),
      ];
      const isLead = team?.leadMemberName === member.name;
      const suffix = (row: MenuItem) => row.id.split('/').at(-1)!;
      const operations = new Set(['runtime-settings', 'launch', 'takeover', 'takeover-force', 'stop']);
      const management = new Set(['auto', 'rename-member', 'rename-session', 'assign-lead', 'evict', 'delete-session']);
      const grouped: MenuItem[] = [
        ...children.filter(row => !operations.has(suffix(row)) && !management.has(suffix(row))),
        { id: `member:${member.sessionId}/session-operations`, kind: 'entity', icon: glyph('launch'), label: msg('会话操作'), children: children.filter(row => operations.has(suffix(row))) },
        { id: `member:${member.sessionId}/management`, kind: 'entity', icon: glyph('settings'), label: msg('成员管理'), children: children.filter(row => management.has(suffix(row))) },
      ];
      children.splice(0, children.length, ...grouped.filter(row => row.kind !== 'entity' || row.children?.length));
      return { id: `member:${member.sessionId}`, kind: 'entity' as const, label: member.name, icon: glyph('agents'), values: [...(isLead ? [{ text: msg('领队'), tone: 'accent' as const }] : []), { text: label, tone: selfHeld ? 'warning' as const : stateTone(state) }, ...(status.reason === 'ok' && (member.retrying || member.busy !== undefined) ? [{ text: member.retrying ? msg('等待重试') : member.busy ? msg('忙碌') : msg('空闲'), tone: member.retrying ? 'warning' as const : 'muted' as const }] : []), ...(badge ? [{ text: msg`${badge} 条未读`, tone: badge > 20 ? 'warning' as const : 'muted' as const }] : [])], ...(state === 'offline' || selfHeld ? { tone: 'warning' as const } : {}), description: member.role ? msg`角色：${member.role}` : msg('团队成员'), children };
    });
    const info = () => [{ label: msg('本会话团队'), value: teams.find(item => item.id === pointer?.teamId)?.name ?? msg('未加入'), line: 0 as const, tone: 'muted' as const }, { label: msg('正在查看'), value: team?.name ?? msg('无'), line: 0 as const, tone: 'muted' as const }, { label: msg('领队'), value: team?.leadMemberName ?? msg('无领队待命'), line: 1 as const, tone: 'muted' as const }];
    const launchLabel = (mode: LaunchMode | 'auto'): string => mode === 'auto' ? msg('自动检测') : mode === 'split' ? msg('分屏启动') : mode === 'window' ? msg('tmux 新窗口') : mode === 'desktop' ? msg('桌面窗口') : mode === 'background' ? msg('后台启动') : msg('复制启动命令');
    /** `sessionId` set means "continue this member"; omitted means "start a new session". */
    const runLaunch = async (mode: LaunchMode | 'auto', teamName: string, sessionId?: string, config?: NewSessionConfig) => {
      try {
        if (currentId && hooks.pointer(ctx)?.teamId === currentId) await requireCurrentWriter(currentId);
        const { plan, spawned, confirmed, reason } = await hooks.launch(ctx, mode, teamName, sessionId, config);
        // A copyable launch keeps the command in the row description, so the hint slot can be pasted from.
        if (!spawned && plan) copiedCommand = plan.command;
        const what = sessionId ? msg`接着成员会话` : msg('新建会话');
        // A launch that died in the first second is a failure, not a copyable command.
        if (reason !== undefined) notify(ctx, msg`派发失败：${reason}`, 'error');
        // Only a verified member is "started"; a window launch is a request the terminal may not honour.
        else notify(ctx, !spawned ? msg`复制这条命令${what}（开头的 node 是 Pi 宿主解释器，后面是 Pi 入口 cli.js；可直接粘贴执行）：${plan?.command ?? ''}`
          : confirmed === true ? msg`已启动${what}（${launchLabel(mode)}）：${plan?.command ?? ''}`
          : msg`已提交启动请求（${launchLabel(mode)}）；目标会话是否就绪，以成员列表的实际状态为准。`, 'info');
      } catch (cause) { fail(cause); }
    };
    /** A two-press rebuild: same member and SID, blank session, never a resume of the old file. */
    const runRebuild = async (mode: LaunchMode, teamName: string, name: string) => {
      try {
        if (currentId && hooks.pointer(ctx)?.teamId === currentId) await requireCurrentWriter(currentId);
        const { plan, spawned, confirmed, reason } = await hooks.rebuild!(ctx, teamName, name, mode);
        if (!spawned && plan) copiedCommand = plan.command;
        if (reason !== undefined) notify(ctx, msg`重建失败：${reason}`, 'error');
        else if (!spawned) notify(ctx, msg`复制这条重建命令（不恢复旧上下文；开头的 node 是 Pi 宿主解释器，可直接粘贴执行）：${plan?.command ?? ''}`, 'warning');
        else notify(ctx, confirmed === true ? msg`已重建空白会话（${launchLabel(mode)}），同一会话 ID；旧上下文没有恢复：${plan?.command ?? ''}`
          : msg`已提交重建请求，未确认新的 Pi 已就绪（${launchLabel(mode)}）：${plan?.command ?? ''}`, 'info');
      } catch (cause) { fail(cause); }
    };
    // One launch draft per explicit target team; browsing another team never retargets a saved action.
    const newSessionEntry = (target: typeof teams[number]): MenuItem => {
    const draft = drafts.get(target.id) ?? {};
    drafts.set(target.id, draft);
    const scope = `team:${target.id}/new-session`;
    const newSessionRows = (['auto', 'split', 'window', 'desktop', 'background', 'copy'] as const).map(mode => ({
      id: `${scope}/${mode}`, kind: 'action' as const,
      icon: glyph(mode === 'copy' ? 'output' : mode === 'desktop' ? 'display' : mode === 'window' ? 'mode' : mode === 'background' ? 'wait' : 'launch'),
      label: launchLabel(mode),
      description: mode === 'copy' ? copiedCommand ?? msg('把完整命令写进提示槽，不启动进程。')
        : mode === 'desktop' ? msg('在桌面终端（kitty／gnome-terminal／konsole／alacritty）里开一个新窗口；没有终端时降级为复制命令。')
        : mode === 'window' ? msg('在 tmux 里开一个新窗口（不是桌面终端窗口）。')
        : msg('新建会话并加入该团队；不改变本会话归属。'),
      run: () => runLaunch(mode, target.name, undefined, { ...draft }),
    }));
    /**
     * The manual configuration a new session starts with: name, Profile, model and thinking. Values reach
     * the launcher as request fields, so the existing argv builder quotes them (a leading '-' is data, not
     * a flag) and a requested Profile is preflighted before anything spawns.
     */
    const draftRow = (id: string, label: string, title: string, current: string | undefined, description: string, validate?: (value: string) => string | undefined) => ({
      id: `${scope}/${id}`, kind: 'input' as const, icon: glyph('edit'),
      input: { title, ...(current === undefined ? {} : { value: current }), ...(validate ? { validate } : {}) },
      label,
      value: current || msg('默认'),
      valueTone: 'muted' as const,
      description,
      run: (value: unknown) => {
        const text = String(value).trim();
        if (text && validate) { const problem = validate(text); if (problem) { fail(problem); return; } }
        if (text) (draft as Record<string, string>)[id] = text;
        else delete (draft as Record<string, string>)[id];
      },
    });
    const newSessionConfigRows = [
      draftRow('name', msg('名称'), msg('成员名'), draft.name, msg('新会话名称，同时用作初始成员名；以后可分别重命名。留空由新进程默认命名。')),
      draftRow('profile', msg('Profile'), msg('Profile 名'), draft.profile, msg('用 /agents 里已有的 Profile：工具、模型与隔离设置按它的契约；留空不改。')),
      draftRow('model', msg('模型'), msg('provider/id'), draft.model, msg('本次新会话使用的 provider/id。留空使用所选 Profile 或新进程默认模型，不复制当前会话的临时模型选择。')),
      draftRow('thinking', msg('thinking'), msg('off/minimal/low/medium/high/xhigh/max'), draft.thinking, msg('本次新会话的思考级别；留空使用 Profile 或新进程默认值。'), text => (/^(off|minimal|low|medium|high|xhigh|max)$/.test(text) ? undefined : msg('thinking 必须是 off/minimal/low/medium/high/xhigh/max'))),
    ];
    return { id: scope, kind: 'entity', icon: glyph('new'), label: msg('新建会话'), value: target.name,
      description: msg`新会话加入团队 ${target.name}；不会改变本会话所属团队。`,
      children: [...newSessionConfigRows, { id: `${scope}/launch`, kind: 'entity', icon: glyph('launch'), label: msg('启动方式'), description: msg`新会话将加入 ${target.name}`, children: newSessionRows }] };
    };
    const actions: MenuItem[] = [
      { id: 'new-team', kind: 'input' as const, icon: glyph('new'), input: { title: msg('团队名'), validate: (value: string) => !value.trim() || value.trim().length > 40 ? msg('团队名需为 1–40 个字符。') : teams.some(item => item.name === value.trim()) ? msg('该团队已存在；请使用“加入团队”。') : undefined }, label: msg('新建团队'), description: msg('只创建团队。随后用“加入团队”加入当前会话，或用“新建会话”启动成员。') + '\n' + msg('Enter 行内填写名称；Esc 取消，不创建团队。'), run: async (value: unknown) => { try { await hooks.create(ctx, String(value)); } catch (cause) { fail(cause); } } },
      { id: 'desktop-terminal', kind: 'cycle' as const, icon: glyph('display'), choices: DESKTOP_TERMINALS.map(name => terminalLabel(name, msg)), label: msg('桌面终端'), value: terminalLabel(desktopConfig.terminal, msg), valueTone: 'muted' as const, description: msg('桌面启动使用的终端。auto 自动探测，none 不启动桌面窗口；自定义模板若已设置则优先使用。'), run: async (value: unknown) => { const index = DESKTOP_TERMINALS.map(name => terminalLabel(name, msg)).indexOf(String(value)); if (index < 0) return; try { await hooks.setDesktop({ desktopTerminal: DESKTOP_TERMINALS[index]! }); } catch (cause) { fail(cause); } } },
      { id: 'desktop-command', kind: 'input' as const, icon: glyph('output'), input: { title: msg('自定义命令模板（含 {command}）'), value: desktopConfig.command, validate: (value: string) => { const text = String(value).trim(); return text && !validDesktopCommand(text) ? msg('模板必须包含 {command}，且不超过 200 字符') : undefined; } }, label: msg('自定义命令'), value: desktopConfig.command || msg('无'), valueTone: 'muted' as const, description: msg('模板优先于上面的终端；必须包含 {command}，例如 wezterm start -- {command}。保存到 desktopCommand。'), run: async (value: unknown) => { const text = String(value).trim(); if (text && !validDesktopCommand(text)) { fail(msg('模板必须包含 {command}，且不超过 200 字符')); return; } try { await hooks.setDesktop({ desktopCommand: text }); } catch (cause) { fail(cause); } } },
    ];
    const selected = await choose(ctx, msg('Team'), [], { msg, cursor, refreshInterval: 1000, panel: { ...panelOptions(hooks.panel, { id: 'team', label: 'Team' }, 'team:root', []), single: false, itemsZone: 'lower', info, upper: () => { refreshRoster(); return { rows: [
      { id: 'group:teams', kind: 'heading' as const, collapsible: true, groupCount: teams.length, label: msg('团队') },
      ...teamRows().map(panelRow),
      { id: 'group:members', kind: 'heading' as const, collapsible: true, groupCount: members.length, label: msg('成员') },
      ...memberRows().map(panelRow),
    ], info: info() }; } }, actions: [actions[0]!, { id: 'launch-settings', kind: 'entity', icon: glyph('settings'), label: msg('启动设置'), description: msg('桌面终端与命令模板；不启动会话，也不改变成员归属。'), children: actions.slice(1) }], searchable: true });
    // A closed panel answers `undefined`: exit before the inline-handled branch can loop forever.
    if (leaving || selected === undefined || cursor.closed) return;
    if (cursor.handled) continue;
  }
}
