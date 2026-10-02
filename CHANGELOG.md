# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-10-02

### Changed

- **The block is named `Standalone Subagents`** — it lists only the children spawned without a `todoId`, so the plain `Subagents` title read as if it covered every child agent (bound ones report on their task row). At very narrow widths the title falls back to `Standalone · N`, which keeps the distinction and the count instead of clipping both away.

## [0.1.5] - 2026-10-02

### Changed

- **The Subagents block reads like the Todo block** — it gained the same root mark (`●` while the block still holds unfinished business, `○` once only settled jobs are left), and each row's job reference (`a1 · fast`) uses the `muted` color of a Todo owner bracket instead of `dim`. The right-hand status bracket keeps its per-state color.

## [0.1.4] - 2026-10-02

### Changed

- **The Subagents block is titled `Subagents` and carries the Todo accent color** — the block for children spawned without a Todo used a dim glyph and muted text, which read as secondary information. It now shares the accent color of the Todo block, and its title is `Subagents · N` in every locale.

## [0.1.3] - 2026-10-02

### Added

- **A panel section for children spawned without a Todo** — `subagent_spawn` takes an optional `todoId`, and a job without one had no row to report on. The panel now lists those jobs below the list under `\uf0c0 Agents · N`: live work first, then reports waiting for handoff, then failed, cancelled, or interrupted jobs. Each row carries the job id, its profile, a one-line excerpt of its task, and its live status. Jobs a task row already shows stay out, delivered reports stay out, the section hides itself while nothing needs attention, it is capped at four rows with a hidden counter, and narrow terminals drop the excerpt before the state.

### Changed

- **Jobs remember a one-line task excerpt** — `JobSummary.label` keeps the panel excerpt with the job, so a restored session still explains what an interrupted child was doing. `subagent_inspect` stays private-safe: the excerpt never reaches the model through inspection, and restored labels are re-sanitized (escape sequences removed, whitespace collapsed, 80 columns at most).

## [0.1.2] - 2026-10-02

### Changed

- **The workflow tools describe themselves where the model reads first** — Pi lists a tool in the Available tools section only when it declares `promptSnippet`, and appends `promptGuidelines` to the Guidelines section while the tool is active. Previously only `todo` appeared there, calling the list "optional", and no rule mentioned the workflow tools at all. Now `todo`, all five `subagent_*` tools, and `goal` carry snippets, and seven rules cover when to open a list, one `in_progress` task at a time, verifying before completing, `blockedBy` dependencies, when to delegate, that a returned report never completes a task by itself, and creating a Goal only when the user asks for it.

- **Normal-mode and agent guidance rewritten** — `NORMAL_GUIDANCE` asks for the one todo list instead of calling Todos optional, and `<dag_workflow_agents>` keeps only the invariants (single tier, verify returned work) so it does not repeat the new rules.

## [0.1.1] - 2026-10-02

### Added

- **`planTools` configuration** — machine-wide extra read-only tools for Plan mode, up to 16 unique names. Plan can search the web when the configured names match installed tools (for example `web_search`, `fetch_content`); writes, shell commands, and dispatch stay blocked regardless of the list, and `/plan tools` still adds session-scoped tools on top.

- **Automatic recovery from model errors** — a failed model request during Goal execution retries once per failure instead of pausing immediately. The budget is configurable with `goalErrorRetries` (0–20, default `5`), resets after a successful turn, and a single retry does not consume the continuation allowance. User aborts still pause immediately.

### Changed

- **Panel title colors** — the Todo, Plan, and Goal blocks in the panel and `/dag` header now use three different theme colors (`accent`, `error`, `success`) instead of coloring Plan and Goal with the same accent as Todo.

- **Pi 1.0** — verified against Pi 1.0.0. The panel, `/dag`, and the detail view keep working in the new fullscreen default (`tuiMode`), and the tool names Pi 1.0 adds (`powershell`, `codemode`, `tool_search`) stay outside Plan's read-only allowlist. The documented requirement is now Pi `>= 1.0.0`.

### Fixed

