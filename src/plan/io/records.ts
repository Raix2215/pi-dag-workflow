import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function appendPlanRecord(pi: ExtensionAPI, type: string, data: unknown): void { pi.appendEntry(type, data); }
