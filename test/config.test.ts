import { CORE_TOOLS, ProfileStore, type ResolvedProfile, type ThinkingLevel } from "../src/agents/domain/profiles.ts";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile, rm, readdir, open, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPaths, loadConfig, resolveChildExtensionPaths, writeConfig } from '../src/shared/config.ts';
import { chinese, createTranslator, localizeSavedMessage, resolveLocale } from '../src/shared/i18n.ts';
import { englishMessages } from '../src/shared/messages.en.ts';
import { CHILD_SKILLS_ENV, skillFiles, takeSkillFiles } from '../src/agents/io/skills.ts';
import { takeChildContext, takeProfilePrompt } from '../src/agents/commands/child.ts';
import { loadLocale } from '../src/shared/config.ts';
import { readdir as readDirectory } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { emptyState } from './fixtures/public-records.ts';
import { planViolation } from '../src/plan/domain/policy.ts';
import { readConfigText, readConfigTextSync } from '../src/shared/config-file.ts';

// Pure policy and bounded configuration IO, moved from flow-persistence.test.ts.
for (const language of ['zh-CN', 'en'] as const) test(`ticket01 child-extension diagnostics identify the editable file/key and executable menu (${language})`, async () => {
  await assert.rejects(resolveChildExtensionPaths(['ticket01-nonexistent-extension.ts'], createTranslator(language)), error => {
    const text = String(error);
    assert.match(text, /pi-dag-workflow-profile\.json/); assert.match(text, /childExtensions/); assert.match(text, /\/agents/);
    assert.doesNotMatch(text, /请(?:检查|查看|设置|确认)|check the settings|check childExtensions configuration/i);
    if (language === 'en') assert.doesNotMatch(text, /\p{Script=Han}/u);
    return true;
  });
});

test('Plan distinguishes status filters from mutations and permits fragment editing', () => {
  const state = { ...emptyState(), plan: true };
  for (const status of ['completed', 'in_progress']) {
    assert.equal(planViolation(state, 'todo', { action: 'list', status }), undefined);
    assert.ok(planViolation(state, 'todo', { action: 'update', id: 1, status }));
  }
  for (const action of ['apply', 'reset']) assert.equal(planViolation(state, 'todo', { action, preset: 'flow' }), undefined);
});

test('configuration readers enforce byte boundaries, UTF-8 and native missing-file errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-config-limit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  for (const source of ['x'.repeat(32), '中文'.repeat(5)]) {
    await writeFile(path, source); const size = Buffer.byteLength(source);
    assert.equal(await readConfigText(path, size, 'too large'), source); assert.equal(readConfigTextSync(path, size, 'too large'), source);
    await assert.rejects(readConfigText(path, size - 1, 'too large'), /too large/); assert.throws(() => readConfigTextSync(path, size - 1, 'too large'), /too large/);
  }
  await writeFile(path, Buffer.alloc(32, 255)); await assert.rejects(readConfigText(path, 32, 'too large'), /too large/); assert.throws(() => readConfigTextSync(path, 32, 'too large'), /too large/);
  await assert.rejects(readConfigText(join(root, 'missing'), 32, 'too large'), { code: 'ENOENT' });
});

test('growing configurations stay readable up to the limit but never read or allocate beyond limit + 1', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-config-growth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json'); await writeFile(path, 'small');
  const probe = await open(path, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalStat = prototype.stat, originalRead = prototype.read; const allocations: number[] = []; let growTo = 8192;
  prototype.stat = async function (...args: unknown[]) { const stat = await originalStat.apply(this, args); await writeFile(path, 'x'.repeat(growTo)); return stat; };
  prototype.read = async function (...args: any[]) { allocations.push(args[0].length); return originalRead.apply(this, args); };
  t.after(() => { prototype.stat = originalStat; prototype.read = originalRead; });
  assert.equal((await readConfigText(path, 8192, 'too large')).length, 8192);
  await writeFile(path, 'small'); growTo = 8193;
  await assert.rejects(readConfigText(path, 8192, 'too large'), /too large/);
  assert.ok(allocations.length > 2); assert.ok(Math.max(...allocations) <= 8193);
});

async function writerDirectory(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dag-config-writer-')), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  return configPaths();
}

test('B4: config writer creates minimal JSON and preserves other settings and user keys with mode 0600', async (t) => {
  const paths = await writerDirectory(t);
  await writeConfig({ language: 'en' });
  assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), { language: 'en' });
  assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  const original = { language: 'zh-CN', goalMaxTurns: 7, custom: { keep: [1, 'value'] } };
  await writeFile(paths.config, JSON.stringify(original));
  await chmod(paths.config, 0o644);
  await writeConfig({ planTools: ['read'] });
  assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), { ...original, planTools: ['read'] });
  assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(paths.directory), ['pi-dag-workflow-config.json']);
});

test('B4: config writer refuses malformed or non-object JSON without changing user bytes', async (t) => {
  const paths = await writerDirectory(t); await mkdir(paths.directory, { recursive: true });
  for (const source of ['{ broken', '[]', 'null']) {
    await writeFile(paths.config, source);
    await assert.rejects(writeConfig({ language: 'en' }), error => String(error).includes(paths.config));
    assert.equal(await readFile(paths.config, 'utf8'), source);
  }
  assert.deepEqual(await readdir(paths.directory), ['pi-dag-workflow-config.json']);
});

test('B4: config writer rejects oversized input and serialized output without replacing the file', async (t) => {
  const paths = await writerDirectory(t); await mkdir(paths.directory, { recursive: true });
  const large = JSON.stringify({ custom: 'x'.repeat(16384) });
  await writeFile(paths.config, large);
  await assert.rejects(writeConfig({ language: 'en' }), /16 KiB/);
  assert.equal(await readFile(paths.config, 'utf8'), large);
  const small = JSON.stringify({ custom: 'preserve' }); await writeFile(paths.config, small);
  await assert.rejects(writeConfig({ planTools: ['x'.repeat(6000), 'y'.repeat(6000), 'z'.repeat(6000)] }), /16 KiB/);
  assert.equal(await readFile(paths.config, 'utf8'), small);
  assert.deepEqual(await readdir(paths.directory), ['pi-dag-workflow-config.json']);
});

test('B1.1: machine-level child extensions resolve beside the config, never from a namesake workspace file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-b11-paths-'));
  const previous = process.env.PI_CODING_AGENT_DIR, home = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'workspace'), directory = configPaths().directory;
  await mkdir(workspace, { recursive: true }); await mkdir(directory, { recursive: true });
  await writeFile(join(workspace, 'tools.ts'), 'export default function() {}');
  await assert.rejects(resolveChildExtensionPaths(['tools.ts']), /tools\.ts.*childExtensions/);
  await writeFile(join(directory, 'tools.ts'), 'export default function() {}');
  assert.deepEqual(await resolveChildExtensionPaths(['tools.ts']), [join(directory, 'tools.ts')]);
  assert.deepEqual(await resolveChildExtensionPaths([join(workspace, 'tools.ts')]), [join(workspace, 'tools.ts')]);
  await writeFile(join(root, 'home-tools.ts'), 'export default function() {}');
  assert.deepEqual(await resolveChildExtensionPaths(['~/home-tools.ts']), [join(root, 'home-tools.ts')]);
});

test('B1.1: child extension validation and discovery conflicts have Chinese keys and actionable localized diagnostics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-b11-errors-')), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await mkdir(configPaths().directory, { recursive: true });
  for (const locale of ['zh-CN', 'en'] as const) {
    const msg = createTranslator(locale);
    // The machine-wide key is no longer a config field: the agents domain drops it on read.
    await writeFile(configPaths().config, JSON.stringify({ childExtensions: ['ignored.ts'] }));
    assert.equal(Object.hasOwn(await loadConfig(msg, 'agents'), 'childExtensions'), false, 'the machine-wide key is dropped');
    await assert.rejects(resolveChildExtensionPaths(['missing.ts'], msg), { message: locale === 'en' ? 'Child extension is missing or unreadable: missing.ts; edit that profile’s childExtensions in pi-dag-workflow-profile.json, or expand the Profile in /agents to fix it' : '子扩展文件不存在或不可读：missing.ts；编辑 pi-dag-workflow-profile.json 里对应 Profile 的 childExtensions，或运行 /agents 展开该 Profile 修改' });
    assert.equal(msg('tools:true 仅用于工具目录查询，不能与模型、Job、Profile 或输出参数组合'), locale === 'en' ? 'tools:true is a tool directory query; do not combine it with model, job, profile or output fields' : 'tools:true 仅用于工具目录查询，不能与模型、Job、Profile 或输出参数组合');
  }
});

