# Agent communication

This reference distinguishes execution, report delivery, and model consumption. A child finishing does not mean its report has reached the next main-model request, and receiving a report does not complete its Todo.

## Dispatch configuration and child context

Omitting `profile` or selecting `inherit` captures the parent's current model, thinking level, and active supported built-in tools. A saved profile overrides only declared fields; a call's `tools` overrides the list. Unsupported inherited thinking adapts down; an explicit unsupported profile level fails. Existing jobs keep their captured configuration. Extensions, skills, the parent's full history and dynamic prompt sections are not copied; workspace rules are discovered independently in the same working directory. Children receive their assignment, child rules, optional profile instructions and optional fragment brief, and do not run the parent's Goal or automatic model retries.

Give a child a self-contained assignment: goal, inputs/paths, constraints and verification evidence. `context: true` is not full context inheritance. It provides a bounded brief for a bound fragment task, preserving real failed/cancelled states, the current step's instructions, and prioritized prerequisite report heads, including forward references. Only the latest valid report in that fragment instance contributes; stale or failed/interrupted evidence is not substituted with an older attempt.

## When the main model sees information

| Route | What reaches the main model | Timing |
|---|---|---|
| Child `subagent_send` | Report or question, with the originating job and optional `requestId` | Buffered for the next safe main-session boundary; an idle session can be woken |
| Child completion | Completion report and retained child output | Same automatic report channel |
| Parent `subagent_spawn` | Job ID and startup state, with linked Todo ID/current status when bound | Ordinary result of the current tool call |
| Todo completion | Newly ready task hints appended to the same Todo tool result | Following request; no duplicate UI notification |
| Workflow checkpoint | Key task/Job state after compaction, restore, or command changes | Passive append before a normal request or safe boundary; no independent wake |
| Goal checkpoint | Full original requirements, running/paused state, and execution policy after compaction or a Goal-policy change | Passive append; automatic wakes also carry the execution rules, without rewriting prior messages |
| Parent `subagent_inspect` | Lifecycle/activity/tools, timings, queued directions, question IDs, reportVersion and todoStatus; brief profiles or opt-in full instructions | Ordinary non-waiting tool result; no full output |
| Parent `subagent_wait` | Full retained output, observation, reportVersion, todoStatus, usage and questions, with snapshot/update/question/finished/timeout reason | timeout:0 immediately; default update waits at most 5s; finish defaults to 30s; questions return early |
| Parent `subagent_send` | Delivery confirmation; the instruction or answer goes to the child | Confirmation is the current tool result; later child replies use the report channel |
| Parent `subagent_cancel` | Cancellation/removal confirmation | Ordinary result of the current tool call |
| `/agents wait` | Nothing is added to model context; the result is shown to the user | UI notification only |

A tool result is recorded for its current tool call and is available to the **following model request**. It is not inserted into a model request already streaming.

## Automatic report boundaries

While the main session is running, reports are proposed at `turn_end`, after the current tool batch finishes. `agent_before_settle` provides the final fallback boundary. The returned session entries request continuation, and the following model request receives them in context. Reports do not interrupt sibling tools in a parallel batch.

When the main session is idle, the runtime briefly coalesces arrivals and sends a `followUp` custom message with `triggerTurn: true`. The report enters context for that newly started model request.

This distinction answers two different timing questions: a report is **written at a safe boundary**, then **read by the next model request**. It is not delivered into an in-flight request.

## Execution versus delivery state

Jobs retain their execution status, such as `running`, `waiting`, `completed`, or `failed`. A separate `reportDelivery` field records terminal report handoff:

- `pending`: execution has finished, but the terminal report has not been handed to the main session. The Todo panel shows **Pending delivery / 待交付** for a completed child.
- `delivered`: the automatic report reached the model-context hook of an actual request, or a real `subagent_wait` tool result carried it back. A proposed boundary draft alone does not acknowledge it. A linked unfinished Todo shows **Pending verification / 待核验**.

The linked task row follows acceptance, independently of Job execution:

| Job / Todo state | Task-row label |
|---|---|
| Job completed, report pending, Todo unfinished | `󰥔 Pending delivery / 待交付` |
| Job completed, report delivered, Todo unfinished | `󰥔 Pending verification / 待核验` |
| Todo completed after acceptance | `󰄬 Completed / 已完成` |
| Reopened task with historical output | Canonical pending/in-progress Todo state |

A completed Todo owns its row even if the child continues a serial chain after an interim report; `/agents` still shows that child's real execution status. Standalone jobs retain execution/delivery semantics and delivered successful jobs leave the standalone panel. No separate acceptance state is written to Job records. Inspect/wait derive `todoStatus` from the current canonical task list.

Delivered means handed to the conversation, not read, accepted, or verified by the model. The Todo still requires explicit acceptance. A report intentionally suppressed by a paused workflow or a missing/deleted linked Todo remains pending until retrieved with the real `subagent_wait` tool.

