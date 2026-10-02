# pi-dag-workflow

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![Node 22.19.0+](https://img.shields.io/badge/Node-22.19.0%2B-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

A visible, session-scoped workflow for [Pi](https://pi.dev): one Todo list with `blockedBy` dependencies, a read-only Plan mode, up to eight independent Pi subagents, and a Goal loop with a bounded continuation budget. The main model decides what to execute; the extension validates dependencies and keeps progress on screen.

## What it does

- **One task list, one derived DAG.** Todos carry prerequisites through `blockedBy`. Unfinished prerequisites block starting and completing downstream work, and `/dag` draws the real graph from that same list. There is no second queue or database.
- **Plan before you build.** Plan is a read-only mode for reading, searching, asking, and rearranging Todos; read-only network tools can be enabled through `planTools`. Implementation, shell commands, and dispatch are blocked until you leave it.
- **Real child jobs.** Run up to eight Pi subprocesses. Give each one a task, an optional Todo link, and an optional named profile; send direction, answer questions, wait, cancel, or remove records. A finished child stays **Pending delivery** until its report reaches the main conversation. Returned work never completes a Todo by itself.
- **Bounded goals.** Focus one Goal. Automatic continuation and child-report wakes share a default 32-wake allowance; a Goal also pauses after three consecutive rounds without new progress. A failed model request retries automatically (5 attempts by default) before the Goal pauses. Pause happens on interruption, restore, Plan, an exhausted allowance or retry budget, or a stalled run.
- **Readable progress.** A Nerd Font panel shows the task tree, a solid-line DAG, and live thinking/tool/output activity. Interface activity is not written into model context or persistent workflow state.
- **Session-scoped persistence.** Todo, Goal, budget, and job snapshots follow the active Pi branch. Restoring a session never resurrects child processes and never resumes autonomous work on its own.

## Requirements

- Pi `>= 1.0.0`
- Node.js `>= 22.19.0`. The subagent module requires Pi to run under Node; standalone binary hosts are outside its supported scope.
- A Nerd Font is recommended for the intended panel glyphs (icons, not emoji)

## Install

```bash
pi install https://github.com/Raix2215/pi-dag-workflow
```

Pi installs the extension from that GitHub repository; there is currently no npm package. Restart Pi or run `/reload` afterwards, then choose which modules to load with `pi config` (see below).

If another extension already provides Todo, Plan, Goal, or subagent tools, enable one of them — see [Compatibility with other plugins](#compatibility-with-other-plugins).

## Quick start

Describe the work to the main model:

> Track investigation, implementation, and tests as Todos. Make implementation depend on investigation, and integration depend on implementation plus tests. Delegate independent work only when it helps, and inspect results before completing tasks.

Useful entries while you work:

- `/plan start` to explore read-only; `/plan off` before implementing.
- `/todos` for the full list and `/dag` for the dependency graph.
- `/goal new Improve the parser` creates a Goal without starting it; `/goal enable #1` starts focused continuation.

Research does not require Todos: the model can report new progress and a concrete next step with `goal update`, or pause while it waits for your answer.

## The panel

The panel sits above the editor and refreshes as work moves; `/dag` shows the same list as a solid-line
dependency graph. Both are rendered from the one Todo list.

```text
●  Todo (1/5) · 󰓾 Goal: #1 Ship the parser rewrite
└─ #1              ✓ Survey the current … [Main session] [Completed]
   └─ #2           ◐ Rewrite the tokenizer      [a1 · fast] [󰆍 Tool]
      ├─ #3        ○ Add regression tests   [Main session] [Pending]
      └─ #4        ○ Update the CLI docs    [Main session] [Pending]
         └─ #5<-#3 ○ Benchmark 10k lines    [Main session] [Pending]
●  Standalone Subagents · 2
├─ a2 · fast   Survey the flaky CI job        [󰧑 Thinking]
└─ a3 · codex  Draft the migration guide      [󰥔 Pending delivery]
```

`#5<-#3` means task #5 additionally depends on #3, whose branch is not drawn. `[a1 · fast]` is a running
child job; the status column shows what it is doing right now.

A child spawned without a `todoId` has no task row to report on, so those jobs fill the `Standalone Subagents` section
below the list: live work first, then reports waiting for handoff, then failed, cancelled, or interrupted
jobs. The section stays hidden while no such job needs attention and never repeats a job a task row
already shows. Its root mark follows the same rule as the Todo block: solid while the block still holds
unfinished business, hollow once only settled jobs are left.

```text
●  Todo (1/3) DAG · 󰓾 Goal: #1 Ship the parser rewrite
                       ┌───────────────────┐
                       │ ✓ #1 Survey the … │
                       │ [Main session]    │
                       │ [Completed]       │
                       └────────┬──────────┘
                      ┌─────────┴─────────────┐
                      │                       │
                      │                       │
           ┌──────────┴────────┐   ┌──────────┴────────┐
           │ ◐ #2 Rewrite the… │   │ ○ #3 Add regress… │
           │ [a1 · fast]       │   │ [Main session]    │
           │ [󰆍 Tool]          │   │ [Pending]         │
           └───────────────────┘   └───────────────────┘
```

A terminal that cannot fit the graph falls back to the list above, so the dependencies stay readable at any
width.

## Tools

| Tool | Purpose |
|---|---|
| `todo` | create/update/list/get/delete/clear; numeric IDs and `blockedBy` prerequisites |
| `goal` | create/update/list/get/delete; enable; disable; complete — one spelling per operation |
| `subagent_spawn` | start one child with `task` and optional `todoId`/`profile`/`tools`/`timeout` |
| `subagent_send` | message a `recipient` job ID, or answer a `requestId` |
| `subagent_wait` | wait for a result or question; a timeout or abort stops the wait, not the child |
| `subagent_inspect` | job summaries and profiles, not full child conversations |
| `subagent_cancel` | stop a child; optional `remove` discards its record, not project edits |

## Commands

| Command | Examples |
|---|---|
| `/todos` | `add Title --after 1,2`, `start #2`, `done #2`, `pending #2`, `edit #2 New title`, `delete #2`, `clear` |
| Task display | `/todos paths`, `/todos flat`, `show`, `hide`, `view list`, `view dag` |
| `/dag` | solid-line graph; ↑/↓, PgUp/PgDn, Home/End; Esc returns |
| `/plan` | `start`, `off`, `status`, `tools name1,name2` to trust extra read-only tools; `tools none` clears |
| `/goal` | `new Title`, `list`, `enable [ #1]`, `disable [ #1]`, `edit #1 Title`, `complete #1`, `delete #1`, `get #1`, `config`, `reset` |
| `/agents` | `wait a1`, `send a1 Message`, `reply requestId Answer`, `cancel a1`, `remove a1`, `pause`, `resume` |
| Profiles | `/agents profiles`, `profile name provider/model [thinking] [comma-tools]`, `unprofile name` |

Each command family supports `help`; help does not call a model or change modes. Natural-language requests also drive the registered tools.

### Goal lifecycle

`new` only records a Goal and leaves it paused. `enable` is the only activation: it focuses a Goal, or re-enables the current one when the id is omitted, and a completed or deleted Goal cannot be restarted — create a new one for rework. `disable` is the only stop and keeps the focus so you can enable it later. Enabling after a stop starts a fresh allowance, not the remainder of the previous one. Enabling another Goal does not clear the shared Todo list, and disabling a Goal does not kill running children; stop those with `/agents cancel`.

Every operation has exactly one spelling. An unrecognized first word is treated as natural language and forwarded to the model, the same as any other free-form request.

## Modules

Run `pi config`, find the `pi-dag-workflow` package, and toggle its independent resources. Pi stores the selection in its native resource filters; apply changes with `/reload` in a session or by starting a new Pi process.

| Pi resource | Provides |
|---|---|
| `src/todos/index.ts` | Todo tool, `/todos`, `/dag`, and the derived DAG |
| `src/plan/index.ts` | `/plan` command and the read-only guard |
| `src/agents/index.ts` | child processes, messaging, and profiles |
| `src/goal/index.ts` | Goal tool and bounded continuation |
| `src/ui/index.ts` | live panel and scrollable detail views |

Combine Todos + Plan + UI for planning and execution, Goal + UI for independent research, or Agents alone for standalone children. DAG rendering and `todoId` links need Todos. Without UI, command output still works and activity-refresh timers do not run; UI alone has no workflow data to display.

Each entry is a real Pi extension with its own default factory. Loaded entries share one runtime-scoped coordinator through Pi's event bus, so there is no required core checkbox and no duplicate budgets. Reloading releases old subscriptions and child resources, and disabled entries register no tools or guidance. There is **no plugin `modules` setting**.

## Compatibility with other plugins

This extension is a superset of the Todo, Plan, Goal and subagent plugins it was modelled on, so it registers
similarly named tools and commands. Those names cannot be shared:

- **Tools** — Pi keeps one definition per tool name, so a later registration replaces the earlier one.
- **Commands** — Pi renames duplicates, for example two `/plan` registrations become `/plan:1` and `/plan:2`,
  and the plain `/plan` stops working.

| Plugin | Shared names | Guidance |
|---|---|---|
| [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | `todo` tool | Enable one. Task data stays readable in either direction (below). |
| [pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode) | `/plan` command | Enable one; the two plugins enforce read-only planning differently. |
| [Pi Subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents) | `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_inspect`, `subagent_cancel` | Enable one. |
| [pi-goal-x](https://github.com/tmonk/pi-goal-x) | `/goal` command | Enable one; two continuation engines would both wake the model. |

Names are similar, but arguments and stored state are not portable. A child job or Goal created by one plugin
is not understood by the other, and each plugin keeps its own settings and profile files.

### Continuing a session that used rpiv-todo

rpiv-todo stores its list in the `details` of its `todo` tool results, and this plugin writes the same shape:
`tasks`, `nextId`, and the same task fields and status names. Each side therefore reads the other's list.

When this plugin finds no snapshot of its own on the active branch, it replays the last `todo` result from the
branch and continues with the same ids, subjects, statuses, owners and `blockedBy` dependencies instead of
starting with an empty list. This plugin's own snapshot always wins once one exists on the branch, and the same
result shape is written back, so rpiv-todo can pick the list up again if you switch back.

Plan mode, Goals, and child jobs are not shared: those live in per-plugin session entries with their own
formats.

## Configuration

Configuration only holds plugin settings and is stored separately from Pi's session records. It uses these file names; locate them with `/goal config`.

### `pi-dag-workflow-config.json`

Optional. These three keys are the complete configuration; anything absent falls back to the value shown. Choose
modules with `pi config`, not in this file, and apply changes with `/reload`.

```json
{
  "language": "auto",
  "goalMaxTurns": 32,
  "goalNoProgressLimit": 3,
  "goalErrorRetries": 5,
  "planTools": []
}
```

- `language` — `"auto"` (default), `"en"`, or `"zh-CN"`. `auto` selects `zh-CN` when the terminal locale is Chinese and `en` otherwise. Plugin labels, help, notifications, and workflow messages are localized. User-authored content, command names, and structured tool fields stay unchanged.
- `goalMaxTurns` — default allowance for newly created Goals, 1–200 (default `32`), shared by automatic continuation and child-report wakes.
- `goalNoProgressLimit` — consecutive rounds without new progress before a Goal pauses, 1–10 (default `3`).
- `goalErrorRetries` — automatic retries after a failed model request while a Goal is running, 0–20 (default `5`). Each failure retries once; the counter resets after a successful turn, and `0` pauses on the first error. A single retry does not consume the continuation allowance.
- `planTools` — machine-wide extra read-only tools for Plan mode, up to 16 unique names (default `[]`). Use it to let planning search the web, for example `["web_search", "fetch_content", "get_search_content", "source_check"]`; the names must match the tools your Pi has installed. Writes, shell commands, and dispatch stay blocked whatever this lists, and `/plan tools name1,name2` adds tools for one session on top.

Unknown keys and out-of-range values are configuration errors. Module selection lives in `pi config`, not in this
file.

### `pi-dag-workflow-profile.json`

Save profiles with `/agents profile …`, or edit this optional user-level file. This example shows a
read-only researcher and an explicitly configured writer:

```json
{
  "profiles": [
    {
      "name": "research",
      "thinking": "off",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "Read before writing. Report file paths and line numbers, and never edit files."
    },
    {
      "name": "fast-edit",
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
      "thinking": "low",
      "tools": ["read", "grep", "find", "ls", "edit", "write"]
    }
  ]
}
```

- `name` — 1–48 letters, digits, `_` or `-`, starting with a letter or digit. `inherit` is reserved.
- `model` — `provider` and `id` of a model Pi already knows, spelled exactly as `/model` shows it (`anthropic/claude-sonnet-4-5` is an example). Omit `model` to inherit the model selected in the main session, as `research` does above.
- `thinking` — `off` (default), `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. A model without reasoning support must use `off`.
- `tools` — up to 8 child tools. `read`, `grep`, `find`, and `ls` are always available; `edit`, `write`, and `bash` are the optional built-ins. Arbitrary extension tools from the main session are never copied.
- `instructions` — optional guidance, up to 2000 characters, that becomes a system prompt section in every child this profile dispatches (`dag_profile`, next to the built-in child rules). Use it for how this kind of work is done; it cannot grant permissions the task does not have. It travels through the child's environment, is read once and removed there, and never reaches the model through `subagent_inspect`.

The same profiles are editable from a session with `/agents profile name provider/model [thinking] [comma-tools]`
and `/agents unprofile name`. The file holds at most 64 profiles, is limited to 64 KiB, allows no unknown
fields, and is written with owner-only permissions when you save from `/agents`.

## Security and privacy

- **What is stored.** Todo, Goal, budget, and job snapshots live in Pi's own session records and follow the
  active branch. The only file this plugin writes is `~/.pi/agent/pi-dag-workflow/pi-dag-workflow-profile.json`
  when you save a profile (owner-only permissions); the config file is yours to create. Nothing is sent to a
  database or a third-party service.
- **No network calls of its own.** The plugin never contacts a remote endpoint and reports no telemetry.
  Child agents run through Pi with the model and credentials you already configured.
- **Child credentials.** Model bootstrap data reaches a child through an environment variable that the child
  parses and deletes at startup, so it is not written to disk or exposed in command-line arguments.
- **Same operating-system permissions.** The main session, Plan mode, and every child run as you. Plan and
  tool selection are execution guards; cancelling a child stops the process without rolling back its edits.
- **Reports and output.** Child reports, questions, and tool output are stripped of terminal control
  characters before display, then injected into model context and kept in session records. There is no
  plugin-imposed character cap, so long reports consume context and storage like any other session content.

## Important boundaries

- The allowance is a budget for **plugin-requested continuation and wakes**, not a limit on Pi or API calls. Native tool-result follow-ups and retries are counted separately, and reported progress should be verified rather than trusted.
- Completed Todos cannot be silently reopened; create a new task for rework. `clear` does not reuse IDs. Switching or deleting a Goal neither clears Todos nor reverts project files.
- Goal completion is never automatic just because all Todos are done; mark it complete after verifying the result.
- Plan and tool selection are execution guards, **not an OS sandbox**. Extensions and writable children run with your operating-system permissions, and branch navigation does not roll back project edits.
- Restoring a session pauses the Goal and re-arms nothing. Entering Plan requires an idle main run and no active managed children.
- A new session with only command metadata may not have a session file yet; send a normal message so Pi can persist the workflow.
- Child usage is retained in job results. Native parent totals do not include detached children, and any reported cost is a configuration estimate, not an invoice.
- Reports and child output have no plugin-imposed character cap. Children are prompted to report at an appropriate length; longer reports still use model context and session storage. See [communication timing](docs/COMMUNICATION.md) for when reports and tool results reach the main model.
- Dense or large DAGs fall back to a predecessor list, and a clipped widget is marked as a preview rather than a complete graph.

## Acknowledgements

pi-dag-workflow is an independent implementation. Its approach to visible task graphs, read-only planning, subagents, and bilingual interface text was inspired by ideas explored in the wider Pi community, including [pi-workflow](https://github.com/AgwaB/pi-workflow), [pi-subagents](https://github.com/nicobailon/pi-subagents), [pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode), [Pi Subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents), [pi-goal-x](https://github.com/tmonk/pi-goal-x), [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo), and [pi-i18n](https://github.com/jerryfan/pi-i18n). These are references, not runtime dependencies.

## License

[MIT](LICENSE)