// config.test.ts
{
test('config and Profile share the requested Pi user directory; missing config has no filesystem side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-config-')); const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const paths = configPaths();
    assert.equal(paths.config, join(dir, 'pi-dag-workflow', 'pi-dag-workflow-config.json'));
    assert.equal(paths.profile, join(dir, 'pi-dag-workflow', 'pi-dag-workflow-profile.json'));
    assert.deepEqual(await loadConfig(), { language: 'auto', goalMaxTurns: 32, goalNoProgressLimit: 8, goalErrorRetries: 5, planTools: [], goalNoPauseTools: ['ask_user_question'], iconStyle: 'nerd-font', modelLabelWidth: 18, desktopTerminal: 'auto', desktopCommand: '' });
    assert.deepEqual(await readdir(dir), []);
    await mkdir(paths.directory);
    await writeFile(paths.config, JSON.stringify({ goalMaxTurns: 2, goalNoProgressLimit: 1, goalErrorRetries: 0, planTools: ['web_search', 'fetch_content'] }));
    assert.deepEqual(await loadConfig(), { language: 'auto', goalMaxTurns: 2, goalNoProgressLimit: 1, goalErrorRetries: 0, planTools: ['web_search', 'fetch_content'], goalNoPauseTools: ['ask_user_question'], iconStyle: 'nerd-font', modelLabelWidth: 18, desktopTerminal: 'auto', desktopCommand: '' });
    await writeFile(paths.config, JSON.stringify({ goalNoProgressLimit: 40, goalNoPauseTools: ['question_tool', 'custom-confirm'] }));
    assert.equal((await loadConfig()).goalNoProgressLimit, 40);
    assert.deepEqual((await loadConfig()).goalNoPauseTools, ['question_tool', 'custom-confirm']);
    for (const value of [{ goalNoProgressLimit: 101 }, { goalNoPauseTools: null }, { goalNoPauseTools: ['ask_user_question', 'ask_user_question'] }, { goalNoPauseTools: ['bad name'] }, { language: 'fr' }, { language: null }, { goalMaxTurns: 0 }, { goalMaxTurns: 201 }, { goalNoProgressLimit: 1.5 }, { goalErrorRetries: -1 }, { goalErrorRetries: 21 }, { goalErrorRetries: 1.5 }, { planTools: 'web_search' }, { planTools: [1] }, { planTools: ['bad name'] }, { planTools: ['a', 'a'] }, { planTools: Array.from({ length: 17 }, (_, index) => `t${index}`) }, { unknown: true }, { modules: ['unknown'] }, { modules: null }, [], null]) {
      await writeFile(paths.config, JSON.stringify(value)); await assert.rejects(loadConfig());
    }
  } finally { previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});
}

// Profile configuration validation/copying and atomic file boundaries stay in this controlled suite.
{
// profiles.test.ts
{
const model = { provider: "local", id: "exact-model" };
const registry = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? { reasoning: true } : undefined };

test("default profile inherits an exact registered model and read-only core tools", () => {
  const store = new ProfileStore({ registry });
  assert.deepEqual(store.resolve(undefined, model), { name: "inherit", model, thinking: "off", tools: [...CORE_TOOLS] });
  assert.throws(() => store.resolve(), /parent model/);
  assert.throws(() => store.resolve(undefined, { provider: "local", id: "model" }), /Unknown model/);
});
test('inherit accepts its explicit name and captures thinking and only active supported built-ins', () => {
  const store = new ProfileStore({ registry, trustedTools: ['bash', 'write', 'powershell'] });
  const parent = { thinking: 'high' as const, tools: ['read', 'bash', 'write', 'powershell', 'custom_search', 'subagent_spawn'] };
  const resolved = store.resolve(undefined, model, undefined, parent);
  assert.deepEqual(resolved, { name: 'inherit', model, thinking: 'high', tools: ['read', 'bash', 'write', 'powershell'], ignoredInheritedTools: ['custom_search', 'subagent_spawn'] });
  assert.deepEqual(store.resolve('inherit', model, undefined, parent), resolved);
  assert.deepEqual(store.resolve('inherit', model, [], parent).tools, []);
  assert.deepEqual(store.resolve(undefined, model, undefined, { tools: [] }).tools, []);
  store.set({ name: 'partial' });
  assert.deepEqual(store.resolve('partial', model, undefined, parent), { ...resolved, name: 'partial' });
  store.set({ name: 'explicit', thinking: 'off', tools: ['read'] });
  assert.equal(store.resolve('explicit', model, undefined, parent).thinking, 'off');
  assert.deepEqual(store.resolve('explicit', model, ['write'], parent).tools, ['write']);
  const nonReasoning = new ProfileStore({ registry: { find: () => ({ reasoning: false }) } });
  assert.equal(nonReasoning.resolve(undefined, model, undefined, parent).thinking, 'off');
});

test("named profiles validate thinking, exact model names and unknown fields", () => {
  const store = new ProfileStore({ registry });
  store.set({ name: "reader", model, thinking: "low" });
  assert.equal(store.resolve("reader").thinking, "low");
  assert.throws(() => store.set({ name: "bad", model: { ...model, id: "exact" } }), /Unknown model/);
  assert.throws(() => store.set({ name: "bad", thinking: "wild" as "low" }), /thinking/);
  assert.throws(() => store.set({ name: "bad", extra: "ignored" } as never), /Unknown profile field/);
  assert.throws(() => store.set({ name: "inherit" }), /reserved/);
  assert.throws(() => store.resolve("missing", model), /Unknown profile/);
});
test("child tools are explicit trusted built-ins; unknown and parent custom tools rejected", () => {
  const untrusted = new ProfileStore({ registry });
  assert.throws(() => untrusted.set({ name: "writer", tools: ["write"] }), /not trusted/);
  const trusted = new ProfileStore({ registry, trustedTools: ["write", "bash"] });
  trusted.set({ name: "writer", tools: ["read", "write", "write"] });
  assert.deepEqual(trusted.resolve("writer", model).tools, ["read", "write"]);
  assert.deepEqual(trusted.resolve("writer", model, []).tools, []);
  assert.throws(() => trusted.resolve("writer", model, ["subagent_spawn"]), /not trusted/);
  assert.throws(() => new ProfileStore({ registry, trustedTools: ["custom_search"] }), /Unsupported/);
});
test("profile getters and resolved objects cannot mutate stored configuration", () => {
  const store = new ProfileStore({ registry });
  const profile = { name: "reader", model, tools: ["read"] };
  store.set(profile);
  profile.tools.push("write");
  store.get("reader")!.tools!.push("write");
  store.list()[0]!.model!.id = "invalid";
  assert.deepEqual(store.resolve("reader").tools, ["read"]);
  assert.equal(store.resolve("reader").model.id, model.id);
  assert.equal(store.delete("reader"), true);
  assert.equal(store.get("reader"), undefined);
});
const alternateModel = { provider: "local", id: "alternate-model" };
const plainModel = { provider: "local", id: "plain-model" };
const dispatchRegistry = {
  find: (provider: string, id: string) => provider === "local" && [model.id, alternateModel.id, plainModel.id].includes(id)
    ? { reasoning: id !== plainModel.id } : undefined,
};
const snapshot = (): ResolvedProfile => ({
  name: "old", model: { ...model }, thinking: "high", tools: ["read"],
  skills: ["old.md"], instructions: "Preserve this guidance.",
});

test("dispatch overrides win over named profile and parent, including empty replacement lists", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  store.set({ name: "writer", model: alternateModel, thinking: "low", tools: ["write"], skills: ["profile.md"], instructions: "Profile guidance." });
  const parent = { thinking: "medium" as const, tools: ["read", "custom_search"] };
  assert.deepEqual(store.resolve("writer", model, undefined, parent), {
    name: "writer", model: alternateModel, thinking: "low", tools: ["write"], skills: ["profile.md"], instructions: "Profile guidance.",
  });
  assert.deepEqual(store.resolve("writer", model, [" read ", "read"], parent, {
    model, thinking: "high", skills: [" override.md ", "override.md"],
  }), { name: "writer", model, thinking: "high", tools: ["read"], skills: ["override.md"], instructions: "Profile guidance." });
  assert.deepEqual(store.resolve("writer", model, [], parent, { thinking: "off", skills: [] }), {
    name: "writer", model: alternateModel, thinking: "off", tools: [], skills: [], instructions: "Profile guidance.",
  });
});

