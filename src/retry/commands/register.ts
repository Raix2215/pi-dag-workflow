import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createRetryOwner, type Hooks } from '../domain/owner.ts';
import { registerRetryCommand } from './menu.ts';
import type { PanelNavigation } from '../../shared/ui/menu.ts';

export function registerRetry(pi: ExtensionAPI, hooks: Hooks & { panel?: PanelNavigation }) {
  const owner = createRetryOwner(pi, hooks);
  registerRetryCommand(pi, hooks, owner);
  pi.on('agent_settled', owner.onAgentSettled);
  pi.on('turn_start', owner.onTurnStart);
  pi.on('turn_end', owner.onTurnEnd);
  pi.on('agent_end', owner.onAgentEnd);
  pi.on('input', owner.onInput);
  pi.on('model_select', owner.onModelSelect);
  pi.on('ui_prompt_start', owner.onUiPromptStart);
  pi.on('ui_prompt_end', owner.onUiPromptEnd);
  pi.on('session_before_compact', owner.onSessionBeforeCompact);
  pi.on('session_compact', owner.onSessionCompact);
  pi.on('session_compact_failed', owner.onSessionCompactFailed);
  pi.on('session_before_switch', owner.onSessionBeforeSwitch);
  pi.on('session_before_fork', owner.onSessionBeforeFork);
  pi.on('session_before_tree', owner.onSessionBeforeTree);
  pi.on('session_tree', owner.onSessionTree);
  pi.on('session_shutdown', owner.onSessionShutdown);
  return { restore: owner.restore, cancel: owner.cancel, refreshScope: owner.refreshScope, snapshot: owner.snapshot, isPrompt: owner.isPrompt, pending: owner.pending };
}
