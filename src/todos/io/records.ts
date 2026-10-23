import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readConfigText } from '../../shared/config-file.ts';

export function sendCheckpoint(pi: ExtensionAPI, message: Parameters<ExtensionAPI['sendMessage']>[0]): void { pi.sendMessage(message, { triggerTurn: false }); }
export function appendTodoRecord(pi: ExtensionAPI, type: string, data: unknown): void { pi.appendEntry(type, data); }
export async function readPresetData(path: string): Promise<unknown> {
  return JSON.parse(await readConfigText(path, 65536, 'Preset configuration exceeds 64 KiB')) as unknown;
}