test("dispatch model override starts without a parent model and rejects misspellings", () => {
  const store = new ProfileStore({ registry: dispatchRegistry });
  assert.deepEqual(store.resolve(undefined, undefined, undefined, { thinking: "medium", tools: [] }, { model }), {
    name: "inherit", model, thinking: "medium", tools: [],
  });
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, { model: { ...model, id: "exact-modle" } }), /Unknown model/);
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, { model: { ...model, provider: "locla" } }), /Unknown model/);
});

test("resume uses the full snapshot without looking up modified or deleted old profiles", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  store.set({ name: "old", model: alternateModel, thinking: "off", tools: ["write"], skills: ["changed.md"], instructions: "Changed." });
  const parent = { thinking: "low" as const, tools: ["write"] };
  assert.deepEqual(store.resolve(undefined, alternateModel, undefined, parent, undefined, previous), previous);
  store.delete("old");
  assert.deepEqual(store.resolve(undefined, undefined, undefined, undefined, undefined, previous), previous);
  assert.throws(() => store.resolve("old", alternateModel, undefined, parent, undefined, previous), /Unknown profile/);
  const resolved = store.resolve(undefined, alternateModel, undefined, parent, undefined, previous);
  resolved.model.id = "mutated";
  resolved.tools.push("write");
  resolved.skills!.push("mutated.md");
  assert.deepEqual(previous, snapshot());
});

test("resume applies only explicit fields of a named profile even when its name is unchanged", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  store.set({ name: "old", thinking: "low" });
  assert.deepEqual(store.resolve("old", alternateModel, undefined, { tools: ["write"] }, undefined, previous), { ...previous, thinking: "low" });
  store.set({ name: "partial", tools: [], skills: [] });
  assert.deepEqual(store.resolve("partial", alternateModel, undefined, undefined, undefined, previous), { ...previous, name: "partial", tools: [], skills: [] });
  store.set({ name: "full", model: alternateModel, thinking: "low", tools: ["write"], skills: ["new.md"], instructions: "New guidance." });
  assert.deepEqual(store.resolve("full", undefined, undefined, undefined, undefined, previous), {
    name: "full", model: alternateModel, thinking: "low", tools: ["write"], skills: ["new.md"], instructions: "New guidance.",
  });
  assert.deepEqual(store.resolve("full", undefined, [], undefined, { model, thinking: "off", skills: [] }, previous), {
    name: "full", model, thinking: "off", tools: [], skills: [], instructions: "New guidance.",
  });
});

test("resume overrides replace snapshot fields while retaining its name and instructions", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  assert.deepEqual(store.resolve(undefined, model, ["write"], undefined, {
    model: alternateModel, thinking: "minimal", skills: ["new.md"],
  }, previous), { ...previous, model: alternateModel, thinking: "minimal", tools: ["write"], skills: ["new.md"] });
  assert.deepEqual(store.resolve(undefined, model, [], undefined, { skills: [] }, previous), { ...previous, tools: [], skills: [] });
});

test("explicit inherit discards the entire snapshot and resets to the current parent", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  const parent = { thinking: "low" as const, tools: ["write", "custom_search"] };
  assert.deepEqual(store.resolve("inherit", alternateModel, undefined, parent, undefined, previous), {
    name: "inherit", model: alternateModel, thinking: "low", tools: ["write"], ignoredInheritedTools: ["custom_search"],
  });
  assert.deepEqual(store.resolve("inherit", alternateModel, [], parent, { model, thinking: "off", skills: [] }, previous), {
    name: "inherit", model, thinking: "off", tools: [], skills: [],
  });
  assert.throws(() => store.resolve("inherit", undefined, undefined, parent, undefined, previous), /parent model/);
  assert.equal(store.resolve("inherit", undefined, undefined, parent, { model }, previous).model.id, model.id);
});

test("only inherited thinking falls back to off on a non-reasoning dispatch model", () => {
  const store = new ProfileStore({ registry: dispatchRegistry });
  store.set({ name: "model-only", model: plainModel });
  store.set({ name: "explicit", thinking: "high" });
  const parent = { thinking: "high" as const };
  assert.equal(store.resolve("model-only", model, undefined, parent).thinking, "off");
  assert.equal(store.resolve(undefined, model, undefined, parent, { model: plainModel }).thinking, "off");
  assert.equal(store.resolve(undefined, undefined, undefined, undefined, { model: plainModel }, snapshot()).thinking, "off");
  assert.equal(store.resolve("model-only", undefined, undefined, undefined, undefined, snapshot()).thinking, "off");
  assert.throws(() => store.resolve(undefined, plainModel, undefined, parent, { thinking: "high" }), /does not support thinking/);
  assert.throws(() => store.resolve(undefined, model, undefined, parent, { model: plainModel, thinking: "low" }, snapshot()), /does not support thinking/);
  assert.throws(() => store.resolve("explicit", plainModel), /does not support thinking/);
  assert.throws(() => store.resolve("explicit", model, undefined, undefined, { model: plainModel }, snapshot()), /does not support thinking/);
  assert.equal(store.resolve("explicit", plainModel, undefined, undefined, { thinking: "off" }).thinking, "off");
  assert.throws(() => store.set({ name: "invalid", model: plainModel, thinking: "high" }), /does not support thinking/);
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, { thinking: "typo" as ThinkingLevel }), /thinking/);
});

test("tool lists trim and deduplicate without granting unsupported or untrusted tools", () => {
  const store = new ProfileStore({ registry, trustedTools: ["write"] });
  store.set({ name: "trimmed", tools: [" read ", "read", " write "] });
  assert.deepEqual(store.resolve("trimmed", model).tools, ["read", "write"]);
  assert.deepEqual(store.resolve(undefined, model, [" read ", "read"]).tools, ["read"]);
  assert.deepEqual(store.resolve(undefined, model, undefined, { tools: ["custom_search"] }).tools, []);
  for (const tool of ["bash", "custom_search", "subagent_spawn", "", "   "]) {
    assert.throws(() => store.resolve(undefined, model, [tool]), /not trusted or supported/);
  }
  assert.throws(() => store.resolve(undefined, model, [1] as unknown as string[]), /supported tool names/);
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, undefined, { ...snapshot(), tools: ["bash"] }), /not trusted or supported/);
});

test("dispatch skill overrides use the same bounded local-path validation as profiles", () => {
  const store = new ProfileStore({ registry });
  assert.deepEqual(store.resolve(undefined, model, undefined, undefined, { skills: [" a.md ", "a.md", "~/b.md"] }).skills, ["a.md", "~/b.md"]);
  assert.equal("skills" in store.resolve(undefined, model), false);
  for (const skills of [["https://example.com/a.md"], ["bad\n.md"], ["   "], Array(9).fill("a.md"), ["x".repeat(2049)]]) {
    assert.throws(() => store.resolve(undefined, model, undefined, undefined, { skills }), /[Ss]kill/);
  }
});

