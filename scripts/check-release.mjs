#!/usr/bin/env node
// Release hygiene checker.
//
// Verifies package metadata, the packed file whitelist, and machine traces
// (absolute home paths, hardcoded private provider/model references, personal
// email addresses, and real credential formats) across tracked and candidate
// release files. Findings are reported as file and rule only: the matched value
// is never printed.
//
// Usage:
//   node scripts/check-release.mjs            # metadata + pack + content scan
//   node scripts/check-release.mjs --history  # also scan commit metadata and historical file content
//
// This file is skipped when scanning so its own rule patterns never flag it.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF = 'scripts/check-release.mjs';

const ALLOWED_HOME_NAMES = new Set(['user', 'runner', 'example', 'node', 'app', 'me', 'you', 'ci']);
const EMAIL_ALLOW = [/@example\.(com|org|net)$/i, /^noreply@/i, /@users\.noreply\.github\.com$/i, /@localhost$/i];

const REQUIRED_PACK_FILES = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/COMMUNICATION.md',
  'src/todos/index.ts',
  'src/plan/index.ts',
  'src/agents/index.ts',
  'src/goal/index.ts',
  'src/ui/index.ts',
];
const REQUIRED_PACKAGE_FILES = ['src', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'docs'];
const FORBIDDEN_PACK_PREFIXES = ['node_modules/', '.pi/', 'test/', 'tests/', 'artifacts/', '.git/', 'scripts/', '.github/', '.workflow/'];
const ALLOWED_DOCS_FILES = new Set(['docs/RELEASING.md', 'docs/COMMUNICATION.md', 'docs/REVIEW-0.2.0.md']);

function linesOf(text) {
  return text.split('\n').map((text, index) => ({ number: index + 1, text }));
}

function matchLines(text, regex) {
  const hits = [];
  for (const line of linesOf(text)) {
    regex.lastIndex = 0;
    if (regex.test(line.text)) hits.push(line.number);
  }
  return hits;
}

/** Rules applied to every scanned file. Each rule returns line numbers only. */
export const CONTENT_RULES = [
  {
    name: 'absolute-home-path',
    find(text) {
      const hits = [];
      const re = /(^|[^A-Za-z0-9_])(?:\/home|\/Users)\/([A-Za-z0-9][A-Za-z0-9._-]*)\//g;
      for (const line of linesOf(text)) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line.text))) {
          if (!ALLOWED_HOME_NAMES.has(match[2].toLowerCase())) hits.push(line.number);
        }
      }
      return hits;
    },
  },
  {
    name: 'windows-home-path',
    find(text) {
      return matchLines(text, /[A-Za-z]:\\\\Users\\\\[^\\\s]+\\\\/);
    },
  },
  {
    // A provider/model literal namespaced with ':' or '/' points at a local
    // configuration. Plain fixture names such as dag-test or scripted are fine.
    name: 'hardcoded-private-model-reference',
    find(text) {
      return matchLines(text, /\b(?:provider|model)["']?\s*[:=]\s*["'][^"']*[:/][^"']*["']/);
    },
  },
  {
    name: 'secret-token',
    find(text) {
      return matchLines(text, /(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})/);
    },
  },
  {
    name: 'private-key-block',
    find(text) {
      return matchLines(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    },
  },
  {
    // Credentials embedded in a URL (user:password@host). Plain package
    // registry URLs have no userinfo and are not flagged.
    name: 'url-embedded-credentials',
    find(text) {
      return matchLines(text, /https?:\/\/[^/\s"'@:]+:[^/\s"'@]+@/);
    },
  },
  {
    name: 'personal-email',
    find(text) {
      const hits = [];
      const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
      for (const line of linesOf(text)) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line.text))) {
          if (EMAIL_ALLOW.some((allow) => allow.test(match[0]))) continue;
          hits.push(line.number);
        }
      }
      return hits;
    },
  },
];

/** Metadata rules for package.json. Repository URL is a warning, never a failure. */
export function checkMetadata(manifest) {
  const errors = [];
  const warnings = [];
  const version = String(manifest.version ?? '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version === '0.0.0') {
    errors.push('package version must be a real release version (not 0.0.0)');
  }
  if (manifest.license !== 'MIT') errors.push('package license must be MIT');
  if (manifest.private === true) errors.push('package must not set private: true');
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of REQUIRED_PACKAGE_FILES) {
    if (!files.includes(entry)) errors.push(`package files must include ${entry}`);
  }
  if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes('pi-package')) {
    errors.push('package keywords must include pi-package');
  }
  const repository = manifest.repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (typeof url !== 'string' || url.length === 0) {
    warnings.push('repository URL is not set yet; fill it before publishing');
  }
  return { errors, warnings };
}

