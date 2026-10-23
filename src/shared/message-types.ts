/**
 * Message custom types: `plugin.module.info`, three dot-separated segments, module name taken from
 * the `src/` directory. These are transient conversation messages, so they carry no read-back
 * compatibility; persisted state keys (`pi-dag-workflow.state`, `.goal-checkpoint`, …) stay as they
 * are, because those live in session branches that old sessions must still read.
 */
export const AGENT_REPORT_MESSAGE = 'pi-dag-workflow.agents.report';
export const GOAL_RETRY_MESSAGE = 'pi-dag-workflow.goal.retry';
export const GOAL_CONTINUE_MESSAGE = 'pi-dag-workflow.goal.continue';
export const RETRY_REQUEST_MESSAGE = 'pi-dag-workflow.retry.request';
export const TEAM_MESSAGE = 'pi-dag-workflow.team.message';
export const TEAM_MEMBERSHIP_MESSAGE = 'pi-dag-workflow.team.membership';
