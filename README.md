# pi-dag-workflow

English | [简体中文](README.zh-CN.md)

A visible, session-local workflow for [Pi](https://pi.dev): one Todo list, a derived DAG, read-only Plan mode, single-tier subagents, and bounded Goal continuation. The main model decides what to execute; the extension validates dependencies and keeps progress visible.

## What you get

- **One task list.** Track tasks and prerequisites without a separate DAG queue or database. Unfinished prerequisites block starting and completing downstream work.
- **Plan before implementation.** Explore, search, ask questions, and edit Todos. Plan blocks implementation and dispatch until you exit it.
- **Real child jobs.** Run up to four Pi subprocesses with named profiles; send direction, answer questions, wait, cancel, or remove records. Child results never complete Todos automatically.
- **Bounded goals.** Focus one goal. Goal continuation and child-report wakes share a default 20-wake allowance. Pause on interruption, restore, Plan, exhausted allowance, or repeated lack of progress.
- **Readable progress.** A Nerd Font panel, path/flat task trees, a solid-line DAG with scrolling, and real thinking/tool/output activity. UI activity does not enter model context or persistent task state.
- **Native session recovery.** Todo, Goal, budget and job snapshots follow the active Pi branch. Restoring never resurrects child processes or resumes autonomous work.

## Install

Install this plugin from its GitHub repository with the Pi package installer.

## Quick start

Ask the main model:

> Track investigation, implementation and tests as Todos. Make implementation depend on investigation and integration depend on implementation plus tests. Delegate independent work only when useful; inspect results before completing tasks.

Use `/plan start` for read-only exploration and `/plan off` before implementing. Open `/todos` for the full list or `/dag` for the actual graph. Use `/goal new Improve the parser`, then `/goal enable #1` to start focused continuation; `/goal off` pauses it and `/goal resume` explicitly resumes it.

Research without Todos is supported: the model can use `goal update` with a new `progress` report and a concrete `nextStep`, or pause when it needs user input.

## Tools and commands

| Tool | Purpose |
|---|---|
| `todo` | create/update/list/get/delete/clear; numeric IDs and `blockedBy` prerequisites |
| `goal` | create/update/list/get/delete; enable/focus/switch/resume; disable/pause/complete |
| `subagent_spawn` | start a child with task and optional todoId/profile/tools/timeout |
| `subagent_send` | send to a recipient jobId or answer a requestId |
| `subagent_wait` | result or question; timeout/abort stops the wait, not the child |
| `subagent_inspect` | job summaries and profiles, not full child conversations |
| `subagent_cancel` | stop a child; optional remove discards its record, not project edits |

| Command | Examples |
|---|---|
| `/todos` | `add Title --after 1,2`, `start #2`, `done #2`, `edit #2 New title`, `delete #2`, `clear` |
| Task display | `/todos paths`, `/todos flat`, `show`, `hide`, `view list`, `view dag` |
| `/dag` | solid-line graph; ↑/↓, PgUp/PgDn, Home/End; Esc returns |
| `/plan` | `start`, `off`, `status`, `tools name1,name2` for explicitly trusted read-only tools |
| `/goal` | `new Title`, `enable #1`, `switch #2`, `resume`, `off`, `edit #1 Title`, `complete #1`, `delete #1` |
| `/agents` | `wait a1`, `send a1 Message`, `reply requestId Answer`, `cancel a1`, `remove a1`, `pause`, `resume` |
| Profiles | `/agents profiles`, `profile name provider/model [thinking] [comma-separated-tools]`, `unprofile name` |

Each command has local `help`; it does not call a model or change modes. Natural-language requests can also drive the registered tools.

## Configuration and optional modules

Files live under `~/.pi/agent/pi-dag-workflow/`, respecting Pi's `PI_CODING_AGENT_DIR` and tilde expansion. Configuration is separate from session state.

### `pi-dag-workflow-config.json`

Optional. Missing `modules` enables everything; an explicit array enables only those features. Run `/reload` after changes.

```json
{
  "modules": ["todos", "plan", "agents", "goal", "ui"],
  "goalMaxTurns": 20,
  "goalNoProgressLimit": 3
}
```

| Selection | Behavior |
|---|---|
| `["todos", "plan", "ui"]` | tasks, DAG and planning; no Goal/Subagent tools |
| `["goal", "ui"]` | independent goals; no Todo/Subagent tools |
| `["agents"]` | standalone children; no task links or live panel |
| `[]` | no tools, commands, or session resources from this package |

`ui` controls the live panel and scrollable detail views; local command output remains available without it. DAG belongs to `todos`. `todoId` links require `todos`. Disabled modules do not register their tools or guidance, and disabled UI does not start activity-refresh timers.

There is **one public extension entry** (`src/index.ts`). The per-feature `index.ts` files are internal registrations, not separate `-e` targets: shared Plan guards, Todo identity and Goal/Agent budgeting need one coordinator. Select modules through configuration rather than loading multiple runtimes.

### `pi-dag-workflow-profile.json`

Use `/agents profile …` or edit this optional user-level file:

```json
{
  "profiles": [
    {
      "name": "research",
      "model": { "provider": "example-provider", "id": "example-model" },
      "thinking": "low",
      "tools": ["read", "grep", "find", "ls"]
    }
  ]
}
```

Without a profile, children inherit the selected main model and default to read/grep/find/ls with thinking off. Explicit built-in tools may add write/edit/bash; arbitrary parent extension tools are not automatically copied. Models and supported tools are validated. No user configuration file is written until an explicit profile save.

## Important boundaries

- Twenty is an allowance for **plugin-requested continuation/wakes**, not a total API-call limit. Pi's normal tool-result follow-ups and retries are separate. Progress reports need real main-agent verification.
- Completed Todos cannot be silently reopened; create a new task for rework. Clearing preserves the next ID. Goal switching/deletion does not clear Todos or undo files.
- Entering Plan requires an idle main run and no active managed children. Leaving Plan, viewing state, and restoring do not restart a paused Goal.
- New sessions with command-only metadata may not yet have a session file. Send a normal message to let Pi save it; the package warns rather than creating another task file. `--no-session` is not persistent.
- Extensions and explicitly writable children use your OS permissions. Plan and tool selection are **not a sandbox**. Branch navigation does not roll back project edits.
- Child usage is retained in job results (`/agents wait jobId`); native Pi parent totals do not include detached child cost. Reported prices are configuration estimates, not invoices.
- Dense/large DAGs explicitly fall back to a predecessor list. A clipped widget is marked as a preview, never a complete graph.

## Development

```bash
npm run check                 # typecheck, offline/actual-Pi regression, package check
npm run test:performance      # local rendering benchmark; no model calls
npm run test:goal-flash       # opt-in paid real-model Goal acceptance
npm run test:joint-flash      # opt-in bounded parent + two real children
```

Tests use isolated Pi sessions and explicit resource lists. Live acceptance requires an already configured `example-model`; it consumes quota. Tmux tests remain paused and are not part of default checks.

```text
src/
  index.ts       public entry and module selection
  workflow/      shared session state, coordination and rendering lifecycle
  todos/         Todo state, tool and commands
  plan/          mode command and read-only guard
  agents/        child runtime, messaging, profiles and usage
  goal/          Goal state, attention and shared continuation allowance
  dag/           graph validation, ephemeral cache and solid-line routing
  ui/            theme-aware rendering and scrolling
  shared/        configuration paths and module selection
```
