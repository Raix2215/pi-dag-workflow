# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-10-06

### Fixed

- **Default child configuration now inherits consistently.** Omitting `profile` and selecting `inherit` both capture the parent's current model, thinking level and active supported built-in tools. Named profiles override declared fields, and a call's `tools` takes precedence. Inherited thinking adapts down to the selected child's capabilities; explicitly configured unsupported levels still fail. Extensions, skills and full parent history are not copied.
- **Startup cancellation releases its resources.** Parent aborts during authentication or startup stop dispatch without claiming the Todo. Explicit cancellation and the job deadline also release a stalled authentication wait. Abortable RPC commands clean up listeners and timers; already-dispatched background jobs survive a parent wait/ordinary-turn abort.
- **Interrupted directions cannot leave half-redirected jobs.** Clear old queued work before aborting, then clear again at the idle boundary. Cancellation after a mutating direction RPC stops unknown work; a failed composite redirect closes as failed. Explicit cancellation still completes cleanup and does not roll back files or guarantee external actions stopped.
- **Old reports cannot verify a changed assignment.** Interrupting or changing task definitions, including fragment identity, invalidates the prior report count. Late reports from an old tool batch stay historical until the new direction is consumed. Current output offsets preserve all earlier text while excluding it from new fragment evidence, and are validated on restoration.
- **Fragment briefs preserve real state and relevant evidence.** Failed/cancelled states stay distinct; forward and transitive prerequisites in the same fragment instance contribute valid report heads. Stale, failed and interrupted attempts never fall back to an older report. Bounded Unicode-safe briefs prioritize the current instructions and direct prerequisites over long titles and lower-priority history.

### Changed

- Parent and child guidance explicitly describe configuration inheritance, independent histories, self-contained assignments and current-scope verification. `inherit` remains the GUI/inspection label for the built-in selection.
- English and Chinese profile documentation and the communication reference describe overrides, startup cancellation, historical evidence and unchanged single-tier execution limits.

### Tests

- Add real offline Pi regressions for high-thinking inheritance, inherited editing tools, profile overrides, aborted startup with an unclaimed Todo, queued scope changes, fresh-report acceptance and retained-output offsets. Cover authentication deadlines, failed interruption commands, delayed historical reports, metadata changes, forward dependencies and tight Unicode-safe brief budgets.

## [0.3.0] - 2026-10-04

### Added

- Per-Goal `/goal nolimit` switches the continuation-turn cap without starting/pausing work or resetting usage. Finite limits remain saved; shared child-report wakes obey the same setting.
- List/DAG filters `full`, `pending`, `completed`, `failed`, `cancelled`; full windows do not truncate rows. DAG views reuse the Standalone section, with external prerequisite references preserved under filtering.
- Todo `failed`/`cancelled` attempt states and scoped cleanup `completed`/`closed`/`all`. Cleanup includes failed records while protecting active work, pending evidence and dependency anchors, and preserves Task/Job ID high-water marks.
- Child inspection exposes activity/tools, elapsed time, pending questions, queued directions and reportVersion. Full profile instructions are opt-in. `subagent_send interrupt:true` redirects the same child after aborting the local turn and clearing obsolete queues/questions; accepted/queued/answered delivery is reported explicitly.
- `/goal nopause [ #id]` opens a user-only menu that toggles, while a Goal runs, whether the model may interrupt it. The per-Goal `modelPause` choice defaults to allow; blocking rejects model disable/delete and blank nextStep, while verified completion, user commands, and safety pauses remain available. The menu neither starts nor pauses work nor resets its allowance.
- Child inspect/wait results include the current linked `todoStatus`, derived at query time without changing retained Job state.
- Append-only Goal checkpoints preserve the full original requirements and execution policy after compaction or policy changes. `goalNoPauseTools` configures disabled main-session tools in autonomous mode (default `ask_user_question`), with execution guards covering nested calls.

### Changed