/** Tarball rules for the file list produced by `npm pack --dry-run --json`. */
export function checkPack(files) {
  const errors = [];
  const paths = new Set(files.map((file) => (typeof file === 'string' ? file : file.path)));
  for (const required of REQUIRED_PACK_FILES) {
    if (!paths.has(required)) errors.push(`packed tarball is missing ${required}`);
  }
  if (!paths.has('docs/RELEASING.md')) errors.push('packed tarball is missing docs/RELEASING.md');
  for (const path of paths) {
    if (FORBIDDEN_PACK_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      errors.push(`packed tarball must not include ${path}`);
    }
    if (path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) {
      errors.push('packed tarball must not include AGENTS.md');
    }
    if (path.startsWith('docs/') && !ALLOWED_DOCS_FILES.has(path)) {
      errors.push(`packed tarball must not include extra docs file ${path}`);
    }
    if (path.endsWith('.jsonl') || path.split('/').some((segment) => segment === '.env' || segment.startsWith('.env.'))) {
      errors.push(`packed tarball must not include ${path}`);
    }
  }
  return { errors };
}

/** Scan text with every rule and return { rule, line } findings. */
export function scanText(text) {
  const findings = [];
  for (const rule of CONTENT_RULES) {
    for (const line of rule.find(text)) findings.push({ rule: rule.name, line });
  }
  return findings;
}

function gitTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function packFiles() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  const entry = Object.values(parsed)[0] ?? {};
  return (entry.files ?? []).map((file) => (typeof file === 'string' ? file : file.path));
}

async function scanRepo(paths) {
  const findings = [];
  for (const path of paths) {
    if (path === SELF) continue; // rule definitions must not flag themselves
    let text;
    try {
      text = await readFile(resolve(root, path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // skip binaries
    for (const finding of scanText(text)) findings.push({ file: path, ...finding });
  }
  return findings;
}

function checkHistory() {
  const output = execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { cwd: root, encoding: 'utf8' });
  const findings = [];
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  output.split('\n').forEach((line, index) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(line))) {
      if (EMAIL_ALLOW.some((allow) => allow.test(match[0]))) continue;
      findings.push({ file: 'commit-history', rule: 'commit-author-email', line: index + 1 });
    }
  });
  const messages = execFileSync('git', ['log', '--all', '--format=%B'], { cwd: root, encoding: 'utf8' });
  findings.push(...scanText(messages).map((finding) => ({ file: 'commit-messages', ...finding })));
  return findings;
}

/** Scan unique historical blobs, including content no longer present in the working tree. */
function checkHistoricalContent() {
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
  const names = new Map(objects.map((line) => [line.slice(0, 40), line.slice(41)]));
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: root, encoding: 'utf8', input: [...names.keys()].join('\n') + '\n', maxBuffer: 32 * 1024 * 1024 });
  const findings = [];
  for (const line of types.trim().split('\n')) {
    const [object, type] = line.split(' ');
    const path = names.get(object);
    if (type !== 'blob' || !path || path === SELF) continue;
    if (/(^|\/)AGENTS\.md$/i.test(path)) findings.push({ file: `history:${path}`, line: 1, rule: 'private-context-file' });
    const text = execFileSync('git', ['cat-file', 'blob', object], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (!text.includes('\u0000')) findings.push(...scanText(text).map((finding) => ({ file: `history:${path}@${object.slice(0, 12)}`, ...finding })));
  }
  return findings;
}

async function main() {
  const history = process.argv.includes('--history');
  const errors = [];
  const warnings = [];

  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const metadata = checkMetadata(manifest);
  errors.push(...metadata.errors);
  warnings.push(...metadata.warnings);

  let packed = [];
  try {
    packed = packFiles();
  } catch (error) {
    errors.push(`could not run npm pack dry run: ${error instanceof Error ? error.message : String(error)}`);
  }
  errors.push(...checkPack(packed).errors);

  const tracked = gitTrackedFiles();
  if (tracked.includes('AGENTS.md')) errors.push('AGENTS.md must not be tracked');

  const scanTargets = [...new Set([...tracked, ...packed])];
  if (tracked.includes('.npmrc')) errors.push('repository must not include private npm configuration');
  if (tracked.some((path) => /(^|\/)AGENTS\.md$/i.test(path))) errors.push('AGENTS.md must not be included in the public repository');
  const findings = await scanRepo(scanTargets);
  if (history) findings.push(...checkHistory(), ...checkHistoricalContent());

  for (const finding of findings) {
    errors.push(`${finding.file}:${finding.line} [${finding.rule}]`);
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length === 0) {
    console.log(`release check passed (${scanTargets.length} files scanned${history ? ', history included' : ''})`);
    return 0;
  }
  console.error(`release check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  return 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`release check crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