- **Enter runs a finished command** — a slash-command argument that already matches a candidate no longer opens the completion menu, so Enter on `/plan start`, `/todos view list`, or `/goal enable 12` submits the command. Pi confirms a highlighted candidate on Enter and submits only command-name completions, so the menu used to swallow that first Enter and leave the line unsent. Partial arguments still complete on Enter.

## [0.1.0] - 2026-10-01

First public preview.

### Added

- **Todo workflow** — one session-scoped Todo list with numeric IDs and `blockedBy` prerequisites. The dependency graph is derived from the list itself; unfinished prerequisites block starting and completing downstream work. Commands cover add/edit/start/done/pending/delete/clear and list or graph views.
- **Read-only Plan mode** — explore, search, ask, and rearrange Todos while implementation, shell commands, and dispatch are blocked. Extra trusted read-only tools can be opted in explicitly. Plan is an execution guard, not an OS sandbox.
- **Single-tier subagents** — spawn up to eight independent Pi child processes, each with a task, an optional Todo link, and an optional named profile. Send direction, answer requests by ID, wait for results, cancel, or remove records. Children cannot spawn grandchildren and never complete a Todo automatically.
- **Bounded Goal continuation** — create a Goal without starting it, then `enable` a single focused target. Automatic continuation and child-report wakes share one allowance (32 by default); a Goal pauses after three consecutive rounds without new progress. `disable` stops continuation while keeping focus, and re-enabling opens a fresh allowance.
- **rpiv-todo compatibility** — a task list written by rpiv-todo in the same session continues here with its ids, statuses, owners and `blockedBy` dependencies, and this plugin writes the same result shape back. Plan, Goal, and child-job state stays plugin-specific.
- **One spelling per operation** — `/goal` accepts exactly one word per action (`new`, `list`, `enable`, `disable`, `complete`, `delete`, `edit`, `get`, `config`, `reset`, `help`), and the Goal tool uses the same vocabulary. Anything else is forwarded to the model as natural language.
- **Visible progress UI** — a Nerd Font panel with a task tree, a solid-line DAG, and scrollable detail views. Live thinking/tool/output activity is rendered without entering model context or persisted workflow state.
- **Session-scoped persistence** — Todo, Goal, budget, and job snapshots follow the active Pi branch. Restoring pauses automatic work and never revives child processes.
- **Independent modules** — five selectable Pi resources (`todos`, `plan`, `agents`, `goal`, `ui`) chosen with `pi config`. Loaded entries share one runtime coordinator; there is no required core module and no plugin `modules` setting.
- **Configuration and profiles** — an optional config file for continuation limits and interface language, plus named subagent profiles that can inherit the main-session model or name a registered model and tool set.
- **Bilingual interface text** — English and Simplified Chinese labels, help, notifications, and workflow messages. The `language` setting accepts `auto`, `en`, or `zh-CN`, where `auto` follows the terminal locale. User-authored content, command names, and structured tool fields stay unchanged.
- **Complete child reports** — reports, output, questions, and answers are preserved without character caps. Prompt guidance encourages task-appropriate detail, and the communication reference documents when each message enters model context.
- **Report handoff state** — a finished child remains Pending delivery until its terminal report or a full `subagent_wait` result reaches the main conversation.

### Fixed

- Rendered Todo rows as aligned blocks with their tree identifiers attached, keeping ordering and column alignment stable.
- Added slash-command argument completion and recent-work preview selection. Selected tasks render in creation order, oldest first, across status changes and dependency merges.
- Consuming a job through `subagent_wait` prevents its current notices from being repeated as an automatic completion report.
- Resolve child-process entry points from the running Pi host, so the distribution does not need a bundled development copy of Pi.
- Keep explicit `/goal edit` user-authorized after automatic work, without refilling the allowance, and display saved Goal reasons in the selected language.
- Refined subagent status icons, including starting, failed, interrupted, and cancelled states.
- Routed the solid-line DAG with scrolling and an explicit predecessor-list fallback for dense graphs, so a clipped widget is never shown as a complete graph.