test("profile file contains only configuration, load/save validate and load is atomic", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-m2-profile-"));
  try {
    const path = join(root, "profiles.json");
    const store = new ProfileStore({ registry, path });
    await store.load();
    store.set({ name: "reader", model });
    await store.save();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { profiles: [{ name: "reader", model }] });
    const restored = new ProfileStore({ registry, path });
    await restored.load();
    assert.deepEqual(restored.list(), store.list());
    await writeFile(path, JSON.stringify({ profiles: [{ name: "unknown", model: { ...model, id: "missing" } }] }));
    await assert.rejects(restored.load(), /Unknown model/);
    assert.deepEqual(restored.list(), store.list());
    await writeFile(path, JSON.stringify({ profiles: [{ name: "one" }, { name: "one" }] }));
    await assert.rejects(restored.load(), /Duplicate/);
    await writeFile(path, JSON.stringify({ profiles: [], jobs: [] }));
    await assert.rejects(restored.load(), /Unknown profile field/);
    await assert.rejects(new ProfileStore({ registry }).save(), /No profile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profile instructions are normalized, bounded and carried into the resolved profile", () => {
  const store = new ProfileStore({ registry });
  store.set({ name: "browser", model, thinking: "high", instructions: "First line.\r\nSecond line.  " });
  assert.equal(store.get("browser")!.instructions, "First line.\nSecond line.");
  assert.equal(store.resolve("browser").instructions, "First line.\nSecond line.");
  // Profiles without instructions stay exactly as before.
  store.set({ name: "plain", model });
  assert.equal("instructions" in store.resolve("plain"), false);
  assert.throws(() => store.set({ name: "bad", instructions: "" }), /contain text/);
  assert.throws(() => store.set({ name: "bad", instructions: "   " }), /contain text/);
  assert.throws(() => store.set({ name: "bad", instructions: 42 as unknown as string }), /must be text/);
  assert.throws(() => store.set({ name: "bad", instructions: "x".repeat(2001) }), /at most 2000/);
  assert.equal(store.resolve("browser").thinking, "high");
});

test("instructions survive a save/load round trip and never leak into other profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-profiles-"));
  try {
    const path = join(root, "profile.json");
    const first = new ProfileStore({ path, registry });
    first.set({ name: "browser", model, instructions: "Stay read-only unless asked otherwise." });
    first.set({ name: "other", model });
    await first.save();
    const reloaded = new ProfileStore({ path, registry });
    await reloaded.load();
    assert.equal(reloaded.get("browser")!.instructions, "Stay read-only unless asked otherwise.");
    assert.equal("instructions" in reloaded.get("other")!, false);
    // A profile re-saved through the command path keeps the text that was already stored.
    const existing = reloaded.get("browser")!.instructions;
    reloaded.set({ name: "browser", model, thinking: "xhigh", ...(existing ? { instructions: existing } : {}) });
    await reloaded.save();
    const again = new ProfileStore({ path, registry });
    await again.load();
    assert.equal(again.get("browser")!.instructions, "Stay read-only unless asked otherwise.");
    assert.equal(again.get("browser")!.thinking, "xhigh");
  } finally { await rm(root, { recursive: true, force: true }); }
});
}