- `subagent_wait` defaults to the next report/question/end for up to 5 seconds; `until:finish` retains a 30-second default. Immediate snapshots, report-version waits and explicit return reasons avoid long main-session stalls and stale-report polling.
- Default inspection omits full Profile instructions; selected Job queries omit profiles entirely. UI/menus do not introduce model-context messages.
- Linked task rows now distinguish pending delivery, pending verification, and accepted completion. A completed Todo shows completed even though its Job stays execution-completed; standalone delivery semantics remain unchanged.
- Newly ready task hints stay in the Todo tool result; remove the separate UI notification so users do not see the same dependency change twice.
- An enabled Goal reviews and continues the same objective when the model ends a round without `nextStep` or completes its current Todo list. Only explicit completion/disable and existing safety limits stop it; completed Todos do not imply an achieved Goal.
- Child questions take priority while preserving a saved independent next step. Substituting a concrete action for the initial Goal placeholder consumes the correct step after actual delivery.
- Goal guidance prioritizes concrete implementation, experiments, and verification, with brief progress notes and documentation only when required. Model `nextStep` suggestions cannot narrow the original objective or withdraw existing permission.
- Regular Goal mode defaults to eight no-progress rounds, then one replan attempt before pausing; the configuration range is 1–100. Empty `nextStep` clears the note instead of waiting for the user. `nopause` forbids user questions and model handoffs, and replans without a no-progress pause while respecting user stops and finite budget/error protections.

### Fixed

- Todo row ownership follows explicit main-session takeover after a child expires or fails. Historical output remains queryable, while list/DAG rows use the current task owner and state; a wait timeout alone never transfers a still-running child.
- Intentional child interruption no longer races an old settled event into a failed Job; clearing retained history never stops live processes. Older report reads cannot discard newer versioned notices.
- Filtered graph labels cannot overwrite borders when hidden-prerequisite references are long. User cleanup menus do not pause or refill an active Goal, and deleted tombstones do not pin completed history.
- Retain continuation intent when slow compaction-completion handlers keep Pi busy beyond the first idle check; retry admission until the host becomes idle without spending extra wakes.
- Successful shell work counts as activity, preventing real tests, calculations, and edits from being misclassified as no-progress rounds.
- A model error retired by a successful compaction no longer blocks Goal continuation. Recovery boundaries are honored in both directions: an error recorded before the compaction no longer suppresses later wakes, while an error after it still earns its bounded retry.
- Real `subagent_wait` timeouts no longer count as stalled work while the exact waited child still runs. The exemption is local to that round and never bypasses the shared allowance, user pauses, or no-progress checks on actual execution.

### Tests

- Cover infinite/finite menu transitions, filtered preview/full views, failed/cancelled dependencies, scoped cleanup/protected evidence, counter restoration, light/full profiles, and native Pi interruption of long tools and pending questions while preserving context.
- Cover task-acceptance display across list/DAG/locales/themes/widths and real inspect/wait status projection; test the policy menu on an active Goal, cancellation, per-Goal persistence, stale sessions, model mutation rejection, and preserved user/safety controls.
- Add generic compaction-tail race tests, autonomous question-tool and nested-call guards, tool restoration order, regular replanning, and original-objective/documentation guidance checks.
- Add generic reproductions of a final answer after all Todos finish without a next step, objective continuation through real Pi in both locales, question priority and placeholder consumption, and repeated child-wait timeouts. Private project histories and task contents are not copied into public fixtures.
- Cover repeated native context-overflow recovery inside one continuous Goal, retired pre-compaction failures, append-only state folding (versions, offsets, corruption, pruning and ID high-water marks), and the long-conversation hot paths below.
- Verify all 32 module combinations, reverse order and project filtering; test single lifecycle reads, bounded render caches, mutable theme colors, live timer restarts, and timed-out child takeover. Node 22, Node 24 and Pi 1.0.2 pass 445 tests; unchanged rendering matches the pre-optimization renderer across 11,150 cases.

### Performance

- **Child state is appended, not rewritten.** Persisted Job state now records only the jobs that changed and the appended output tail, while still writing immediately and keeping every report complete. A 128-job stress case with 64 KiB outputs drops from an ~8.4 MB rewrite per change to a few hundred bytes, and a six-child session's state log shrinks from roughly 371 KB to 39 KB with identical restored output. Version-1 snapshots remain readable, and a full snapshot supersedes earlier data.
- **Todo rendering reuses geometry.** Theme-independent row plans, cleaned static labels, header counts, and preview windows are cached with bounded variants and snapshot counts. In a 4096-task hot-cache benchmark, full list rendering fell from 53.5 ms to 0.70 ms, graph fallback from 53.8 ms to 1.13 ms, and list previews from 0.148 ms to 0.021 ms. Colors, live elapsed time, chronological order and alignment stay current.
- **Loaded modules share restoration.** Register modules are imported only for selected features. A session lifecycle shares one branch read, one Todo restoration, one preset read when Todos is enabled, and one configuration read for Plan/Goal; unchanged display state avoids redundant widget registration. A 30,000-entry/4096-task restore benchmark fell from 30.3 ms to 8.7 ms. Pi/Node cold startup remains outside this optimization's claimed gains.
- **Hot paths stop repeating work.** Empty-output checks, unchanged task-status serialization, goal-definition comparisons, and the failure lookup are cached or skipped instead of re-scanning: inspection of 128 long-output jobs fell from 2.19 ms to 0.29 ms, an ordinary input with 30,000 history entries from 0.103 ms to 0.0003 ms, and a 4096-task continuation reservation from 0.170 ms to 0.001 ms. Rendering, menus, tool results, and prompts are unchanged.

