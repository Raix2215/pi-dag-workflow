import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Theme, type ThemeColor, type ThemeBg } from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { emptyState } from "../src/todos/state.ts";
import { renderTasks, renderDag } from "../src/ui/render.ts";

test("semantic theme colors do not change terminal width or corrupt user content", () => {
  const builtin = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url), "utf8"));
  const tokens = Object.keys(builtin.colors);
  const palette: Record<string, string> = { accent: "#bf40ff", dim: "#555555", success: "#00cc55", warning: "#ffcc00" };
  const foreground = Object.fromEntries(tokens.map((token) => [token, palette[token] ?? "#cccccc"])) as Record<ThemeColor, string>;
  const background = Object.fromEntries(tokens.map((token) => [token, "#222222"])) as Record<ThemeBg, string>;
  const theme = new Theme(foreground, background, "truecolor");
  const state = { ...emptyState(), plan: true, tasks: [
    { id: 1, subject: "已完成", status: "completed" as const, blockedBy: [] },
    { id: 2, subject: "中文标题 👩‍💻", status: "in_progress" as const, blockedBy: [1], owner: "主会话" },
  ], nextId: 3 };
  for (const width of [20, 40, 80, 120]) {
    const plain = renderTasks(state, width);
    const styled = renderTasks(state, width, { theme });
    assert.deepEqual(styled.map(stripTerminalSequences), plain);
    for (const line of styled) assert.ok(visibleWidth(line) <= width);
    const dagPlain = renderDag(state, width);
    const dagStyled = renderDag(state, width, theme);
    assert.deepEqual(dagStyled.map(stripTerminalSequences), dagPlain);
    for (const line of dagStyled) assert.ok(visibleWidth(line) <= width);
  }
  const styled = renderTasks(state, 120, { theme });
  assert.ok(styled[0]!.startsWith(theme.getFgAnsi("accent")));
  assert.ok(styled[1]!.startsWith(theme.getFgAnsi("dim")));
  assert.ok(styled[1]!.includes(theme.fg("accent", "已完成")));
  assert.ok(styled[1]!.includes(theme.fg("success", "✓")));
  // The header gives each block its own color: Todo accent, Plan error, Goal success.
  assert.ok(styled[0]!.includes(theme.fg("error", "󰏫 Plan [只读]")), "Plan block uses the error color");
  const withGoal = renderTasks(state, 120, { theme, goalTitle: "#1 目标标题" });
  const goalBlock = theme.fg("success", "󰓾 Goal: #1 目标标题");
  assert.ok(withGoal[0]!.includes(goalBlock), "Goal block uses the success color");
  assert.ok(withGoal[0]!.startsWith(theme.getFgAnsi("accent")), "Todo keeps the accent color");
  const withFree = renderTasks({ ...emptyState(), tasks: [] }, 120, { theme, jobs: [{ id: "a1", profile: "fast", status: "running", label: "独立任务" }] });
  assert.ok(withFree[0]!.includes(theme.fg("accent", "● \uf0c0 Standalone Subagents · 1")), "the Subagents block shares the Todo accent color");
  assert.ok(withFree[1]!.includes(theme.fg("muted", "a1 · fast")), "the job reference uses the same muted color as a Todo owner bracket");
  assert.ok(withFree[1]!.includes(theme.fg("accent", "独立任务")), "the excerpt keeps the Todo title accent");
  const dag = renderDag(state, 120, theme, "#1 目标标题");
  assert.ok(dag[0]!.includes(theme.fg("error", "󰏫 Plan [只读]")) && dag[0]!.includes(goalBlock), "the DAG header shares the same colors");
});