// profile-cache.test.ts
{
test('removed user Profile file invalidates cached named profiles instead of retaining ghosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-profile-'));
  const path = join(dir, 'pi-dag-workflow-profile.json');
  const model = { provider: 'offline', id: 'model' };
  const profiles = new ProfileStore({ path, registry: { find: () => model } });
  try {
    profiles.set({ name: 'test', model }); await profiles.save(); await profiles.load();
    assert.equal(profiles.list().length, 1);
    await rm(path); await profiles.load();
    assert.deepEqual(profiles.list(), []);
    assert.throws(() => profiles.resolve('test', model), /Unknown profile/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
}

// profile-skills.test.ts
{
const model = { provider: "local", id: "exact-model" };
/** Offline, deterministic registry: no provider, network or credentials are involved. */
const registry = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? { reasoning: true } : undefined };

test("skills keep local absolute, ~/ and working-directory-relative paths verbatim", () => {
  const store = new ProfileStore({ registry });
  store.set({ name: "reader", model, skills: ["  /opt/skills/read.md  ", "~/skills/review.md", "skills/local.md", "C:\\skills\\win.md", "C:/skills/slash.md"] });
  assert.deepEqual(store.get("reader")!.skills, ["/opt/skills/read.md", "~/skills/review.md", "skills/local.md", "C:\\skills\\win.md", "C:/skills/slash.md"]);
  // Duplicates collapse but the user's order is preserved.
  store.set({ name: "reader", model, skills: ["b.md", "a.md", "b.md"] });
  assert.deepEqual(store.get("reader")!.skills, ["b.md", "a.md"]);
});

test("skills reject non-local sources, bad types, over-long paths and oversized lists", () => {
  const store = new ProfileStore({ registry });
  for (const url of ["https://example.com/a.md", "http://example.com/a.md", "npm:some-skill", "git:github.com/x/y.md", "file:///tmp/a.md", "file:/tmp/a.md", "C:drive-relative.md"]) {
    assert.throws(() => store.set({ name: "bad", skills: [url] } as never), /not a URL/, url);
  }
  assert.throws(() => store.set({ name: "bad", skills: "a.md" } as never), /skills must be a list/);
  assert.throws(() => store.set({ name: "bad", skills: [1] } as never), /skills must be a list/);
  assert.throws(() => store.set({ name: "bad", skills: [null] } as never), /skills must be a list/);
  assert.throws(() => store.set({ name: "bad", skills: ["   "] }), /contain text/);
  assert.throws(() => store.set({ name: "bad", skills: ["ok.md\nrm -rf"] }), /control characters/);
  assert.throws(() => store.set({ name: "bad", skills: ["ok\0.md"] }), /control characters/);
  assert.throws(() => store.set({ name: 'bad', skills: ['\u202ehidden.md'] }), /control characters/);
  assert.throws(() => store.set({ name: 'bad', skills: ['leading.md\n'] }), /control characters/);
  assert.throws(() => store.set({ name: "bad", skills: [`${"x".repeat(2049)}.md`] }), /at most 2048/);
  assert.throws(() => store.set({ name: "bad", skills: Array.from({ length: 9 }, (_, index) => `s${index}.md`) }), /at most 8/);
});

test("an empty skills list is valid and an absent field is not invented", () => {
  const store = new ProfileStore({ registry });
  store.set({ name: "empty", model, skills: [] });
  assert.deepEqual(store.get("empty")!.skills, []);
  assert.deepEqual(store.resolve("empty").skills, []);
  store.set({ name: "plain", model });
  assert.equal("skills" in store.get("plain")!, false);
  assert.equal("skills" in store.resolve("plain"), false);
});

test("skills never leak into other profiles and never widen tools, thinking or model", () => {
  const store = new ProfileStore({ registry, trustedTools: ["write"] });
  store.set({ name: "reader", model, thinking: "low", tools: ["read"], skills: ["/skills/read.md"] });
  store.set({ name: "plain", model, thinking: "high", tools: ["write"] });
  // Named profiles carry only their own skills.
  assert.deepEqual(store.resolve("reader").skills, ["/skills/read.md"]);
  assert.equal("skills" in store.resolve("plain"), false);
  // inherit starts from the parent model/thinking/tools and gains no skills.
  const inherited = store.resolve(undefined, model, undefined, { thinking: "medium", tools: ["read", "write"] });
  assert.equal("skills" in inherited, false);
  assert.deepEqual(store.resolve("inherit", model, undefined, { thinking: "medium", tools: ["read"] }).tools, ["read"]);
  // Adding skills changes nothing else in the resolved profile.
  const withSkills = store.resolve("reader");
  const withoutSkills = new ProfileStore({ registry, trustedTools: ["write"] });
  withoutSkills.set({ name: "reader", model, thinking: "low", tools: ["read"] });
  assert.deepEqual({ ...withSkills, skills: undefined }, { ...withoutSkills.resolve("reader"), skills: undefined });
  assert.deepEqual(withSkills.tools, ["read"]);
  assert.equal(withSkills.thinking, "low");
  assert.deepEqual(withSkills.model, model);
});

test("get/list/resolve hand out independent copies of skills", () => {
  const store = new ProfileStore({ registry });
  const profile = { name: "reader", model, skills: ["a.md"] };
  store.set(profile);
  profile.skills.push("b.md");
  store.get("reader")!.skills!.push("c.md");
  store.list()[0]!.skills!.push("d.md");
  store.resolve("reader").skills!.push("e.md");
  assert.deepEqual(store.get("reader")!.skills, ["a.md"]);
  assert.deepEqual(store.list()[0]!.skills, ["a.md"]);
  assert.deepEqual(store.resolve("reader").skills, ["a.md"]);
});

test("skills survive a save/load round trip with old configs and stay atomic on bad loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-skills-"));
  try {
    const path = join(root, "profiles.json");
    const store = new ProfileStore({ registry, path });
    // An existing configuration without skills still loads unchanged.
    await writeFile(path, JSON.stringify({ profiles: [{ name: "legacy", model }] }));
    await store.load();
    assert.equal("skills" in store.get("legacy")!, false);
    store.set({ name: "reader", model, thinking: "low", tools: ["read"], skills: ["/skills/a.md", "~/skills/b.md"], instructions: "Stay read-only." });
    store.set({ name: "empty", model, skills: [] });
    await store.save();
    if (process.platform !== 'win32') assert.equal(((await stat(path)).mode & 0o777), 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      profiles: [
        { name: "legacy", model },
        { name: "reader", model, thinking: "low", tools: ["read"], skills: ["/skills/a.md", "~/skills/b.md"], instructions: "Stay read-only." },
        { name: "empty", model, skills: [] },
      ],
    });
    const reloaded = new ProfileStore({ registry, path });
    await reloaded.load();
    assert.deepEqual(reloaded.list(), store.list());
    assert.deepEqual(reloaded.get("reader")!.skills, ["/skills/a.md", "~/skills/b.md"]);
    assert.deepEqual(reloaded.resolve("reader").skills, ["/skills/a.md", "~/skills/b.md"]);
    assert.equal(reloaded.get("reader")!.instructions, "Stay read-only.");
    assert.deepEqual(reloaded.get("empty")!.skills, []);
    // A rejected load leaves the already-stored profiles intact.
    const before = reloaded.list();
    await writeFile(path, JSON.stringify({ profiles: [{ name: "reader", model, skills: ["https://example.com/x.md"] }] }));
    await assert.rejects(reloaded.load(), /not a URL/);
    assert.deepEqual(reloaded.list(), before);
    await writeFile(path, JSON.stringify({ profiles: [{ name: "reader", model, skills: ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md"] }] }));
    await assert.rejects(reloaded.load(), /at most 8/);
    assert.deepEqual(reloaded.list(), before);
    await writeFile(path, JSON.stringify({ profiles: [{ name: "reader", model, skills: [], other: true }] }));
    await assert.rejects(reloaded.load(), /Unknown profile field/);
    assert.deepEqual(reloaded.list(), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
}
}

// i18n dictionary and locale contracts (formerly i18n.test.ts)
{
const en = createTranslator("en");
const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]!).sort();
// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

test("resolveLocale honours an explicit language and otherwise follows terminal preferences", () => {
  assert.equal(resolveLocale("en", {}), "en");
  assert.equal(resolveLocale("zh-CN", { LANG: "en_US.UTF-8" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANG: "zh_CN.UTF-8" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANG: "zh-TW" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANG: "en_US.UTF-8" }), "en");
  assert.equal(resolveLocale("auto", { LANG: "fr_FR.UTF-8" }), "en");
  assert.equal(resolveLocale("auto", {}), "en");
});

test("resolveLocale precedence is LC_ALL > LC_MESSAGES > LANGUAGE > LANG, first LANGUAGE entry wins", () => {
  assert.equal(resolveLocale("auto", { LC_ALL: "zh_CN", LANG: "en_US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LC_MESSAGES: "zh_CN", LANG: "en_US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LC_ALL: "en_US", LC_MESSAGES: "zh_CN", LANG: "zh_CN" }), "en");
  assert.equal(resolveLocale("auto", { LANGUAGE: "zh_CN:en", LANG: "en_US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANGUAGE: "fr_FR:zh_CN", LANG: "zh_CN" }), "en");
  assert.equal(resolveLocale("auto", { LANGUAGE: "", LANG: "zh_CN" }), "zh-CN");
});

// ---------------------------------------------------------------------------
// Translator semantics
// ---------------------------------------------------------------------------

test("createTranslator translates static templates before interpolation and copies values verbatim", () => {
  assert.equal(en("待执行"), "Pending");
  assert.equal(createTranslator("zh-CN")("待执行"), "待执行");
  assert.equal(en`已清空 ${2} 项，编号不复用`, "Cleared 2 item(s); ids are not reused");
  // Unknown keys fall through untouched in both locales.
  assert.equal(en("不存在的模板"), "不存在的模板");
  assert.equal(chinese("不存在的模板"), "不存在的模板");
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(en(key), key);
  // A user value that itself looks like a placeholder is not re-substituted.
  const subject = "含 {0} 与 {1} 的用户标题";
  assert.equal(en`已创建 #${1}：${subject} [${en("已完成")}]`, "Created #1: 含 {0} 与 {1} 的用户标题 [Completed]");
  // User text with terminal escapes reaches the translator untouched; UI clean() removes it.
  const dirty = "标题\x1b[31m红\x1b[0m\n下一行";
  const rendered = en`已更新 #${1}：${dirty} [${en("进行中")}]`;
  assert.ok(rendered.includes("\x1b[31m"));
  assert.ok(rendered.includes("\n"));
});

test("interleaved translators keep their own locale without leaking global state", () => {
  const zh = createTranslator("zh-CN");
  const messages: string[] = [];
  for (let index = 0; index < 3; index++) {
    messages.push(en("已完成"), zh("已完成"), en("待执行"), zh("待执行"));
    messages.push(en`已更新 #${index + 1}：${index} [${en("已完成")}]`, zh`已更新 #${index + 1}：${index} [${zh("已完成")}]`);
  }
  assert.deepEqual(messages.slice(0, 4), ["Completed", "已完成", "Pending", "待执行"]);
  assert.equal(messages[4], "Updated #1: 0 [Completed]");
  assert.equal(messages[5], "已更新 #1：0 [已完成]");
  // Repeated calls remain stable and the exported default still speaks Chinese.
  assert.equal(en("已完成"), "Completed");
  assert.equal(chinese("已完成"), "已完成");
});

test('saved plugin reasons follow the new locale without changing unknown text', () => {
  assert.equal(localizeSavedMessage('目标已完成', en), 'Goal completed');
  assert.equal(localizeSavedMessage('Goal completed', chinese), '目标已完成');
  assert.equal(localizeSavedMessage('Goal completed', en), 'Goal completed');
  assert.equal(localizeSavedMessage('Unknown historical reason {0}', en), 'Unknown historical reason {0}');
});

test("English catalog values never contain Han characters and mirror key placeholders", () => {
  const entries = Object.entries(englishMessages);
  assert.ok(entries.length > 200);
  for (const [key, value] of entries) {
    assert.ok(key.length > 0 && value.length > 0, key);
    assert.ok(!hasHan(value), `English value still contains Han: ${key} -> ${value}`);
    assert.deepEqual(placeholders(value), placeholders(key), `placeholder mismatch: ${key} -> ${value}`);
  }
});

test("loadConfig defaults to language auto and loadLocale follows config before terminal preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dag-i18n-"));
  const previous = {
    agent: process.env.PI_CODING_AGENT_DIR,
    LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES,
    LANGUAGE: process.env.LANGUAGE, LANG: process.env.LANG,
  };
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.LC_ALL; delete process.env.LC_MESSAGES; delete process.env.LANGUAGE; delete process.env.LANG;
  try {
    assert.deepEqual(await loadConfig(), { language: "auto", goalMaxTurns: 32, goalNoProgressLimit: 8, goalErrorRetries: 5, planTools: [], goalNoPauseTools: ['ask_user_question'], iconStyle: 'nerd-font', modelLabelWidth: 18, desktopTerminal: 'auto', desktopCommand: '' });
    process.env.LANG = "zh_CN.UTF-8";
    assert.equal(loadLocale(), "zh-CN");
    process.env.LC_ALL = "en_US.UTF-8";
    assert.equal(loadLocale(), "en");

    await mkdir(configPaths().directory, { recursive: true });
    const config = configPaths().config;
    const write = (value: unknown) => writeFile(config, JSON.stringify(value));
    await write({ language: "en" });
    assert.equal(loadLocale(), "en");
    assert.deepEqual(await loadConfig(), { language: "en", goalMaxTurns: 32, goalNoProgressLimit: 8, goalErrorRetries: 5, planTools: [], goalNoPauseTools: ['ask_user_question'], iconStyle: 'nerd-font', modelLabelWidth: 18, desktopTerminal: 'auto', desktopCommand: '' });
    await write({ language: "zh-CN" });
    assert.equal(loadLocale(), "zh-CN");
    await write({ language: "auto" });
    assert.equal(loadLocale(), "en");
    await write({ language: "fr" });
    assert.equal(loadLocale(), "en");
    await write("not json");
    assert.equal(loadLocale(), "en");
  } finally {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    const restore = (key: "LC_ALL" | "LC_MESSAGES" | "LANGUAGE" | "LANG", value: string | undefined) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    };
    restore("LC_ALL", previous.LC_ALL); restore("LC_MESSAGES", previous.LC_MESSAGES);
    restore("LANGUAGE", previous.LANGUAGE); restore("LANG", previous.LANG);
    await rm(directory, { recursive: true, force: true });
  }
});

}
// i18n-coverage.test.ts
{
async function sources(root: string): Promise<string[]> {
  const entries = await readDirectory(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? sources(join(root, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(root, entry.name)] : [])));
  return nested.flat();
}

test('every static Chinese msg() call and tagged template has an English catalog key', async () => {
  const missing: string[] = [];
  const referenced = new Set<string>();
  const unresolved: string[] = [];
  // These existing color probes have no English translation; keep their identity fallback.
  const untranslated = new Set(['状态损坏', '已验证', '核验通过']);
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const texts: string[] = [];
  for (const path of [...await sources(sourceRoot), ...await sources(fileURLToPath(new URL('.', import.meta.url)))]) {
    if (path.endsWith('/messages.en.ts')) continue;
    const text = await readFile(path, 'utf8');
    texts.push(text);
    const production = path.startsWith(sourceRoot);
    const source = parse(text, { sourceType: 'module', plugins: ['typescript'] });
    const check = (node: any) => {
      if (!node || typeof node !== 'object') return;
      let template: any;
      let key: string | undefined;
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && ['msg', 'en', 'zh', 'chinese'].includes(node.callee.name)) {
        const arg = node.arguments[0];
        if (arg?.type === 'StringLiteral') key = arg.value;
        else if (arg?.type === 'TemplateLiteral' && !arg.expressions.length) template = arg;
        else if (production && node.callee.name === 'msg' && !(path.endsWith('/shared/i18n.ts') && arg?.type === 'LogicalExpression' && arg.left?.callee?.object?.name === 'savedMessageKeys')) unresolved.push(`${path.split('/src/')[1]}:${node.loc.start.line}`);
      } else if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && ['msg', 'en', 'zh', 'chinese'].includes(node.tag.name)) template = node.quasi;
      if (template) key = template.quasis.map((quasi: any, index: number) => `${index ? `{${index - 1}}` : ''}${quasi.value.cooked}`).join('');
      if (key) referenced.add(key);
      if (production && key && /\p{Script=Han}/u.test(key) && !Object.hasOwn(englishMessages, key)) missing.push(`${path.split('/src/')[1]}: ${key}`);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(check);
        else if (value && typeof value === 'object' && 'type' in value) check(value);
      }
    };
    check(source);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(unresolved, [], 'nonliteral production msg key outside saved-message recovery');
  for (const key of untranslated) assert.equal(createTranslator('en')(key), key, `identity color probe changed: ${key}`);
  for (const [key, value] of Object.entries(englishMessages)) {
    // Saved English reasons and existing assertions are static indirect references too.
    const indirect = texts.some(text => text.includes(value) || text.includes(value.replaceAll("'", "\\'")) || text.includes(value.replaceAll('"', '\\"')));
    assert.ok(referenced.has(key) || indirect, `unreferenced catalog key: ${key}`);
  }
});
}


