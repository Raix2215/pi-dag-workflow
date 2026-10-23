import { Type, type Static } from "typebox";

const Reference = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: '^@[A-Za-z][A-Za-z0-9_-]{0,31}$' })]);
const BatchOperationSchema = Type.Object({
  action: Type.Enum(['create', 'update'] as const, { type: 'string' }),
  ref: Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' })),
  id: Type.Optional(Reference),
  subject: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()), owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  status: Type.Optional(Type.Literal('pending')),
  blockedBy: Type.Optional(Type.Array(Reference)),
  addBlockedBy: Type.Optional(Type.Array(Reference)), removeBlockedBy: Type.Optional(Type.Array(Reference)),
}, { additionalProperties: false });
export type TodoBatchOperation = Static<typeof BatchOperationSchema>;
export const TodoParamsSchema = Type.Object({
  action: Type.Enum(['create', 'update', 'list', 'get', 'status', 'delete', 'clear', 'apply', 'reset', 'batch', 'presets'] as const, { type: 'string' }),
  operations: Type.Optional(Type.Array(BatchOperationSchema, { minItems: 1, maxItems: 50, description: "batch only: 1–50 pending creates or definition updates. A create may name ref; @ref in ids/dependencies refers only to earlier creates in this batch. Any failure rolls back the entire call." })),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Required for update/get/delete" })),
  subject: Type.Optional(Type.String({ description: "Short title; required for create" })),
  description: Type.Optional(Type.String({ description: 'Task requirements and necessary context; not a status log. Usually omit on status-only updates.' })),
  activeForm: Type.Optional(Type.String({ description: "Current activity label" })),
  status: Type.Optional(Type.Enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'deleted'] as const, { type: 'string', description: 'Create: pending or in_progress; update after verification; list filters status' })),
  scope: Type.Optional(Type.Enum(['all', 'completed', 'closed'] as const, { type: 'string', description: 'clear only: all (default), completed, or closed (completed/failed/cancelled/deleted); protected records remain' })),
  blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Initial prerequisite ids, create only" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Update: add prerequisites" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Update: remove prerequisites" })),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  includeDeleted: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "list only: page size, default 50, maximum 200." })),
  afterId: Type.Optional(Type.Integer({ minimum: 0, description: "list only: exclusive id cursor. Use returned continuation arguments to preserve filters." })),
  ready: Type.Optional(Type.Boolean({ description: "list only: pending tasks whose prerequisites are all completed." })),
  preset: Type.Optional(Type.String({ description: "Fragment name: apply/reset target, or the fragment to describe in full for action presets" })),
  vars: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "apply: values for {placeholders} in the fragment" })),
  run: Type.Optional(Type.Integer({ minimum: 1, description: "reset: instance run, default the newest" })),
  step: Type.Optional(Type.String({ description: "reset: reopen this step and every task that depends on it" })),
}, { additionalProperties: false });
export type TodoParams = Static<typeof TodoParamsSchema>;
