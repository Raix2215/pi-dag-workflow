/**
 * An outbound network boundary installed from a public host extension entry, i.e. *after* the host has already
 * chosen its global fetch. Installing it earlier (a `--import` preload) loses that race: the host's own dispatcher
 * startup decides which fetch is global, so a preload's wrapper can be replaced before anything runs. That is why
 * the installation is the extension factory below and not module-top-level code.
 *
 * It is not part of the SDK and does not reimplement any transport: it wraps `globalThis.fetch`, records the origin
 * of every attempt, forwards the original input/init untouched, and refuses anything that is not the one allowed
 * loopback origin. The recorded line is therefore written by the process that made the request, which is what turns
 * "the SDK only reached our loopback" into evidence instead of an assumption.
 *
 * `PI_DAG_GUARD_ORIGIN`, `PI_DAG_GUARD_LOG` and `PI_DAG_GUARD_INSTALL_LOG` come from the caller's environment. The
 * install record lives in its own file and carries only the phase, pid, CLI, node and which function was replaced —
 * no environment dump and no credentials — so request counting can never be padded by an install line.
 */
import { appendFileSync } from 'node:fs';

interface GuardEntry { url: string; origin: string; method: string; allowed: boolean }

/** Default-exported extension entry: the host calls it once its process is initialized. */
export default function installFetchGuard(): void {
  const allowed = (process.env.PI_DAG_GUARD_ORIGIN ?? '').replace(/\/+$/, '');
  const logPath = process.env.PI_DAG_GUARD_LOG ?? '';
  const installPath = process.env.PI_DAG_GUARD_INSTALL_LOG ?? '';
  if (!allowed) throw new Error('the fetch guard needs PI_DAG_GUARD_ORIGIN');
  if (!logPath) throw new Error('the fetch guard needs PI_DAG_GUARD_LOG');
  if (!installPath) throw new Error('the fetch guard needs PI_DAG_GUARD_INSTALL_LOG');

  const replaced = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const origin = new URL(url).origin;
    const hit = url === allowed || url.startsWith(`${allowed}/`);
    const entry: GuardEntry = { url, origin, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), allowed: hit };
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    if (!hit) throw new Error(`fetch guard refused a non-loopback origin: ${origin} (${url})`);
    return replaced(input, init);
  }) as typeof globalThis.fetch;

  appendFileSync(installPath, `${JSON.stringify({ phase: 'extension-install', pid: process.pid, cli: process.argv[1] ?? '', node: process.execPath, replaced: replaced.name || 'anonymous' })}\n`);
}
