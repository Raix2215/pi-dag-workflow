# pi-dag-workflow

[![CI](https://github.com/Raix2215/pi-dag-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Raix2215/pi-dag-workflow/actions/workflows/ci.yml)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Tasks, dependencies, read-only planning, subagents, and automatic goal continuation for [Pi](https://pi.dev). Keep one task list in the current session, see what is running, and verify results before marking work complete.

## Install

```bash
pi install https://github.com/Raix2215/pi-dag-workflow
```

Restart Pi or run `/reload`. Use `pi config` to select the modules you need.

Requires **Pi 1.0.0+** and **Node.js 22.19.0+**. Subagents require a Node-based Pi host. Use a Nerd Font for the panel icons. The interface supports English and Simplified Chinese.

Use one extension for each shared name, such as `todo`, `/plan`, `/goal`, or `subagent_spawn`.

## Quick start

Ask Pi to organize and execute the work:

> Track investigation, implementation, and tests as Todos. Make implementation depend on investigation, delegate independent work, and verify results before completing tasks.

```text
/plan start
```

Explore the project and organize the Todo list. When ready to implement:

```text
/plan off
/todos
/dag
```

For a task that should continue across model turns:

```text
/goal new Add CSV export with tests
/goal enable #1
```

Create a Goal only when you want continued work. Record important findings or decisions when they change the next action; ordinary activity belongs in the task and tool results.

## What you get

- **Todo dependencies.** `blockedBy` links tasks. Starting, completing, or dispatching a task requires its prerequisites to be completed.
- **Read-only Plan.** Inspect, search, ask questions, and edit task definitions. Implementation and dispatch require `/plan off`.
- **Parallel subagents.** Up to eight independent Pi processes, with explicit assignments, questions, reports, profiles, and same-task continuation.
- **Goal continuation.** One active objective, a shared continuation allowance, bounded error recovery, and user-controlled pause policies.
- **Live progress.** Task tree or DAG previews, current child activity, pending delivery, and pending verification. Full views are scrollable.
- **Session persistence.** Tasks, Goals, and job records follow the current Pi branch. Restore pauses autonomous work and leaves previous child processes stopped.

## Tasks and dependencies

The model manages tasks with `todo`. This batch creates two dependent tasks atomically:

```json
{
  "action": "batch",
  "operations": [
    { "action": "create", "ref": "build", "subject": "Implement CSV export" },
    { "action": "create", "subject": "Verify CSV export", "blockedBy": ["@build"] }
  ]
}
```

A batch accepts **1–50 definition operations**: pending creates and definition updates. `@ref` refers to an earlier create in that call. Any invalid operation leaves the task list unchanged.

Useful queries:

```json
{"action":"list","ready":true,"limit":50}
{"action":"get","id":2}
```

`list` defaults to 50 tasks, with a maximum page size of 200. Use the returned continuation arguments to read the next page with the same filters. `get` returns the complete task, its direct dependents (`blocks`), and unmet prerequisites.

Task states are `pending`, `in_progress`, `completed`, `failed`, `cancelled`, and `deleted`. A single create accepts `pending` or, when dependencies permit, `in_progress`; batches create pending tasks. Failed and cancelled attempts do not satisfy dependencies.

After verification, update the status:

```json
{"action":"update","id":1,"status":"completed"}
```

Keep `description` for task requirements and necessary context. Put verification summaries in the conversation or link to artifacts; a status change does not need another report in the task description.

### Views and cleanup

A dependency tree shows the current task and its worker:

```text
●  Todo (1/3)
└─ #1       ✓ Inspect parser                        [Main session] [Completed]
   └─ #2    ◐ Add CSV export                         [a1 · worker] [󰥔 Running]
      └─ #3 ○ Test CSV export                         [Main session] [Pending]
```

`/dag` draws the same task dependencies:

```text
●  Todo (1/3) DAG
          ┌───────────────────────────────┐
          │ ✓ #1 Inspect parser           │
          │ [Main session]                │
          │ [Completed]                   │
          └──────────────┬────────────────┘
                         └─┐
                           │
                           │
          ┌────────────────┴──────────────┐
          │ ◐ #2 Add CSV export           │
          │ [a1 · worker]                 │
          │ [󰥔 Running]                   │
          └──────────────┬────────────────┘
                         └─┐
                           │
                           │
          ┌────────────────┴──────────────┐
          │ ○ #3 Test CSV export          │
          │ [Main session]                │
          │ [Pending]                     │
          └───────────────────────────────┘
```

`/todos` opens the full list; `/dag` opens the dependency graph. Use `paths` for a dependency tree or `flat` for a flat list. The above-editor preview shrinks with the terminal height, is capped at 12 lines, and prioritizes work needing attention. Graphs that do not fit use a dependency list. Full views support ↑/↓, PgUp/PgDn, Home/End, and Esc.

Filters: `full`, `pending`, `completed`, `failed`, `cancelled`.

- `pending` includes work awaiting verification.
- `completed` means the Todo has been accepted.
- `failed` and `cancelled` reflect the latest current child attempt; interrupted attempts count as cancelled.
- A dismissed attempt remains available in job history. Its unfinished Todo returns to `pending` and can be continued.

`/todos clear` opens a confirmation menu. The tool accepts `scope: "completed"`, `"closed"`, or `"all"`. Cleanup preserves active work, undelivered reports, work awaiting verification, and required dependency records. IDs are not reused.

## Subagents

Give each child an assignment with input paths, scope, and expected evidence:

```json
{
  "task": "Inspect the CSV parser and report edge cases with file and line references. Do not edit files.",
  "todoId": 1,
  "tools": ["read", "grep", "find", "ls"]
}
```

Use `subagent_spawn` for that call. A `todoId` is optional; linked tasks must be ready. Children work in the same directory with independent model context. They discover workspace rules and receive the selected assignment, profile guidance, and optional fragment brief.

### Inspect, collect, and direct

With `subagent_inspect`:

```json
{"jobId":"a1"}
{"jobId":"a1","output":true,"timeout":0}
{"jobId":"a1","output":true,"until":"finish","timeout":30}
```

The default returns short status, activity, and pending question IDs. `output: true` collects output and questions. It requires `jobId` and supports:

- `timeout: 0`: immediate snapshot.
- `until: "update"`: wait for a new report, question, or end; default timeout 5 seconds.
- `until: "finish"`: wait for execution to finish or a question; default timeout 30 seconds.
- `after`: wait beyond a known `reportVersion`.

Waits are capped at 300 seconds, and questions return early. Timeout or cancellation ends the wait; use `subagent_cancel` to stop the child.

With `subagent_send`:

```json
{"recipient":"a1","message":"Include quoted fields and empty rows in the review."}
{"requestId":"request-id","message":"Use the documented CSV rules."}
```

Normal direction is queued at a safe boundary. Add `interrupt: true` with a `recipient` to stop the current local turn, clear obsolete queued direction and questions, and continue in the same child context. Delivery confirmation does not prove the instruction was followed.

### Continue an interrupted task

First inspect the failure and check any files or external actions already affected. Then start a new attempt on the same Todo:

```json
{
  "resumeFrom": "a1",
  "profile": "research",
  "task": "Check the existing findings and continue the remaining parser review. Do not repeat completed work."
}
```

`resumeFrom` keeps the original Todo binding and retained assignment. The new job can use another profile; its tools remain the previous attempt's tools unless explicitly overridden. A changed Todo definition requires a fresh self-contained assignment. Records without a saved full assignment require complete instructions in `task`.

Explicit cancellation dismisses a failed or interrupted attempt from the current panel while preserving its history. The unfinished task shows **Ready to resume**. A main-session status update takes over the task; a new child attempt displays its own activity.

Child errors include a bounded diagnostic and recovery guidance. Resolve account or network problems, verify partial results, and continue explicitly. Child model requests do not retry automatically. The default job deadline is 600 seconds; `timeout` can set up to 86,400 seconds.

### Accepting results

Execution, report delivery, and acceptance are separate:

```text
Child finishes → report delivered → main verifies work → Todo completed
```

A successful child shows **Pending delivery**, then **Pending verification** on its linked unfinished task. The main session completes the Todo after checking the work. Cancelling an already successful job preserves its undelivered report; `remove: true` explicitly discards the record.

For delivery timing and interruption details, see [Agent communication](docs/COMMUNICATION.md).

## Goals

A Goal stores an objective and acceptance criteria. Creating one leaves it paused; `/goal enable` starts continued work. Complete it only after every original requirement has been verified.

| Control | Behavior |
|---|---|
| `/goal enable [#id]` | Start or resume the selected Goal. An already active idle Goal continues with its remaining allowance. |
| `/goal disable [#id]` | Pause the Goal. Running children remain independently controllable. |
| `/goal nopause [#id]` | Choose whether the model may pause. Blocking requires autonomous decisions within existing permissions. |
| `/goal nolimit [#id]` | Choose a finite or unlimited continuation-turn allowance, preserving the used count. |
| `/goal complete #id` | Record verified completion. |

Automatic Goal turns and child-report wakes share a default allowance of **32**. This counts plugin-requested continuations, not every API request or tool-result follow-up. Regular mode replans after eight rounds without recorded work progress and pauses if the next round remains unproductive. `nopause` keeps trying while user stops, budget limits, and error safeguards remain effective.

Update `progress` only for important verified results, reproducible findings, decisions, or changed blockers. Update `nextStep` when the next action materially changes. Work notes do not change the objective or its permissions.

Goal error recovery waits for Pi's native recovery to finish. Quota, billing, authentication, and other explicit permanent errors pause the Goal. Recoverable or unclassified errors use bounded exponential retry delays; the default limit is five retries. Successful turns reset the error count. Error retries remain bounded with `nolimit`.

Pi 1.1+ supplies an explicit cancellation signal at final settlement. Hosts without that signal conservatively pause an unresolved provider-aborted run. Resume explicitly after checking the cause.

## Tools and commands

These are model tools; JSON examples above show their arguments.

| Tool | Purpose |
|---|---|
| `todo` | Tasks, paged queries, dependency checks, fragments, and atomic definition batches |
| `goal` | Objectives, important progress, continuation, and verified completion |
| `subagent_spawn` | New child jobs and `resumeFrom` attempts |
| `subagent_inspect` | Status, optional output/waiting, and profile discovery |
| `subagent_send` | Direction and answers to child questions |
| `subagent_cancel` | Stop or explicitly remove a child record |

| Command family | Common operations |
|---|---|
| `/todos` | `add`, `start`, `done`, `pending`, `failed`, `cancelled`, `edit`, `delete`, `clear`, `paths`, `flat`, `view`, `show`, `hide`, `presets`, `apply`, `reset` |
| `/dag` | `[full/pending/completed/failed/cancelled]` |
| `/plan` | `start`, `off`, `status`, `tools name1,name2` |
| `/goal` | `new`, `enable`, `disable`, `complete`, `delete`, `edit`, `get`, `list`, `nopause`, `nolimit`, `config`, `reset` |
| `/agents` | `list`, `wait`, `send`, `reply`, `cancel`, `remove`, `pause`, `resume`, `profiles`, `profile`, `unprofile`, `reset` |

Run a command family with `help` for syntax. `/agents wait a1` shows output to you; the model collects it through `subagent_inspect` with `output: true`.

## Configuration

Files live under Pi's agent directory, normally `~/.pi/agent/pi-dag-workflow/`. `/goal config` shows their paths. Configuration uses Pi's selected agent directory, including `PI_CODING_AGENT_DIR` overrides.

### Settings

Optional `pi-dag-workflow-config.json`:

```json
{
  "language": "auto",
  "goalMaxTurns": 32,
  "goalNoProgressLimit": 8,
  "goalErrorRetries": 5,
  "planTools": [],
  "goalNoPauseTools": ["ask_user_question"]
}
```

| Setting | Accepted values |
|---|---|
| `language` | `auto`, `en`, `zh-CN`; auto follows the terminal locale |
| `goalMaxTurns` | 1–200; default allowance for new Goals |
| `goalNoProgressLimit` | 1–100; no-progress rounds before replanning |
| `goalErrorRetries` | 0–20; zero pauses at the first settled model error |
| `planTools` | Up to 16 trusted additional read-only tool names |
| `goalNoPauseTools` | Up to 16 main-session tools blocked while a nopause Goal runs |

Trust extra Plan tools only when they are read-only. Editing, shell execution, and dispatch remain guarded. Apply settings with `/reload`.

### Profiles

Optional `pi-dag-workflow-profile.json`:

```json
{
  "profiles": [
    {
      "name": "research",
      "thinking": "off",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "Read the supplied inputs and report findings with file and line references."
    }
  ]
}
```

Omitting `profile` or selecting `inherit` captures the parent's current model, thinking, and active supported built-in tools. Named profiles override the fields they specify; call-level `tools` replaces the tool list. Optional `model` is `{ "provider": "…", "id": "…" }` using an exact registered model name. Implicit thinking adapts to model capabilities; an explicitly unsupported level is rejected.

Supported child tools: `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, and `powershell` when available. Children also receive their parent-communication tool. Select read-only tools explicitly for a read-only assignment.

Profile guidance is sent as task context. Discover profiles with `subagent_inspect`:

```json
{"profiles":"summary"}
{"profile":"research"}
```

Summaries include settings without instructions. A named query returns that profile in full; `profiles: true` requests the full directory. Profiles allow 1–48 character names, up to 8 tools and 2,000 characters of instructions. The file holds up to 64 profiles within 64 KiB. `/agents profile` saves with owner-only file permissions.

### Task fragments

Optional `pi-dag-workflow-preset.json`:

```json
{
  "presets": [
    {
      "name": "verify-change",
      "description": "Review and test a completed change",
      "steps": [
        { "key": "review", "subject": "Review implementation" },
        { "key": "test", "subject": "Test {target}", "after": ["review"] }
      ]
    }
  ]
}
```

Discover and apply fragments with `todo`:

```json
{"action":"presets"}
{"action":"presets","preset":"verify-change"}
{"action":"apply","preset":"verify-change","vars":{"target":"CSV export"}}
```

A directory query returns names, descriptions, and step counts. A named query returns the full definition. Each apply creates a new run with fresh IDs. `reset` reopens a run or selected step and its live downstream tasks; active child bindings protect their tasks from reset. `context: true` on a bound child supplies a bounded fragment brief.

A fragment has 1–32 steps. `after` names prerequisite step keys; `description` and `activeForm` provide task guidance, and `owner` is a display label. Optional `skill` is a suggested skill name. The file holds up to 64 fragments within 64 KiB. Keep personal configuration owner-readable and outside source control.

### Modules

Select these resources with `pi config`:

| Resource | Provides |
|---|---|
| `src/todos/index.ts` | Todo tool, `/todos`, `/dag` |
| `src/plan/index.ts` | Plan command and execution guard |
| `src/agents/index.ts` | Child jobs, messages, and profiles |
| `src/goal/index.ts` | Goal tracking and continuation |
| `src/ui/index.ts` | Preview panel and full detail views |

For example, use Todos + Plan + UI for planning and execution, or Goal + UI for research. Task-linked jobs and task graphs require Todos. Reload applies module selection.

## Safety and persistence

- Tasks, Goals, assignments, diagnostics, and finalized child output are saved in Pi session records and follow the active branch. Treat session files as potentially sensitive.
- Child jobs use your configured models and inherit the process environment. Plan and tool selection are execution guards; all processes run with your operating-system permissions.
- Cancellation and branch navigation do not roll back files, commits, or external requests. Check side effects before continuing work.
- Restore stops previous children and pauses the Goal. It restores records, not a child execution checkpoint. Partial text that never finalized before a crash may be unavailable.
- Goal requirements are supplied through current context and recovery checkpoints. Memory summaries and earlier messages are preserved; reports still require verification.
- Long child reports consume model context and session storage. Diagnostic summaries redact common credential forms, but arbitrary report content should still be reviewed before sharing.
- The extension sends no telemetry. Model requests use Pi's configured providers. Child usage is recorded separately from the parent; configured costs are estimates, not invoices.

See [Agent communication](docs/COMMUNICATION.md), [Contributing](CONTRIBUTING.md), and the [security policy](SECURITY.md).

## Acknowledgements

Inspired by work in the Pi community, including [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo), [pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode), [Pi Subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents), and [pi-goal-x](https://github.com/tmonk/pi-goal-x).

## License

[MIT](LICENSE)
