# pi-dag-workflow

English | [简体中文](README.zh-CN.md)

A visible, session-scoped workflow for [Pi](https://pi.dev): one Todo list with `blockedBy` dependencies, a read-only Plan mode, up to four independent Pi subagents, and a Goal loop with a bounded continuation budget. The main model decides what to execute; the extension validates dependencies and keeps progress on screen.

## What it does

- **One task list, one derived DAG.** Todos carry prerequisites through `blockedBy`. Unfinished prerequisites block starting and completing downstream work, and `/dag` draws the real graph from that same list. There is no second queue or database.
- **Plan before you build.** Plan is a read-only mode for reading, searching, asking, and rearranging Todos. Implementation, shell commands, and dispatch are blocked until you leave it.
- **Real child jobs.** Run up to four Pi subprocesses. Give each one a task, an optional Todo link, and an optional named profile; send direction, answer questions, wait, cancel, or remove records. A finished child stays **Pending delivery** until its report reaches the main conversation. Returned work never completes a Todo by itself.
- **Bounded goals.** Focus one Goal. Automatic continuation and child-report wakes share a default 20-wake allowance; a Goal also pauses after three consecutive rounds without new progress. Pause happens on interruption, restore, Plan, an exhausted allowance, or a stalled run.
- **Readable progress.** A Nerd Font panel shows the task tree, a solid-line DAG, and live thinking/tool/output activity. Interface activity is not written into model context or persistent workflow state.
- **Session-scoped persistence.** Todo, Goal, budget, and job snapshots follow the active Pi branch. Restoring a session never resurrects child processes and never resumes autonomous work on its own.

## Requirements

- Pi `>= 0.99.2`
- Node.js `>= 22.19.0`. The subagent module requires Pi to run under Node; standalone binary hosts are outside its supported scope.
- A Nerd Font is recommended for the intended panel glyphs (icons, not emoji)

## Install

```bash
pi install https://github.com/<owner>/pi-dag-workflow
```

Replace `<owner>` with the repository owner. Pi installs the extension from that GitHub repository; there is currently no npm package. Restart Pi or run `/reload` afterwards, then choose which modules to load with `pi config` (see below).

If another extension already provides Todo, Plan, Goal, or subagent tools, disable it while this one is enabled. Common tool names are similar, but options and stored state are not portable between plugins.

## Quick start

Describe the work to the main model:

> Track investigation, implementation, and tests as Todos. Make implementation depend on investigation, and integration depend on implementation plus tests. Delegate independent work only when it helps, and inspect results before completing tasks.

Useful entries while you work:

- `/plan start` to explore read-only; `/plan off` before implementing.
- `/todos` for the full list and `/dag` for the dependency graph.
- `/goal new Improve the parser` creates a Goal without starting it; `/goal enable #1` starts focused continuation.

Research does not require Todos: the model can report new progress and a concrete next step with `goal update`, or pause while it waits for your answer.

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

Every operation has exactly one spelling. Synonyms accepted by earlier versions (`focus`, `switch`, `resume`, `pause`, `on`, `off`, `done`, `del`, `create`, `status`, `/plan exit`) now answer with the valid actions instead of being forwarded to the model.

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

## Configuration

Configuration only holds plugin settings and is stored separately from Pi's session records. It uses these file names; locate them with `/goal config`.

### `pi-dag-workflow-config.json`

Optional. Choose modules with `pi config`, not in this file. Apply changes with `/reload`.

```json
{
  "language": "auto",
  "goalMaxTurns": 20,
  "goalNoProgressLimit": 3
}
```

- `language` — `"auto"`, `"en"`, or `"zh-CN"`. `auto` selects `zh-CN` when the terminal locale is Chinese and `en` otherwise. Plugin labels, help, notifications, and workflow messages are localized. User-authored content, command names, and structured tool fields stay unchanged.
- `goalMaxTurns` — default allowance for newly created Goals (1–200), shared by automatic continuation and child-report wakes.
- `goalNoProgressLimit` — consecutive rounds without new progress before a Goal pauses (1–10).

Remove any legacy `modules` field. An invalid or unknown field is a configuration error rather than a silently honored second set of switches.

### `pi-dag-workflow-profile.json`

Save profiles with `/agents profile …`, or edit this optional user-level file:

```json
{
  "profiles": [
    {
      "name": "research",
      "thinking": "off",
      "tools": ["read", "grep", "find", "ls"]
    }
  ]
}
```

The command form is `/agents profile name provider/model [thinking] [comma-tools]`, where `provider/model` is a placeholder for a model already registered in Pi. A profile without a `model` field inherits the model selected in the current main session; children default to `read`, `grep`, `find`, and `ls` with thinking off. Explicit built-in tools may add `write`, `edit`, or `bash`. Arbitrary parent extension tools are not copied, and models and tools are validated when you save.

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
