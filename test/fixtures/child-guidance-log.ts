import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Explicit offline fixture. Never loaded by production parents or children. */
export default function childGuidanceLog(pi: ExtensionAPI): void {
  pi.registerFlag('dag-test-child-guidance-log', { type: 'string', description: 'Offline child context capture path' });
  const previous = process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG;
  pi.on('session_start', () => {
    const path = pi.getFlag('dag-test-child-guidance-log');
    if (typeof path === 'string' && path) process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG = path;
  });
  pi.on('session_shutdown', () => {
    if (previous === undefined) delete process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG;
    else process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG = previous;
  });
}
