import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function retryIO(pi: ExtensionAPI, clock: { now?(): number; setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimer?(timer: ReturnType<typeof setTimeout>): void }) {
  return {
    now: clock.now ?? Date.now,
    setTimer: clock.setTimer ?? setTimeout,
    clearTimer: clock.clearTimer ?? clearTimeout,
    append: (...args: Parameters<ExtensionAPI['appendEntry']>) => pi.appendEntry(...args),
    sendUser: (...args: Parameters<ExtensionAPI['sendUserMessage']>) => pi.sendUserMessage(...args),
    send: (...args: Parameters<ExtensionAPI['sendMessage']>) => pi.sendMessage(...args),
    setModel: (...args: Parameters<ExtensionAPI['setModel']>) => pi.setModel(...args),
    setThinking: (...args: Parameters<ExtensionAPI['setThinkingLevel']>) => pi.setThinkingLevel(...args),
    thinking: () => pi.getThinkingLevel?.(),
  };
}
