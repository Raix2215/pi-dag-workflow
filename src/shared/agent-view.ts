export interface AgentView {
  id: string; todoId?: number; profile: string;
  model?: { provider: string; id: string };
  status: "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  /** Execution completion and report handoff are separate stages. */
  reportDelivery?: 'pending' | 'delivered';
  /** Terminal, but this attempt left nothing readable; it is not waiting to be delivered. */
  reportEmpty?: true;
  taskReportStale?: boolean;
  /** Set by an explicit cancel: the attempt is retired, so the main session owns the Todo again. */
  dismissed?: boolean;
  /** One-line spawn task excerpt, shown for jobs that no Todo row can carry. */
  label?: string;
  /** Live activity from the child's real event stream; display-only, never persisted. */
  activity?: { kind: "thinking" | "tool" | "output"; tool?: string; since?: number };
}

export interface ProfileView { name: string; model?: { provider: string; id: string }; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; tools?: string[]; skills?: string[]; instructions?: string }
