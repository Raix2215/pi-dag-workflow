# Agent communication

Reference for child jobs, report delivery, task acceptance, and continuation. For installation and examples, see the [README](../README.md#subagents).

## Assignment and configuration

`subagent_spawn` starts one child Pi process. The assignment should include the objective, input paths, scope, and expected verification evidence. A linked `todoId` must be ready.

Omitting `profile`, or selecting `inherit`, captures the parent's model, thinking level, and active supported built-in tools at dispatch time. A named profile overrides its declared fields; call-level `tools` replaces the list. Implicit thinking can adapt down to a supported level. An explicitly unsupported profile level fails.

A child works in the same directory, discovers workspace rules, and has independent conversation history. Selected profile instructions and `context: true` fragment guidance arrive as task context. The fragment brief prioritizes current instructions and valid prerequisite report heads from the same fragment instance. It is bounded, and a full report remains available through inspection.

The child has `subagent_send` for parent communication. It cannot delegate children, and it does not run the parent's Goal. Its model auto-retry is disabled.

## Information routes

| Route | Model-facing content | Timing |
|---|---|---|
| Child `subagent_send` | Report or question with job ID and optional request ID | Next safe parent boundary; an idle parent can be woken |
| Child success | Finalized retained output and completion report | Automatic report channel |
| Child failure | Bounded diagnostic and recovery guidance | Automatic report channel; full output is retained |
| Parent `subagent_spawn` | New job ID, startup status, linked Todo status, and optional continuation origin | Current tool result |
| Parent `subagent_inspect` | Short job status/activity/questions or explicit profile query | Immediate tool result |
| Parent `subagent_inspect`, `output: true` | Retained output, questions, usage, observation, and linked Todo status | Snapshot or bounded wait result |
| Parent `subagent_send` | Delivery confirmation | Current tool result; subsequent child replies use the report channel |
| Parent `subagent_cancel` | Stop/removal confirmation | Current tool result |
| `/agents wait` | User-visible output | UI notification |

A tool result is available to the following model request. Reports enter at `turn_end` or `agent_before_settle`, after the current tool batch; an idle report wake uses a follow-up message. Reports do not interrupt a tool batch already in progress.

## Queries and delivery

`subagent_inspect` without `output` returns short status. With `output: true`, it requires one `jobId` and accepts:

| Parameter | Behavior |
|---|---|
| `timeout: 0` | Immediate output snapshot |
| `until: "update"` | New report, question, or end; default timeout 5 seconds |
| `until: "finish"` | Terminal execution or a question; default timeout 30 seconds |
| `after` | Wait beyond a known `reportVersion` |
| `timeout` | Explicit wait duration, up to 300 seconds |

A wait timeout or abort only stops that wait. The background child remains active until it ends, reaches its job deadline, or is explicitly cancelled. Queries for profiles cannot collect output.

Successful and failed terminal jobs use `reportDelivery`:

- `pending`: the terminal report has not been handed to a parent model request.
- `delivered`: a real request's context hook received the automatic report, or an output query returned it to the model.

A proposed boundary entry is not delivery confirmation. If another extension discards it, the report can be proposed again within bounded attempts. A persisted report filtered from model context is not replayed automatically; query its output explicitly.

Output collection acknowledges the returned terminal report and removes matching buffered notices. Version-aware acknowledgement preserves newer reports. Ordinary status queries and `/agents wait` leave delivery status unchanged.

## Task acceptance and display

| Current state | Linked task row |
|---|---|
| Successful job, report pending, Todo unfinished | Pending delivery |
| Successful job, report delivered, Todo unfinished | Pending verification |
| Accepted Todo | Completed |
| Latest failed/interrupted attempt still current | Failure/interruption state |
| Explicitly dismissed attempt, Todo unfinished | Main session / Ready to resume |
| Main-session takeover | Canonical Todo owner and state |
| New active attempt | New job/profile and live activity |

Delivery is not acceptance. The main session verifies files, tests, and other evidence before marking a Todo completed. A job may report on an accepted step while continuing a serial assignment; the Todo owns its accepted state, while `/agents` still shows the actual job status.

All task filters use the latest attempt. A stale latest attempt retires its outcome rather than reviving an older verdict. Native Todo terminal states take precedence. Default Standalone display hides dismissed attempts and delivered successful jobs; explicit outcome filters can show their history.

## Direction and questions

Child `subagent_send({ message, question: true })` waits for an answer. The parent uses `subagent_send({ requestId, message })` to answer that input request.

Parent direction uses `subagent_send({ recipient, message })`. Normal direction enters at a safe steering boundary. `interrupt: true` clears obsolete queued work, aborts the current local turn, cleans the idle queue, and sends a new direction in the same child context. Confirmation is `accepted`, `queued`, or `answered`; inspect evidence to determine whether work followed the direction.

Changing the task definition or fragment identity invalidates earlier acceptance evidence. Interrupting the child starts a new report scope. Old output remains queryable, with `outputStart` separating historical text from the current assignment. Late reports from an old tool batch remain historical until the new direction is consumed.

## Failure, cancellation, and continuation

A model error, unexpected process exit, invalid RPC record, startup failure, or job deadline closes the attempt and releases its process slot. Failure results include a bounded, sanitized root-cause summary, classification, and recovery guidance. Finalized partial text and diagnostic output remain available. A streaming fragment that never finalized before a crash may not be retained.

The default execution deadline is 600 seconds; spawn `timeout` can set up to 86,400 seconds. Model retry stays under parent control: resolve the cause, verify partial artifacts and external side effects, then continue explicitly.

`resumeFrom` creates a new attempt:

- Keep the original Todo binding and saved assignment.
- Supply the current continuation task; select another known profile when needed.
- Keep the previous tool scope unless call-level `tools` explicitly overrides it.
- Reject changed Todo definitions; use a fresh self-contained assignment for the current scope.
- Supply full instructions when the retained record has no saved original assignment.
- Retain the old execution record and report history.

Cancellation dismisses unsuccessful or interrupted attempts from the current panel. It does not change Todo acceptance or reverse project edits. An already successful job with an undelivered report keeps that report; `remove: true` explicitly discards the record.

A parent abort during authentication/startup cancels dispatch and leaves its Todo unclaimed. After dispatch succeeds, parent waiting or ordinary-turn cancellation does not stop stable background work. A cancelled mutating direction with an unknown outcome stops the child; a failed composite redirect closes the attempt. Already-triggered external actions may still finish, so check their authoritative state before repeating work.

## Goal and recovery context

Automatic child-report wakes and Goal continuations share the active Goal's allowance. Plan, Goal pause, Agent-delivery pause, or an exhausted finite allowance suppresses automatic wakes. Model failures hold buffered reports while native Pi or bounded Goal recovery runs. Successful recovery reopens delivery.

`/agents resume` permits future report arrivals. Retrieve previously suppressed reports explicitly. Restoring or switching a session stops managed child processes and restores their records as interrupted; it does not revive execution or automatically resume the Goal.

Workflow checkpoints carry bounded Todo/Job summaries. Goal checkpoints retain original requirements and execution policy. Normal changes append at safe boundaries; a current active Goal contract missing after ordinary context transforms is appended through Pi's public final-context event. System messages, prior messages, reports, and memory-owned summaries remain intact. A later owner of that final event can still transform its result.

Short continuation messages refer to the current Goal contract. They do not authorize a smaller objective or additional permissions. Only important new evidence or a changed execution decision calls for `goal update`.

## Retained data and cleanup

Todo cleanup and job pruning preserve active processes, undelivered reports, successful work awaiting acceptance, and required dependencies. Explicit record removal is available separately. IDs retain their high-water marks across cleanup and restore.

Job state is saved as branch-local metadata and output deltas. Original assignments are retained for continuation. State records are not model-context messages. Live thinking/tool/output activity updates only the UI.

Reports and full output can be long; they consume context and session storage when queried or delivered. Display removes terminal control characters. Diagnostic summaries redact common credential forms, but arbitrary child report text still needs review before sharing. Child credentials and process environment are not an operating-system isolation boundary.