// Agent file/path and Profile configuration contracts (formerly agents.test.ts).
{
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'dag-skill-files-'));
  await mkdir(join(root, 'selected'));
  await writeFile(join(root, 'selected', 'SKILL.md'), '# Local skill\nRead only the assigned inputs.\n');
  await writeFile(join(root, 'empty.md'), '');
  await writeFile(join(root, 'large.md'), 'x'.repeat(65537));
  await writeFile(join(root, 'not-markdown.txt'), 'not a skill');
  return root;
}
test('B1: extension paths are canonical, relative to the config directory, and checked before use', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-b1-paths-')); t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await mkdir(configPaths().directory, { recursive: true });
  const extension = join(configPaths().directory, 'tools.ts'); await writeFile(extension, 'export default function() {}');
  assert.deepEqual(await resolveChildExtensionPaths([extension, './tools.ts']), [extension]);
  assert.deepEqual(await resolveChildExtensionPaths(undefined), []);
  await assert.rejects(resolveChildExtensionPaths(['missing.ts']), /missing\.ts.*childExtensions/);
  await assert.rejects(resolveChildExtensionPaths([root], createTranslator('en')), /unreadable.*childExtensions/);
});
test('explicit local files resolve from cwd; duplicate symlinks do not duplicate entries', async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, 'selected', 'SKILL.md');
  assert.deepEqual(await skillFiles(['selected/SKILL.md', expected], root, ['read']), [expected]);
  if (process.platform !== 'win32') {
    await symlink(expected, join(root, 'alias.md'));
    assert.deepEqual(await skillFiles(['alias.md', expected], root, ['read']), [expected]);
  }
  if (process.platform !== 'win32') {
    await symlink(join(root, 'not-markdown.txt'), join(root, 'fake.md'));
    await assert.rejects(skillFiles(['fake.md'], root, ['read']));
  }
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previousHome = process.env[homeKey];
  try { process.env[homeKey] = root; assert.deepEqual(await skillFiles(['~/selected/SKILL.md'], root, ['read']), [expected]); }
  finally { if (previousHome === undefined) delete process.env[homeKey]; else process.env[homeKey] = previousHome; }
  assert.deepEqual(await skillFiles([], root, []), []);
  assert.deepEqual(await skillFiles(undefined, root, []), []);
});
test('bad file entries and missing read permission fail without reading bodies or scanning folders', async (t) => {
  const root = await files(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['missing.md', 'selected', 'empty.md', 'large.md', 'not-markdown.txt', 'https://example.org/SKILL.md']) await assert.rejects(skillFiles([path], root, ['read']));
  await assert.rejects(skillFiles(['selected/SKILL.md'], root, ['bash']), /read tool/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(skillFiles(['selected/SKILL.md'], root, ['read'], cancelled.signal), /aborted/);
  const hidden = join(root, 'missing.md');
  try { await skillFiles([hidden], root, ['read']); assert.fail(); } catch (error) { assert.doesNotMatch(String(error), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); }
});
test('the child consumes only the selected JSON paths and removes them from its environment', () => {
  const env = { [CHILD_SKILLS_ENV]: JSON.stringify(['one.md', 'two.md']) };
  assert.deepEqual(takeSkillFiles(env), ['one.md', 'two.md']); assert.equal(CHILD_SKILLS_ENV in env, false);
  assert.deepEqual(takeSkillFiles({}), []);
  for (const value of ['not-json', '{}', 'null', '[1]', '["bad\\npath"]', 'x'.repeat(20001)]) assert.throws(() => takeSkillFiles({ [CHILD_SKILLS_ENV]: value }));
});
test('known non-reasoning Profile is rejected before spawning, but off is accepted', () => {
  const model = { provider: 'plain', id: 'model' };
  const profiles = new ProfileStore({ registry: { find: () => ({ ...model, reasoning: false }) } });
  assert.throws(() => profiles.set({ name: 'invalid', model, thinking: 'high' }), /does not support thinking/);
  profiles.set({ name: 'valid', model, thinking: 'off' });
  assert.equal(profiles.resolve('valid').thinking, 'off');
  assert.equal(profiles.list().length, 1);
});
}

// Child bootstrap environment is one-shot configuration.
test("the child reads the brief once and removes it from its environment", () => {
  const env: NodeJS.ProcessEnv = { PI_DAG_AGENT_CONTEXT: "Fragment brief" };
  assert.equal(takeChildContext(env), "Fragment brief");
  assert.equal("PI_DAG_AGENT_CONTEXT" in env, false);
  assert.equal(takeChildContext({}), undefined);
  assert.equal(takeChildContext({ PI_DAG_AGENT_CONTEXT: "  " }), undefined);
});

