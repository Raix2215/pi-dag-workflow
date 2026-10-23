import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

/**
 * `process.execPath` is Node, not pi. Every child process must be spawned as
 * `node <this path> [args]`, so both agents and team resolve the CLI here.
 */
export function resolvePiCli(): string {
  const require = createRequire(import.meta.url);
  const folders = [getPackageDir(), ...(require.resolve.paths('@earendil-works/pi-coding-agent') ?? []).map((path) => join(path, '@earendil-works/pi-coding-agent'))];
  for (const folder of folders) {
    try {
      const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name?: string; bin?: string | { pi?: string } };
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (!bin) throw new Error("Pi package has no CLI bin");
        return resolve(folder, bin);
      }
    } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("Cannot locate installed Pi package bin");
}

/** Interpreter plus CLI entry, kept apart: passing args to Node is what broke the first dispatch. */
export function piLaunchTarget(): { execPath: string; cli: string } {
  return { execPath: process.execPath, cli: resolvePiCli() };
}