A discarded report draft is retained for a bounded delivery attempt. Persisted reports omitted by a memory-owned context filter are not forced back into the request; full output remains queryable. Terminal reports include the linked Todo's current status and verification reminder. Fragment resets mark old output historical, including every reopened successor, without deleting it.

A successful `subagent_wait` consumes notices for the same job so its returned content is not immediately repeated as an automatic completion report. `/agents wait` and `subagent_inspect` do not acknowledge report delivery, because neither returns the full report to the model.

## Directions and questions

A child uses `subagent_send({ message, question: true })` to ask a question and wait. The main model receives a `requestId`, then answers using parent `subagent_send({ requestId, message })`. That answer is sent through the child's pending input response; it does not start another child.

Parent `subagent_send({ recipient, message })` submits direction with `streamingBehavior: "steer"`. Pi consumes it at its next safe steering boundary; ordinary direction does not interrupt a running tool. `interrupt: true` marks a composite redirect, clears queued work before aborting the local turn, clears obsolete queue/questions again at the idle boundary, then submits direction in the same child context. Old settled events do not count as failure. Already-triggered external actions may continue, so inspect their real state before overlapping work. Delivery is accepted/queued/answered, not proof the child followed it.

`subagent_wait` defaults to `until: "update"`, returning on a new report, question or end within five seconds. `after` uses reportVersion to wait beyond already observed reports. `until: "finish"` waits for terminal execution (default 30s, cap 300s), but questions still return early. Timeout/abort affects the wait only. Version-aware notice acknowledgement cannot drop a newer report that was not in the returned snapshot.

Changing a task's subject, description, dependencies or fragment identity invalidates prior acceptance evidence. Interrupting a child also starts a new report scope. Old output stays queryable, but old tool-batch reports arriving before the new direction is consumed are labeled historical and cannot unlock Todo completion. New reports can unlock the existing status-only acceptance guard; the parent must still verify their work. `outputStart` is a UTF-16 offset into retained `output`, separating current-assignment text from earlier history; restoration validates it, and fragment briefs use only its current tail.

A parent abort during authentication/startup cancels dispatch, stops any child process and leaves the Todo unclaimed. Cancellation after successful dispatch does not retroactively stop the background job. Sending direction honors cancellation: a canceled observation leaves the job alone, while a canceled mutating RPC whose outcome is unknown stops the child. A failed composite interruption closes as failed rather than leaving a half-redirected job. Explicit cancel always completes process cleanup, even if its caller is interrupted. These controls do not roll back files or prove that already-triggered external actions have stopped.

## Goal, pause, and restore

Automatic report wakes and Goal continuations share the active Goal's allowance. User nolimit removes its turn cap without resetting used counts; other safety stops remain. Plan mode, a paused Goal, paused Agent delivery, or an exhausted finite allowance prevent automatic wakes.

A model error temporarily holds queued reports without discarding them or starting a competing idle wake. Once native Pi or Goal recovery produces a successful turn, the report channel reopens and delivers the retained batch. If retries are exhausted, or the user explicitly pauses/aborts, normal pause suppression applies.

Reports suppressed while paused are not replayed on resume. Their full output remains in Job records and can be retrieved with `subagent_wait`; pending delivery stays visible until a real handoff. `/agents resume` permits future arrivals rather than replaying old messages. Restoring a session never revives child processes or starts an automatic report loop.

Notices are coalesced by job and notice kind or question ID. Completed output replaces a same-batch interim notice because it already contains that report; failure diagnostics retain interim reports. Already-answered questions are filtered at delivery. At most 32 notices are retained, with questions preferred. These are count limits, not character limits.

## Retained-record cleanup

Todo clear scope completed/closed/all also prunes eligible child history. Active bindings, pending delivery and successful reports awaiting Todo acceptance remain. Dependency anchors remain, and retryable failed tasks still keep their prerequisites. IDs keep their high-water marks across cleanup/reload. This only changes current records; it never stops a process, edits project files, or rewrites earlier conversation entries.

## Size and context

Reports, retained output, questions, and answers have no plugin-imposed character cap. RPC record parsing, completion reports, and output restoration preserve the full text. Terminal controls and bidi controls are still sanitized before automatic display/delivery.

Children are prompted to give task-appropriate conclusions, changes, verification, and risks, avoiding routine play-by-play and duplicate final reports. Removing caps does not create unlimited model context: long results still grow memory, session storage, and the next request's context. Model context windows and Pi's own result handling still apply.

Agent-state `appendEntry` snapshots are session data, not model messages. Live thinking/tool/output activity is UI-only and never enters model context. Tool duration keeps refreshing beyond 99 seconds; finishing a tool or shutting down the session stops its clock timer.

Workflow and Goal checkpoints append at safe boundaries without changing memory-owned summaries or earlier messages. A per-Goal `nopause` policy rejects model stopping and disables configured question tools; child questions are answered autonomously by the parent. No-progress rounds trigger replanning in this mode. Real user stops, finite budgets, Plan, and runtime/compaction failures retain their safety controls and report suppression.