// Pure journal codec/diff tests from agents-protocol.test.ts; no processes or runtime owner.
import * as protocolPersistence from '../src/agents/io/persistence.ts';
import { retainedJobs as decodePublicAgentRecords } from './fixtures/public-records.ts';
{
const {AgentJournal,foldAgentData,foldAgentEntries}=protocolPersistence;
type JobResult=import('../src/agents/domain/runtime.ts').JobResult;
const AGENTS_ENTRY_TYPE='pi-dag-workflow.agents';
const model = { provider: 'dag-test', id: 'scripted' };
const record = (id: string, output: string, extra: Partial<JobResult> = {}): JobResult => ({
  id, profile: 'inherit', model, thinking: 'off', tools: ['read'], status: 'completed',
  startedAt: 1, endedAt: 2, pendingRequests: 0, output, requests: [],
  usage: { requests: 1, input: 0, output: output.length, estimatedCost: 0 }, reportVersion: 1, ...extra,
});
/** Metadata without the output field, as a version-2 delta carries it. */
const meta = (job: JobResult): Omit<JobResult, 'output'> => { const { output: _output, ...rest } = job; return rest; };

test('folding applies version-1 snapshots and version-2 deltas in order', () => {
  const a1 = record('a1', 'alpha');
  const a2 = record('a2', 'beta');
  const snapshot = { version: 1, jobs: [a1, a2], nextId: 5 };
  const append = { version: 2, jobs: [{ ...meta(a1), outputAppend: '!', offset: 5 }], removed: ['a2'], nextId: 6 };
  const folded = foldAgentData([snapshot, append]);
  assert.deepEqual(folded.records.map((job) => job.id), ['a1']);
  assert.equal(folded.records[0]!.output, 'alpha!');
  assert.equal(folded.nextId, 6);
});

test('the newest full snapshot supersedes prior corruption and accepts summary-only records', () => {
  const { output: _output, requests: _requests, ...summary } = record('a8', 'ignored');
  const folded = foldAgentData([
    { version: 99, jobs: [] },
    { version: 1, jobs: [summary] },
  ]);
  assert.equal(folded.records[0]!.output, '');
  assert.deepEqual(folded.records[0]!.requests, []);
  assert.equal(folded.nextId, undefined);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [summary] }, { version: 99 }]), /Unsupported/);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [summary, summary] }]), /corrupt/);
});

test('metadata deltas replace optional fields instead of preserving obsolete error flags', () => {
  const before = record('a1', 'evidence', { error: 'old diagnostic', taskReportStale: true });
  const after = record('a1', 'evidence');
  const journal = new AgentJournal(); journal.hydrate([before], 2);
  const payload = journal.prepare([after], 2)!;
  const restored = foldAgentData([{ version: 1, jobs: [before], nextId: 2 }, payload]);
  assert.equal(restored.records[0]!.error, undefined);
  assert.equal(restored.records[0]!.taskReportStale, undefined);
  assert.equal(restored.records[0]!.output, 'evidence');
  const publicRecord = decodePublicAgentRecords([
    { type: 'custom', customType: AGENTS_ENTRY_TYPE, data: { version: 1, jobs: [before], nextId: 2 } },
    { type: 'custom', customType: AGENTS_ENTRY_TYPE, data: payload },
  ]).records[0]!;
  assert.equal(publicRecord.error, undefined, 'public record assertions must not resurrect omitted mutable metadata');
  assert.equal(publicRecord.taskReportStale, undefined);
  assert.equal(publicRecord.output, 'evidence');
});

test('delta replay never lowers the ID high-water mark after pruning', () => {
  assert.throws(() => foldAgentData([{ version: 1, jobs: [], nextId: 20 }, { version: 2, jobs: [], nextId: 2 }]), /nextId decreased/);
});

test('a metadata-only delta keeps the previously persisted output', () => {
  const a1 = record('a1', 'alpha');
  const folded = foldAgentData([
    { version: 1, jobs: [a1], nextId: 2 },
    { version: 2, jobs: [{ ...meta(a1), status: 'failed', error: 'boom' }], nextId: 2 },
  ]);
  assert.equal(folded.records[0]!.output, 'alpha');
  assert.equal(folded.records[0]!.status, 'failed');
  assert.equal(folded.records[0]!.error, 'boom');
  // Output-offset metadata changes must not serialize or append the unchanged report body.
  const journal = new AgentJournal();
  const recordWithOffset = record('a1', 'old\ncurrent', { outputStart: 4 });
  const initial = journal.prepare([recordWithOffset], 2)!; journal.confirm();
  const changedOffset = journal.prepare([{ ...recordWithOffset, outputStart: 0 }], 2)!;
  assert.equal(changedOffset.jobs![0]!.output, undefined);
  assert.equal(changedOffset.jobs![0]!.outputAppend, undefined);
  assert.equal(foldAgentData([initial, changedOffset]).records[0]!.outputStart, 0);
});

test('folding a brand-new job delta keeps its id and output', () => {
  const folded = foldAgentData([{ version: 2, jobs: [record('a7', 'fresh')], nextId: 8 }]);
  assert.equal(folded.records.length, 1);
  assert.equal(folded.records[0]!.id, 'a7');
  assert.equal(folded.records[0]!.output, 'fresh');
  assert.equal(folded.nextId, 8);
});

test('prepare writes only changed jobs and only the appended output tail', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'alpha');
  const a2 = record('a2', 'beta');
  journal.hydrate([a1, a2], 3);
  assert.equal(journal.prepare([a1, a2], 3), null, 'unchanged records write nothing');

  const grown = { ...a1, output: 'alpha-more' };
  const payload = journal.prepare([grown, a2], 3)!;
  assert.equal(payload.version, 2);
  assert.equal(payload.jobs!.length, 1);
  assert.equal(payload.jobs![0]!.id, 'a1');
  assert.equal(payload.jobs![0]!.output, undefined);
  assert.equal(payload.jobs![0]!.outputAppend, '-more');
  assert.equal(payload.jobs![0]!.offset, 5);
  journal.confirm();
  assert.equal(journal.prepare([grown, a2], 3), null, 'a confirmed append is not repeated');

  // A nextId-only change still persists the high-water mark with no job payload.
  const bumped = journal.prepare([grown, a2], 4)!;
  assert.deepEqual(bumped.jobs, []);
  assert.equal(bumped.nextId, 4);
  journal.confirm();
  assert.equal(journal.nextId, 4);
});

test('Unicode output tails use exact string offsets and preserve every character', () => {
  const before = record('a1', '𝄞中文\n');
  const after = { ...before, output: `${before.output}résumé\u0000` };
  const journal = new AgentJournal(); journal.hydrate([before], 2);
  const payload = journal.prepare([after], 2)!;
  assert.equal(payload.jobs![0]!.offset, before.output.length);
  assert.equal(foldAgentData([{ version: 1, jobs: [before], nextId: 2 }, payload]).records[0]!.output, after.output);
});

test('non-append replacement writes the full output instead of a broken tail', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'alpha');
  journal.hydrate([a1], 2);
  const replaced = journal.prepare([{ ...a1, output: 'OMEGA' }], 2)!;
  assert.equal(replaced.jobs![0]!.output, 'OMEGA');
  assert.equal(replaced.jobs![0]!.outputAppend, undefined);
  assert.equal(replaced.jobs![0]!.offset, undefined);
});

test('a failed append never swallows the diff or later updates', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'one');
  journal.hydrate([a1], 2);
  assert.ok(journal.prepare([{ ...a1, output: 'one-two' }], 2));
  // Simulate an append that threw: no confirm, so the same diff must be offered again.
  assert.ok(journal.prepare([{ ...a1, output: 'one-two' }], 2));
  const merged = journal.prepare([{ ...a1, output: 'one-two-three' }], 2)!;
  assert.equal(merged.jobs![0]!.offset, 3);
  assert.equal(merged.jobs![0]!.outputAppend, '-two-three');
  journal.confirm();
  assert.equal(journal.prepare([{ ...a1, output: 'one-two-three' }], 2), null);
});

