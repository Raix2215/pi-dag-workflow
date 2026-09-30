import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi's actual resource loader loads only this package without model calls or user settings", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-dag-workflow-load-"));
  try {
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd: temporary,
      agentDir: join(temporary, "agent"),
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [entry],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0]!;
    assert.equal(extension.resolvedPath, entry);
    assert.deepEqual([...extension.tools.keys()], ["todo", "subagent_spawn", "subagent_inspect", "subagent_send", "subagent_wait", "subagent_cancel", "goal"]);
    assert.deepEqual([...extension.commands.keys()], ["todos", "dag", "plan", "agents", "goal"]);
    assert.deepEqual([...extension.handlers.keys()].sort(), ["agent_before_settle", "agent_end", "agent_settled", "before_agent_start", "input", "session_before_fork", "session_before_switch", "session_before_tree", "session_shutdown", "session_start", "session_tree", "tool_call", "tool_execution_end", "turn_end", "ui_prompt_start", "user_bash"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
