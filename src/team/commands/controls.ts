import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Translator } from '../../shared/i18n.ts';
import { THINKING_LEVELS } from '../../shared/profile-launch.ts';
import { holderProcess, type MemberSettings, type TeamPointer } from '../domain/teams.ts';
import { finishMemberControl, readMember, readMembers, renameMember, requestMemberControl } from '../io/registry.ts';

/** User-UI metadata, consumed by the target process; message bodies never enter this path. */
export function memberControls(pi: ExtensionAPI, hooks: {
  msg: Translator; pid(): number; instanceId: string; alive(pid: number): boolean;
  pointer(ctx: ExtensionContext): TeamPointer | undefined;
  note(ctx: ExtensionContext): Promise<boolean>;
}) {
  const { msg } = hooks;
  let applying = false, generation = 0;
  const validate = (patch: MemberSettings) => {
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !['model', 'thinking', 'memberName', 'sessionName'].includes(key))) throw new Error(msg('没有可应用的会话设置。'));
    for (const value of Object.values(patch)) if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\p{Cc}\p{Bidi_Control}]/u.test(value)) throw new Error(msg('设置需为非空短文本，不能含控制字符。'));
    if (patch.model && (patch.model.indexOf('/') < 1 || patch.model.endsWith('/'))) throw new Error(msg('模型需填写 provider/id。'));
    if (patch.thinking && !(THINKING_LEVELS as readonly string[]).includes(patch.thinking)) throw new Error(msg('思考等级不受支持。'));
    if (patch.memberName && [...patch.memberName].length > 40) throw new Error(msg('成员名需为 1–40 个字符。'));
  };
  const applyOnce = async (ctx: ExtensionContext) => {
    const scope = hooks.pointer(ctx), sid = ctx.sessionManager.getSessionId(), epoch = generation;
    if (!scope) return;
    const member = await readMember(scope.teamId, sid), request = member?.control;
    if (!member || member.holder.pid !== hooks.pid() || request?.status !== 'pending') return;
    const expected = { pid: member.holder.pid, generation: member.generation, instanceId: hooks.instanceId };
    if (request.pid !== expected.pid || request.generation !== expected.generation || request.instanceId !== hooks.instanceId) {
      await finishMemberControl(scope.teamId, sid, request.id, expected, msg('成员持有者已改变；重新提交设置。')); return;
    }
    const current = async () => {
      if (epoch !== generation || ctx.sessionManager.getSessionId() !== sid || hooks.pointer(ctx)?.teamId !== scope.teamId) return false;
      const latest = await readMember(scope.teamId, sid);
      return latest?.holder.pid === expected.pid && latest.generation === expected.generation && latest.control?.id === request.id && latest.instanceId === hooks.instanceId;
    };
    let error: string | undefined;
    try {
      validate(request.patch);
      if (!await current()) return;
      const patch = request.patch;
      if (patch.model) {
        const slash = patch.model.indexOf('/'), model = ctx.modelRegistry.find(patch.model.slice(0, slash), patch.model.slice(slash + 1));
        if (!model) throw new Error(msg('目标进程找不到此模型；重选模型后提交。'));
        let selected = false;
        try { selected = await pi.setModel(model); } catch { /* No provider diagnostics or credentials enter the roster. */ }
        if (!selected) throw new Error(msg('目标进程无法切换模型；核对模型鉴权后重新提交。'));
      }
      if (!await current()) return;
      if (patch.thinking) {
        const previous = pi.getThinkingLevel();
        pi.setThinkingLevel(patch.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
        if (pi.getThinkingLevel() !== patch.thinking) {
          pi.setThinkingLevel(previous);
          throw new Error(msg('目标模型不支持此思考等级；原等级保留，重选后提交。'));
        }
      }
      if (!await current()) return;
      if (patch.memberName) {
        const renamed = await renameMember(scope.teamId, sid, patch.memberName, expected);
        if (renamed?.name !== patch.memberName.trim()) throw new Error(msg('成员记录已改变；重新选择后改名。'));
      }
      if (!await current()) return;
      if (patch.sessionName) pi.setSessionName(patch.sessionName.trim());
    } catch (cause) { error = String(cause instanceof Error ? cause.message : msg('部分设置未应用；核对实际值后重新提交。')).slice(0, 240); }
    finally {
      if (await current()) { await hooks.note(ctx); await finishMemberControl(scope.teamId, sid, request.id, expected, error); }
    }
  };
  const apply = async (ctx: ExtensionContext, boundary = false) => {
    if (applying || !boundary && ctx.isIdle?.() === false) return;
    applying = true;
    try { await applyOnce(ctx); } finally { applying = false; }
  };
  return {
    apply,
    invalidate() { generation++; },
    async request(ctx: ExtensionContext, sid: string, patch: MemberSettings) {
      validate(patch);
      const scope = hooks.pointer(ctx), sender = scope && await readMember(scope.teamId, ctx.sessionManager.getSessionId());
      if (!scope || sender?.holder.pid !== hooks.pid()) throw new Error(msg('当前会话不再代表此团队成员；未提交设置。'));
      const target = await readMember(scope.teamId, sid), process = holderProcess(target);
      if (!target || process === undefined || !hooks.alive(process)) throw new Error(msg('目标会话未运行或无法确认存活；未提交设置。'));
      if (patch.memberName && (await readMembers(scope.teamId)).some(member => member.sessionId !== sid && member.name === patch.memberName!.trim())) throw new Error(msg('已有同名成员，请使用其他名称。'));
      if (!target.instanceId) throw new Error(msg('目标会话尚未报告控制能力；先在目标 reload 后重试。'));
      const queued = await requestMemberControl(scope.teamId, sid, sender.sessionId, patch, { pid: target.holder.pid, generation: target.generation, instanceId: target.instanceId });
      if (!queued) throw new Error(msg('成员记录已改变；重新选择后改名。'));
      if (sid === sender.sessionId) await apply(ctx);
    },
  };
}
