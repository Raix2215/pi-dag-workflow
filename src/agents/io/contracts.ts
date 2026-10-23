export const CORE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const CHILD_TOOLS = [...CORE_TOOLS, 'bash', 'edit', 'write', 'powershell'] as const;
export const CHILD_TOOLS_ENV = 'PI_DAG_AGENT_TOOLS';
export const CHILD_CONTROL_ENV = 'PI_DAG_AGENT_CONTROL';
export const CHILD_CONTROL_PREFIX = 'pi-dag-child-control:';
export const CHILD_CONTROL_REPLY = 'pi-dag-child-tools:';

/** Private RPC pipe markers, not a network endpoint. Loaded explicitly in children only. */
export const CHILD_NOTICE_PREFIX = "pi-dag-child-message:";
export const CHILD_QUESTION_PREFIX = "pi-dag-child-question:";
/** Passive carrier for the selected profile/fragment guidance; never a system prompt section. */
export const CHILD_GUIDANCE_TYPE = "pi-dag-child.assignment-guidance";

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelRef { provider: string; id: string }
export interface Profile { name: string; model?: ModelRef; thinking?: ThinkingLevel; tools?: string[]; skills?: string[]; instructions?: string; childExtensions?: string[]; /** opt-in launch isolation; execution semantics are unchanged. */ isolate?: boolean }
export interface ResolvedProfile { name: string; model: ModelRef; thinking: ThinkingLevel; tools: string[]; skills?: string[]; instructions?: string; childExtensions?: string[]; ignoredInheritedTools?: string[] }
export type JobStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export interface JobSummary {
  id: string; todoId?: number; profile: string; model: ModelRef; thinking: ThinkingLevel;
  tools: string[]; skills?: string[]; ignoredInheritedTools?: string[]; status: JobStatus; startedAt: number; endedAt?: number; error?: string; pendingRequests: number;
  /** Display-only one-line excerpt of the spawn task; never used for control flow. */
  label?: string;
  /** Terminal jobs stay "pending" until their report is delivered into the parent context. */
  reportDelivery?: "pending" | "delivered";
  /** Terminal, but this attempt produced nothing readable: delivered does not mean it was read. */
  reportEmpty?: true;
  /** The bound task was reopened; retained output belongs to a previous attempt. */
  taskReportStale?: boolean;
  /** UTF-16 offset of current-assignment output; preceding text remains queryable history. */
  outputStart?: number;
  /** Explicitly acknowledged stop; history remains, but no longer owns the current row. */
  dismissed?: boolean;
  resumeFrom?: string;
  failure?: AgentFailure;
}
export interface AgentRequest { requestId: string; message: string }
export interface AgentUsage { requests: number; input: number; output: number; estimatedCost: number }
export interface JobObservation { phase: 'starting' | 'thinking' | 'tool' | 'output' | 'waiting' | 'settling' | 'running' | 'redirecting' | 'closed'; elapsedMs: number; lastEventAt: number; deadlineAt?: number; reportVersion: number; hasOutput: boolean; pendingMessages: number; activity?: JobActivity; activeTools: { tool: string; since: number }[]; questions: AgentRequest[] }
export interface JobInspection extends JobSummary, JobObservation {}
export interface JobResult extends JobSummary { profileInstructions?: string; assignment?: string; taskDefinition?: string; output: string; requests: AgentRequest[]; usage?: AgentUsage; timedOut?: boolean; reportVersion?: number; reason?: 'snapshot' | 'update' | 'question' | 'finished' | 'timeout'; observation?: JobObservation }
export interface AgentNotice { jobId: string; kind: "message" | "question" | "completed" | "failed"; message: string; requestId?: string; version?: number }
export interface AgentFailure {
  kind: 'quota' | 'auth' | 'network' | 'timeout' | 'process' | 'unknown';
  reason: string;
  retryable: boolean | null;
  recovery: string;
}
export interface JobActivity { kind: "thinking" | "tool" | "output"; tool?: string; since?: number }
export interface RpcRecord { type: string; id?: string; success?: boolean; error?: string; [key: string]: unknown }
