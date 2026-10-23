import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function goalIO(pi: ExtensionAPI) {
  return {
    appendEntry: pi.appendEntry?.bind(pi), sendMessage: pi.sendMessage?.bind(pi), sendUserMessage: pi.sendUserMessage?.bind(pi),
    getActiveTools: pi.getActiveTools?.bind(pi), setActiveTools: pi.setActiveTools?.bind(pi),
  };
}
