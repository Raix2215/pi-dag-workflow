export const TODO_FILTERS = ['full', 'pending', 'completed', 'failed', 'cancelled'] as const;
export type TodoFilter = typeof TODO_FILTERS[number];
export type ClearScope = 'all' | 'completed' | 'closed';
export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "deleted";
export interface Todo {
  id: number;
  subject: string;
  status: TodoStatus;
  blockedBy: number[];
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}
export interface WorkflowState {
  version: 1;
  tasks: Todo[];
  nextId: number;
  plan: boolean;
  planTools: string[];
  visible: boolean;
  view: "list" | "dag";
  treeStyle?: "paths" | "flat";
  filter?: TodoFilter;
}
