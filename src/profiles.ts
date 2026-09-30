import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const CORE_TOOLS = ["read", "grep", "find", "ls"] as const;
const OPTIONAL_TOOLS = new Set(["bash", "edit", "write", "powershell"]);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface ModelRef { provider: string; id: string }
export interface Profile { name: string; model?: ModelRef; thinking?: ThinkingLevel; tools?: string[] }
export interface ResolvedProfile { name: string; model: ModelRef; thinking: ThinkingLevel; tools: string[] }
export interface ProfileRegistry { find(provider: string, id: string): unknown }
export interface ProfileStoreOptions { path?: string; registry: ProfileRegistry; trustedTools?: readonly string[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`Unknown profile field: ${unknown}`);
}
function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

/** Configuration only. Job/task state belongs to the parent Pi branch. */
export class ProfileStore {
  private profiles = new Map<string, Profile>();
  private readonly options: ProfileStoreOptions;
  constructor(options: ProfileStoreOptions) {
    this.options = options;
    for (const tool of options.trustedTools ?? []) if (!OPTIONAL_TOOLS.has(tool)) throw new Error(`Unsupported trusted child tool: ${tool}`);
  }
  private model(value: unknown): ModelRef {
    const record = object(value);
    exactKeys(record, ["provider", "id"]);
    const model = { provider: nonempty(record.provider, "model provider"), id: nonempty(record.id, "model id") };
    if (!this.options.registry.find(model.provider, model.id)) throw new Error(`Unknown model: ${model.provider}/${model.id} (exact registry name required)`);
    return model;
  }
  validateTools(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 8 || value.some((tool) => typeof tool !== "string")) throw new Error("tools must be a list of supported tool names");
    const allowed = new Set<string>([...CORE_TOOLS, ...(this.options.trustedTools ?? [])]);
    for (const tool of value as string[]) if (!allowed.has(tool)) throw new Error(`Child tool is not trusted or supported: ${tool}`);
    return [...new Set(value as string[])];
  }
  private validate(value: unknown): Profile {
    const record = object(value);
    exactKeys(record, ["name", "model", "thinking", "tools"]);
    const name = nonempty(record.name, "profile name");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name) || name === "inherit") throw new Error("Profile name must be 1–48 letters, digits, '_' or '-' (inherit is reserved)");
    if (record.thinking !== undefined && !THINKING_LEVELS.includes(record.thinking as ThinkingLevel)) throw new Error("Invalid thinking level");
    return {
      name,
      ...(record.model === undefined ? {} : { model: this.model(record.model) }),
      ...(record.thinking === undefined ? {} : { thinking: record.thinking as ThinkingLevel }),
      ...(record.tools === undefined ? {} : { tools: this.validateTools(record.tools) }),
    };
  }
  list(): Profile[] { return structuredClone([...this.profiles.values()]); }
  get(name: string): Profile | undefined { const value = this.profiles.get(name); return value ? structuredClone(value) : undefined; }
  set(profile: Profile): Profile { const value = this.validate(profile); this.profiles.set(value.name, value); return structuredClone(value); }
  delete(name: string): boolean { return this.profiles.delete(name); }
  resolve(name?: string, inheritedModel?: ModelRef, toolsOverride?: string[]): ResolvedProfile {
    const profile = name ? this.get(name) : undefined;
    if (name && !profile) throw new Error(`Unknown profile: ${name}`);
    const selected = profile?.model ?? inheritedModel;
    if (!selected) throw new Error("Select a parent model or configure a named profile model before spawning");
    return { name: profile?.name ?? "inherit", model: this.model(selected), thinking: profile?.thinking ?? "off", tools: this.validateTools(toolsOverride ?? profile?.tools ?? [...CORE_TOOLS]) };
  }
  async load(): Promise<void> {
    if (!this.options.path) return;
    let text: string;
    try { text = await readFile(this.options.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (Buffer.byteLength(text) > 65536) throw new Error("Profile configuration exceeds 64 KiB");
    const config = object(JSON.parse(text));
    exactKeys(config, ["profiles"]);
    if (!Array.isArray(config.profiles) || config.profiles.length > 64) throw new Error("profiles must contain at most 64 profiles");
    const validated = config.profiles.map((item) => this.validate(item));
    if (new Set(validated.map((item) => item.name)).size !== validated.length) throw new Error("Duplicate profile name");
    this.profiles = new Map(validated.map((item) => [item.name, item]));
  }
  async save(): Promise<void> {
    const path = this.options.path;
    if (!path) throw new Error("No profile configuration path configured");
    const profiles = this.list().map((item) => this.validate(item));
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ profiles }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
