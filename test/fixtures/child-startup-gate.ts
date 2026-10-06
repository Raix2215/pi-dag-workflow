/** Deterministic startup stall for cancellation tests; never loaded in production. */
export default async function startupGate(): Promise<void> {
  if (process.env.PI_DAG_CHILD === '1') await new Promise<void>(() => { setInterval(() => {}, 1000); });
}
