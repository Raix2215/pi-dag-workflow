// Run: node test/bench-load.mjs [todos|plan|goal|retry|agents|all] [bundle-directory]
// Manual benchmark, not part of npm test/CI. Bundle artifacts are optional experimental inputs.
// Compare cold first-in-process samples only; measuring one after the other warms Node's TS loader.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { EventEmitter } from 'node:events';

let traceFile, prefixes;
export function initialize(data) { traceFile = data.traceFile; prefixes = data.prefixes; }
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (prefixes.some(prefix => result.url.startsWith(prefix))) appendFileSync(traceFile, result.url + '\n');
  return result;
}
const entries = ['todos', 'plan', 'goal', 'retry', 'agents'];
const sampling = ['--sample', '--trace'].includes(process.argv[2]);
const bundlePath = sampling ? process.argv[5] : process.argv[3];
const roots = { source: new URL('../src/', import.meta.url), bundle: bundlePath ? pathToFileURL(resolvePath(bundlePath) + '/') : new URL('../dist/', import.meta.url) };
if (isMainThread && sampling) {
  const target = process.argv[3], order = process.argv[4].split(',');
  if (process.argv[2] === '--trace') register(import.meta.url, { data: { traceFile: process.argv[6], prefixes: Object.values(roots).map(root => root.href) } });
  const t0 = performance.now(); await import('@earendil-works/pi-coding-agent'); const sdkMs = performance.now() - t0;
  const result = { sdkMs };
  for (const mode of order) {
    const t1 = performance.now();
    const imported = await Promise.all((target === 'all' ? entries : [target]).map(entry => import(new URL(`${entry}/index.ts`, roots[mode]))));
    const t2 = performance.now();
    const bus = new EventEmitter();
    const pi = {
      events: { emit: (name, data) => bus.emit(name, data), on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); } },
      on() { return () => {}; }, registerTool() {}, registerCommand() {}, registerFlag() {},
      getActiveTools() { return []; }, getAllTools() { return []; }, getFlag() {}, getThinkingLevel() { return 'off'; },
    };
    const attachStart = performance.now();
    for (const entry of imported) await entry.default(pi);
    const t3 = performance.now();
    result[mode] = { importMs: t2 - t1, attachMs: t3 - attachStart, totalMs: t2 - t1 + t3 - attachStart, ratio: (t2 - t1 + t3 - attachStart) / sdkMs };
  }
  console.log(JSON.stringify(result));
} else if (isMainThread) {
  const targets = process.argv[2] ? [process.argv[2]] : [...entries, 'all'];
  if (targets.some(target => ![...entries, 'all'].includes(target))) throw new Error('Expected todos, plan, goal, retry, agents or all');
  const power = [];
  try {
    for (const supply of readdirSync('/sys/class/power_supply')) for (const field of ['online', 'status']) {
      try { power.push(`${supply}/${field}=${readFileSync(`/sys/class/power_supply/${supply}/${field}`, 'utf8').trim()}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`Node=${process.version} CPU=${cpus().length} available=${availableParallelism()} Power=${power.join(', ') || 'unavailable'}`);
  const hasBundle = existsSync(new URL('todos/index.ts', roots.bundle));
  console.log('Same process SDK → import → attach. Cold columns use only the first plugin loaded, best total/SDK of 3; reverse-order samples expose warming, tracing is separate.');
  if (!hasBundle) console.log('Bundle unavailable: source loading retained; pass an experimental bundle directory for a two-column comparison.');
  const directory = mkdtempSync(join(tmpdir(), 'pi-dag-bench-load-'));
  const run = (target, order, trace) => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), trace ? '--trace' : '--sample', target, order, fileURLToPath(roots.bundle), ...trace ? [trace] : []], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, 'agent') } });
    if (child.error || child.status !== 0) throw child.error ?? new Error(child.stderr || `Sample exited ${child.status}`);
    return JSON.parse(child.stdout);
  };
  try {
    for (const target of targets) {
      const samples = [];
      for (const order of hasBundle ? ['source,bundle', 'bundle,source'] : ['source']) for (let round = 0; round < 3; round++) samples.push({ ...run(target, order), order });
      const trace = join(directory, `${target}.txt`);
      run(target, hasBundle ? 'source,bundle' : 'source', trace);
      const traced = readFileSync(trace, 'utf8').trim().split('\n');
      const best = mode => samples.filter(sample => sample.order.split(',')[0] === mode).reduce((a, b) => a[mode].ratio <= b[mode].ratio ? a : b);
      const source = best('source');
      const column = (sample, mode) => `${mode} import+attach=${sample[mode].importMs.toFixed(3)}+${sample[mode].attachMs.toFixed(3)}=${sample[mode].totalMs.toFixed(3)}ms SDK=${sample.sdkMs.toFixed(3)}ms ratio=${(sample[mode].ratio * 100).toFixed(3)}%`;
      let comparison = 'bundle unavailable';
      if (hasBundle) {
        const bundle = best('bundle');
        const reduction = (1 - bundle.bundle.ratio / source.source.ratio) * 100;
        comparison = `${column(bundle, 'bundle')} | coldReduction=${reduction.toFixed(2)}% | ${reduction < 15 ? 'retain source (<15%)' : 'bundle passes 15% threshold'}`;
      }
      console.log(`${target}: ${column(source, 'source')} | ${comparison}`);
      for (const mode of hasBundle ? ['source', 'bundle'] : ['source']) {
        const files = [...new Set(traced.filter(url => url.startsWith(roots[mode].href)).map(url => fileURLToPath(url).slice(fileURLToPath(roots[mode]).length)))].sort();
        console.log(`  ${mode} totalFiles=${files.length}: ${files.join(', ')}`);
      }
      console.log(`  samples=${samples.map(sample => `${sample.order}:src=${sample.source.totalMs.toFixed(3)}ms/${sample.sdkMs.toFixed(3)}ms${sample.bundle ? `,bundle=${sample.bundle.totalMs.toFixed(3)}ms/${sample.sdkMs.toFixed(3)}ms` : ''}`).join('; ')}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