## [0.2.1] - 2026-10-03

### Added

- **Passive state checkpoints** — compaction, reload, branch navigation, and command edits append a short immutable summary of at most 12 unfinished Todos and 8 active Jobs. Checkpoints do not wake the model, replay full reports, change prior messages, or own memory-plugin summaries. Ordinary tool updates use their existing results instead of adding snapshots.
- **Runtime verification hints** — newly unblocked tasks reach the model in the Todo result; terminal reports name current task status; Goal steps prefer verification of a returned child. Fragment resets keep old output queryable while marking it historical for reopened tasks.

### Fixed

- **Goal continuation survives compaction and rejected drafts** — wake reservations are confirmed by an actual turn and refunded when discarded; `nextStep` is consumed only when its continuation is visible. Boundary handlers preserve one another's entries and share one reservation. Native Pi recovery takes priority over fallback wakes, and failed/cancelled compaction still pauses.
- **Direct enable and idle continuation work** — `/goal enable #id` starts an active idle Goal with its remaining allowance, while running/already-proposed requests are deduplicated. A settled active Goal gets a fallback decision: advance a concrete step, wait for real children, retry an error, or visibly pause rather than silently staying enabled. Explicit intervention clears stale draft-rejection counters.
- **Report drafts are not premature deliveries** — acknowledgement waits for an actual request's context or an explicit wait result. Discarded drafts remain available for bounded delivery, memory filters are respected, and failed batches cannot block reports from future children.
- **Create accepts safe initial status** — `todo create` now accepts `pending` (the default) and `in_progress`, matching the common request shape models emit. Starting still requires completed prerequisites and Plan off; initial `completed`/`deleted` remain rejected, with clear guidance to verify then update.
- **Long-running tools keep real time** — remove both the 99-second display cap and refresh cutoff; seconds/minutes/hours remain width-safe, and completion/shutdown clear refresh timers.

### Verification

- Add native threshold/overflow tests with no compression extension, rejected-draft/compaction recovery, explicit active-idle enable, passive checkpoints, memory summary projections and filters, stable request prefixes, stale-report invalidation, and long-running timer tests.
- Verify two-phase real-model continuation both alone and with memory/cache extensions.

## [0.2.0] - 2026-10-03

### Fixed

- **Goal retries respect intervention** — pending retries are tied to the failed request and Goal, canceled on user input, stops, resets, and session navigation, and cannot inherit scope-changing authority from an earlier user turn. A newer settled failure replaces stale delayed work. Goal reset also stops automatic child-report wakes.
- **Recovery does not strand child reports** — a model error holds queued reports until the successful recovery turn rather than permanently pausing or discarding them; reports do not race an independent idle wake against model recovery. Explicit stops, aborts, and exhausted retries still suppress automatic work.
- **Fragment resets preserve the DAG** — whole-run and single-step resets reopen all live downstream tasks, including external successors, keep deleted rows deleted, validate topology before saving, and reject any closure claimed by an active child.
- **Completion cannot carry an unannounced edit** — completing a reported child's bound task while it runs accepts a status-only update; extra content or dependency changes still go through the edit guard.
- **Plan tool and command behavior agree** — status-filtered Todo queries remain read-only, and applying or resetting a fragment is allowed while implementation, shell commands, dispatch, and task starts/completions remain blocked.
- **Fragment definitions and context are reliable** — forward references in acyclic definitions resolve correctly, placeholder values must be explicitly supplied own string properties, malformed run metadata cannot poison counters, and redispatched prerequisites contribute their latest report.
- **Child delivery and recovery are hardened** — same-batch completed output absorbs its interim notice, already-answered questions do not reappear, malformed RPC events fail the child rather than crashing the parent, restored fields are validated before live jobs change, and labels cannot end on a split Unicode character.
- **Display and localization** — user-controlled notifications and Agent tool results strip terminal controls while preserving intended indentation and canonical data. Missing English messages are covered by a source-to-catalog check. Profile save/delete reloads external edits before writing.

### Changed

- **Serial chains bind only ready tasks** — bind the final task when it is already unblocked; otherwise bind the first ready task and advance statuses from verified interim reports. Guidance consistently allows at most one in-progress task per work stream.
- **Linear dependency scans** — fragment reset closures use successor traversal, and completion hints use status indexes instead of repeated full-list searches.
- **Release metadata and documentation** — synchronize manifest/lockfile versions, correct both configuration and fragment-tag examples, and refresh the release checklist.

