# Agent communication

This reference distinguishes execution, report delivery, and model consumption. A child finishing does not mean its report has reached the next main-model request, and receiving a report does not complete its Todo.

## When the main model sees information

| Route | What reaches the main model | Timing |
|---|---|---|
| Child `subagent_send` | Report or question, with the originating job and optional `requestId` | Buffered for the next safe main-session boundary; an idle session can be woken |
| Child completion | Completion report and retained child output | Same automatic report channel |
| Parent `subagent_spawn` | Job ID and startup state, with linked Todo ID/current status when bound | Ordinary result of the current tool call |
| Todo completion | Newly ready task hints appended to the same Todo tool result | Following request; no duplicate UI notification |
| Workflow checkpoint | Key task/Job state after compaction, restore, or command changes | Passive append before a normal request or safe boundary; no independent wake |
| Parent `subagent_inspect` | Job execution summaries, linked `todoStatus`, and profiles, not full output | Ordinary result of the current tool call |
| Parent `subagent_wait` | Full retained output, execution status, linked `todoStatus`, usage, and pending questions | Ordinary result of the current tool call |
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

Parent `subagent_send({ recipient, message })` submits direction with `streamingBehavior: "steer"`. Pi consumes it at its next safe steering boundary. It does not kill or interrupt a tool already executing. The parent tool's successful confirmation means the message was sent, not that the child has followed it yet.

## Goal, pause, and restore

Automatic report wakes and Goal continuations share the active Goal's allowance. Plan mode, a paused Goal, paused Agent delivery, or exhausted allowance prevent automatic wakes.

A model error temporarily holds queued reports without discarding them or starting a competing idle wake. Once native Pi or Goal recovery produces a successful turn, the report channel reopens and delivers the retained batch. If retries are exhausted, or the user explicitly pauses/aborts, normal pause suppression applies.

Reports suppressed while paused are not replayed on resume. Their full output remains in Job records and can be retrieved with `subagent_wait`; pending delivery stays visible until a real handoff. `/agents resume` permits future arrivals rather than replaying old messages. Restoring a session never revives child processes or starts an automatic report loop.

Notices are coalesced by job and notice kind or question ID. Completed output replaces a same-batch interim notice because it already contains that report; failure diagnostics retain interim reports. Already-answered questions are filtered at delivery. At most 32 notices are retained, with questions preferred. These are count limits, not character limits.

## Size and context

Reports, retained output, questions, and answers have no plugin-imposed character cap. RPC record parsing, completion reports, and output restoration preserve the full text. Terminal controls and bidi controls are still sanitized before automatic display/delivery.

Children are prompted to give task-appropriate conclusions, changes, verification, and risks, avoiding routine play-by-play and duplicate final reports. Removing caps does not create unlimited model context: long results still grow memory, session storage, and the next request's context. Model context windows and Pi's own result handling still apply.

Agent-state `appendEntry` snapshots are session data, not model messages. Live thinking/tool/output activity is UI-only and never enters model context. Tool duration keeps refreshing beyond 99 seconds; finishing a tool or shutting down the session stops its clock timer.

See [workflow checkpoints](CHECKPOINTS.md) for append timing, memory filters, immutable request prefixes, and budget confirmation after compaction. A per-Goal user pause policy blocks model stop requests only; it never disables safe report suppression after a real user stop or budget pause.