test('corrupt, unknown and offset-mismatched journals throw instead of dropping data', () => {
  assert.throws(() => foldAgentData([{ version: 9, jobs: [] }]), /Unsupported agent journal version/);
  assert.throws(() => foldAgentData([{ version: 1 }]), /corrupt/);
  const a1 = record('a1', 'alpha');
  assert.throws(() => foldAgentData([{ version: 2, jobs: [{ ...meta(a1), offset: 4, outputAppend: 'x' }] }]), /no base record/);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [a1] }, { version: 2, jobs: [{ ...meta(a1), offset: 4, outputAppend: 'x' }] }]), /offset mismatch/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [{ ...meta(a1), offset: 5 }] }]), /offset/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [{ ...meta(a1), outputAppend: 'x' }] }]), /offset/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [meta(record('a9', ''))] }]), /missing its initial output/);
  assert.throws(() => foldAgentData([{ version: 1, jobs: [], nextId: 0 }]), /nextId/);
  assert.throws(() => foldAgentData([{ version: 2, jobs: [], removed: [7] }]), /corrupt/);
});

test('foldAgentEntries reads the whole branch and ignores foreign entries', () => {
  const a1 = record('a1', 'alpha');
  const folded = foldAgentEntries([
    { type: 'custom', customType: 'pi-dag-workflow.state', data: { version: 1, tasks: [] } },
    { type: 'custom_message', customType: AGENTS_ENTRY_TYPE, content: 'a model message is not authoritative agent state' },
    { type: 'custom', customType: AGENTS_ENTRY_TYPE, data: { version: 1, jobs: [a1], nextId: 2 } },
    { type: 'custom', customType: AGENTS_ENTRY_TYPE, data: { version: 2, jobs: [{ ...meta(a1), outputAppend: '!', offset: 5 }], nextId: 3 } },
  ]);
  assert.equal(folded.records.length, 1);
  assert.equal(folded.records[0]!.output, 'alpha!');
  assert.equal(folded.nextId, 3);
});

test('pruning records never resurrects ids and keeps the high-water nextId', () => {
  const journal = new AgentJournal();
  const a1 = record('a1', 'one');
  const a2 = record('a2', 'two');
  const a3 = record('a3', 'three');
  journal.hydrate([a1, a2, a3], 20);
  const payloads: unknown[] = [{ version: 1, jobs: [a1, a2, a3], nextId: 20 }];
  const prune = journal.prepare([a3], 20)!;
  assert.deepEqual(prune.jobs, []);
  assert.deepEqual(prune.removed, ['a1', 'a2']);
  payloads.push(prune);
  journal.confirm();
  const folded = foldAgentData(payloads);
  assert.deepEqual(folded.records.map((job) => job.id), ['a3']);
  assert.equal(folded.nextId, 20);
  assert.equal(journal.prepare([a3], 20), null, 'a pruned record never returns');
});

test('byte benchmark: append-only deltas replace full-snapshot rewrites', () => {
  // Steady state: 128 jobs of 64 KiB. One small append must not rewrite ~8.4 MB.
  const jobs = Array.from({ length: 128 }, (_, index) => record(`a${index + 1}`, 'x'.repeat(64 * 1024)));
  const snapshot = { version: 1, jobs, nextId: 129 };
  const fullBytes = JSON.stringify(snapshot).length;
  const journal = new AgentJournal();
  journal.hydrate(jobs, 129);
  const grown = jobs.map((job, index) => index === 0 ? { ...job, output: `${job.output}\nupdate` } : job);
  const payload = journal.prepare(grown, 129)!;
  const deltaBytes = JSON.stringify(payload).length;
  assert.ok(fullBytes > 8_000_000, `full snapshot was only ${fullBytes} bytes`);
  assert.ok(deltaBytes < 50_000, `delta was ${deltaBytes} bytes`);
  assert.ok(fullBytes / deltaBytes > 200, `expected >200x, got ${fullBytes}/${deltaBytes}`);
  journal.confirm();
  const folded = foldAgentData([snapshot, payload]);
  assert.equal(folded.records.length, 128);
  assert.equal(folded.records[0]!.output, `${'x'.repeat(64 * 1024)}\nupdate`);
  assert.equal(folded.records[127]!.output, 'x'.repeat(64 * 1024));

  // Growing children: six 4 KiB jobs with 30 updates should not repeat whole snapshots.
  const journal2 = new AgentJournal();
  const base = Array.from({ length: 6 }, (_, index) => record(`b${index + 1}`, 'y'.repeat(4 * 1024), { status: 'running' }));
  journal2.hydrate(base, 7);
  const captured: unknown[] = [{ version: 1, jobs: base, nextId: 7 }];
  let current = base;
  let fullTotal = 0;
  let deltaTotal = 0;
  for (let round = 0; round < 30; round++) {
    const changed = round % 6;
    current = current.map((job, index) => index === changed ? { ...job, output: `${job.output}#${round}\n` } : job);
    fullTotal += JSON.stringify({ version: 1, jobs: current, nextId: 7 }).length;
    const step = journal2.prepare(current, 7);
    assert.ok(step, `round ${round}`);
    deltaTotal += JSON.stringify(step).length;
    captured.push(step);
    journal2.confirm();
  }
  assert.ok(fullTotal > deltaTotal * 8, `expected >8x, got ${fullTotal}/${deltaTotal}`);
  const restored = foldAgentData(captured);
  assert.equal(restored.records.length, 6);
  for (const [index, job] of current.entries()) assert.equal(restored.records[index]!.output, job.output);
});
}

// Pure diagnostic classification/redaction from agents-protocol.test.ts.
import * as protocolDiagnostics from '../src/agents/domain/diagnostics.ts';
{
const {agentFailure,safeDiagnostic}=protocolDiagnostics;
test('diagnostics distinguish quota/auth/transient/unknown and redact credentials without auto retry', () => {
  const token = ['s', 'k', '-'].join('') + 'x'.repeat(28);
  const values = [
    ['429 insufficient_quota: billing limit exhausted', 'quota', false],
    ['429 usage_limit_reached', 'quota', false],
    ['The usage limit has been reached', 'quota', false],
    ['HTTP 503 billing service temporarily unavailable', 'network', true],
    ['401 invalid_api_key', 'auth', false],
    ['ECONNRESET: stream disconnected', 'network', true],
    ['Agent deadline exceeded', 'timeout', true],
    ['provider aborted without a diagnostic', 'unknown', null],
  ] as const;
  for (const [value, kind, retryable] of values) { const result = agentFailure(value); assert.equal(result.kind, kind); assert.equal(result.retryable, retryable); assert.match(result.recovery, /explicit resumeFrom/); }
  const credentialUrl = new URL('https://example.org/a?token=private-token');
  credentialUrl.username = 'user'; credentialUrl.password = 'pass';
  assert.doesNotMatch(safeDiagnostic(`request failed at ${credentialUrl}`), /user:pass|private-token/);
  const input = `Authorization: Bearer ${token}; api_key="private-value" ${credentialUrl}`;
  assert.doesNotMatch(safeDiagnostic('{"token":"example-private","refresh_token":"example-refresh"}'), /example-private|example-refresh/);
  const safe = safeDiagnostic(input);
  assert.doesNotMatch(safe, /private-value|private-token|user:pass|x{28}/);
  assert.match(safe, /redacted/); assert.ok(safeDiagnostic('x'.repeat(10000)).length <= 2048);
  for (const header of ['Authorization: Basic', 'Proxy-Authorization: Basic', 'Authorization: ApiKey', 'Cookie: session=', 'Set-Cookie: session=']) {
    const secret = Buffer.from('example:private-password').toString('base64');
    assert.doesNotMatch(safeDiagnostic(`${header} ${secret}\nHTTP 401 rejected`), new RegExp(secret));
    assert.match(safeDiagnostic(`${header} ${secret}\nHTTP 401 rejected`), /HTTP 401 rejected/);
  }
});

}

test('the child reads its profile instructions once and removes them from its environment', () => {
  const env: NodeJS.ProcessEnv = { PI_DAG_AGENT_PROFILE_PROMPT: 'Use the Chrome bridge over curl.' };
  assert.equal(takeProfilePrompt(env), 'Use the Chrome bridge over curl.');
  assert.equal('PI_DAG_AGENT_PROFILE_PROMPT' in env, false, 'a leftover variable would leak to further child processes');
  assert.equal(takeProfilePrompt({}), undefined);
  assert.equal(takeProfilePrompt({ PI_DAG_AGENT_PROFILE_PROMPT: '   ' }), undefined);
});