### Tests

- Add regressions for lifecycle cancellation, reset guards, malformed child events/state, Plan parity, stale fragment reports, explicit variables, terminal display, external profile edits, and English catalog coverage.
- Exercise real Pi retry lifecycle with injected `500 → 503` errors, default five retries, zero retries, success reset, and native-retry coexistence. Add an opt-in real-model two-round continuation check alongside Goal and joint-workflow acceptance.

## [0.1.13] - 2026-10-02

### Fixed

- **Every failed request gets its own retry** — recovery was answered once per agent run, so when the retry turn failed too (a provider answering `500` and then `503`, for example) the second failure was swallowed: no retry, no pause, and the Goal stayed idle until the user typed something. The decision now waits for the run to settle, so Pi's own retry finishes first, and it keys on the failed request itself: each failure earns one retry until `goalErrorRetries` is spent, and the pause follows when it is.

## [0.1.12] - 2026-10-02

### Changed

- **A child that already reported stops blocking its task's completion** — with one child carrying a serial chain, the guard blocked the parent from completing the chain's first task until the child exited, which contradicted advancing statuses from interim reports. An active child no longer blocks a `completed` status once it has sent at least one interim report; reopening, editing, deleting, or clearing still waits for the child to stop, and a silent child still blocks completion.
- **A chain binds to its last task** — the dispatch guidance now says to bind a serial chain to the task it must finish last, so earlier steps stay free to advance.

## [0.1.11] - 2026-10-02

### Added

- **An unblocked hint** — completing a task prints one line naming the tasks that just became startable (`Prerequisites are done, ready to start: #5 …`). It is a hint only: the plugin still never starts, dispatches, or completes anything on its own.

### Changed

- **Multi-step dispatch is documented and guided** — one child may carry a serial chain when its steps share context, and the guidance asks it to send a short interim message as each step finishes so the parent can advance the task statuses from those messages. Dispatching a task whose prerequisites are still running stays out of scope: a child cannot wait on another child.

## [0.1.10] - 2026-10-02

### Added

- **Opt-in brief for a child that continues a task fragment** — `subagent_spawn` takes `context: true`, which attaches the child's step position, the whole fragment with current statuses, and the report heads of the fragment's earlier steps (200 characters each). It is built only from the same fragment instance, rides the child's environment, is read once and deleted there, and never reaches the model through `subagent_inspect`.

### Changed

- **Dispatch guidance separates serial from parallel work** — one child may carry a serial chain when its steps share context, independent branches get separate children, and a task is dispatched only when its prerequisites are completed, because a child cannot wait on another child's task. The `todo` guidance now allows one `in_progress` task per work stream instead of one overall.

## [0.1.9] - 2026-10-02

### Changed

- **Fragment labels show the step position** — `[release#2]` now reads as "step 2 of this fragment run" instead of the run number, so the panel counts 1, 2, 3 down the workflow. From the second run on, the label keeps the run visible as `[release#2·r2]`. Tasks written before this change fall back to their run number rather than to a wrong position.

## [0.1.8] - 2026-10-02

### Added

- **Reusable task fragments (presets)** — `pi-dag-workflow-preset.json` defines workflows that repeat: steps with stable keys, `{placeholder}` variables, pre-assigned owners, and `after` dependencies. `todo action=apply preset=name` adds the whole fragment in one call and starts a new run (`release#2`) instead of reusing ids, so finished runs stay as history. `todo action=reset preset=name [step]` reopens the newest run, or one step plus every task that depends on it, which is the only sanctioned way to turn finished work back into pending work; a task outside the fragment that depends on a reopened step reopens too. Fragment names and descriptions are advertised in the system prompt like skill descriptions, the panel labels each fragment task with `[release#2]` before its owner and status, and an optional `skill` field points at the skill that explains the workflow. Commands: `/todos presets`, `/todos apply name [key=value]`, `/todos reset name [step]`; names and step keys complete on Tab.

## [0.1.7] - 2026-10-02

### Added

- **Profile `instructions`** — a profile can now carry up to 2000 characters of guidance that every child it dispatches receives as its own system prompt section (`dag_profile`, next to the built-in child rules). Use it for how-that-kind-of-work-is-done text such as bridge endpoints, allowed actions, or reporting rules. The text rides the child's environment, is read once and deleted there, never reaches the model through `subagent_inspect`, and survives a profile re-saved with `/agents profile`.

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
