import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../src/agents/profiles.ts";

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
