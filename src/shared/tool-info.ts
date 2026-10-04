/** Optional Pi 0.99 tool metadata; names/exposure stay direct and unchanged. */
export const workflowNamespace = {
  name: 'pi_dag_workflow',
  description: 'Session-local tasks, goals and child agents',
  instructions: 'Track dependencies, verify work before completing it, and respect Plan. Child results do not complete tasks; Goal continuation follows user allowance controls.',
};
export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const sessionMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
