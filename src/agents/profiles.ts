import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { readConfigText } from '../shared/config-file.ts';

export const CORE_TOOLS = ["read", "grep", "find", "ls"] as const;
const OPTIONAL_TOOLS = new Set(["bash", "edit", "write", "powershell"]);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface ModelRef { provider: string; id: string }
export interface Profile { name: string; model?: ModelRef; thinking?: ThinkingLevel; tools?: string[]; skills?: string[]; instructions?: string }
export interface ResolvedProfile { name: string; model: ModelRef; thinking: ThinkingLevel; tools: string[]; skills?: string[]; instructions?: string }
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

const MAX_SKILLS = 8;
const MAX_SKILL_PATH = 2048;
/** Any `scheme:` prefix; a single Windows drive letter is filtered out before this is applied. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

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
  /** One explicitly listed local Markdown skill file. Syntax only: paths are not resolved or read here. */
  private skill(value: unknown): string {
    if (typeof value !== "string") throw new Error("Skill paths must be text");
    const path = value.trim();
    if (!path) throw new Error("Skill path must contain text");
    if (path.length > MAX_SKILL_PATH) throw new Error(`Skill path must be at most ${MAX_SKILL_PATH} characters`);
    if (/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(value)) throw new Error("Skill path must not contain control characters");
    if (URL_SCHEME.test(path) && !WINDOWS_DRIVE.test(path)) throw new Error('Skill must be a local Markdown file path, not a URL');
    return path;
  }
  /**
   * Bounded list of local skill files, in the order the user listed them. Absolute, `~/` and
   * working-directory-relative paths are all kept verbatim; existence is deliberately not checked
   * here so a profile written in one working directory still resolves correctly in another.
   */
  validateSkills(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_SKILLS || value.some((skill) => typeof skill !== "string")) throw new Error(`skills must be a list of at most ${MAX_SKILLS} local skill file paths`);
    return [...new Set(value.map((skill) => this.skill(skill)))];
  }
  validateTools(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 8 || value.some((tool) => typeof tool !== "string")) throw new Error("tools must be a list of supported tool names");
    const allowed = new Set<string>([...CORE_TOOLS, ...(this.options.trustedTools ?? [])]);
    const tools = (value as string[]).map((tool) => tool.trim());
    for (const tool of tools) if (!allowed.has(tool)) throw new Error(`Child tool is not trusted or supported: ${tool}`);
    return [...new Set(tools)];
  }
  /**
   * Free-form guidance for the children this profile dispatches. It travels to the child process
   * through the environment and arrives there as one passive custom message (never a system prompt
   * section), so it is bounded and normalized before it ever leaves this store.
   */
  instructions(value: unknown): string {
    if (typeof value !== "string") throw new Error("instructions must be text");
    const text = value.replace(/\r\n?/g, "\n").trim();
    if (!text) throw new Error("instructions must contain text");
    if (text.length > 2000) throw new Error("instructions must be at most 2000 characters");
    return text;
  }
  private validate(value: unknown): Profile {
    const record = object(value);
    exactKeys(record, ["name", "model", "thinking", "tools", "skills", "instructions"]);
    const name = nonempty(record.name, "profile name");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name) || name === "inherit") throw new Error("Profile name must be 1–48 letters, digits, '_' or '-' (inherit is reserved)");
    if (record.thinking !== undefined && !THINKING_LEVELS.includes(record.thinking as ThinkingLevel)) throw new Error("Invalid thinking level");
    const model = record.model === undefined ? undefined : this.model(record.model);
    if (model && record.thinking !== undefined && record.thinking !== 'off' && (this.options.registry.find(model.provider, model.id) as { reasoning?: boolean } | undefined)?.reasoning === false) throw new Error('Selected model does not support thinking; use off');
    return {
      name,
      ...(model === undefined ? {} : { model }),
      ...(record.thinking === undefined ? {} : { thinking: record.thinking as ThinkingLevel }),
      ...(record.tools === undefined ? {} : { tools: this.validateTools(record.tools) }),
      ...(record.skills === undefined ? {} : { skills: this.validateSkills(record.skills) }),
      ...(record.instructions === undefined ? {} : { instructions: this.instructions(record.instructions) }),
    };
  }
  list(): Profile[] { return structuredClone([...this.profiles.values()]); }
  get(name: string): Profile | undefined { const value = this.profiles.get(name); return value ? structuredClone(value) : undefined; }
  set(profile: Profile): Profile {
    const value = this.validate(profile);
    if (!this.profiles.has(value.name) && this.profiles.size >= 64) throw new Error('profiles must contain at most 64 profiles');
    this.profiles.set(value.name, value); return structuredClone(value);
  }
  delete(name: string): boolean { return this.profiles.delete(name); }
  resolve(
    name?: string,
    inheritedModel?: ModelRef,
    toolsOverride?: string[],
    inherited?: { thinking?: ThinkingLevel | undefined; tools?: readonly string[] | undefined },
    overrides?: { model?: ModelRef; thinking?: ThinkingLevel; skills?: string[] },
    previous?: ResolvedProfile,
  ): ResolvedProfile {
    const profile = name && name !== 'inherit' ? this.get(name) : undefined;
    if (name && name !== 'inherit' && !profile) throw new Error(`Unknown profile: ${name}`);
    // An omitted profile resumes the snapshot; only explicit inherit resets it to the parent.
    const base = name === 'inherit' ? undefined : previous;
    const selected = overrides?.model ?? profile?.model ?? base?.model ?? inheritedModel;
    if (!selected) throw new Error("Select a parent model or configure a named profile model before spawning");
    const model = this.model(selected);
    const reasoning = (this.options.registry.find(model.provider, model.id) as { reasoning?: boolean } | undefined)?.reasoning;
    const explicitThinking = overrides?.thinking ?? profile?.thinking;
    let thinking = explicitThinking ?? base?.thinking ?? inherited?.thinking ?? 'off';
    if (!THINKING_LEVELS.includes(thinking)) throw new Error('Invalid thinking level');
    if (thinking !== 'off' && reasoning === false) {
      if (explicitThinking !== undefined) throw new Error('Selected model does not support thinking; use off');
      thinking = 'off';
    }
    const allowed = new Set<string>([...CORE_TOOLS, ...(this.options.trustedTools ?? [])]);
    const inheritedTools = inherited?.tools === undefined ? [...CORE_TOOLS] : inherited.tools.filter((tool) => allowed.has(tool));
    const skills = overrides?.skills ?? profile?.skills ?? base?.skills;
    const instructions = profile?.instructions ?? base?.instructions;
    return {
      name: profile?.name ?? base?.name ?? 'inherit', model, thinking,
      tools: this.validateTools(toolsOverride ?? profile?.tools ?? base?.tools ?? [...new Set(inheritedTools)]),
      ...(skills === undefined ? {} : { skills: this.validateSkills(skills) }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  }
  async load(): Promise<void> {
    if (!this.options.path) return;
    let text: string;
    try { text = await readConfigText(this.options.path, 65536, 'Profile configuration exceeds 64 KiB'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.profiles.clear(); return; } throw error; }
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
    const source = `${JSON.stringify({ profiles }, null, 2)}\n`;
    if (Buffer.byteLength(source) > 65536) throw new Error('Profile configuration exceeds 64 KiB');
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, source, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
