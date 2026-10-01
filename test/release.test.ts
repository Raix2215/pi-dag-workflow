import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error The release checker is plain ESM and intentionally has no type declarations.
import { checkMetadata, checkPack, scanText } from '../scripts/check-release.mjs';

type Finding = { rule: string; line: number };

const baseManifest = {
  version: '0.1.0',
  license: 'MIT',
  keywords: ['pi-package'],
  files: ['src', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'docs'],
};

test('release metadata requires a real version, MIT license, and the publishable file list', () => {
  assert.deepEqual(checkMetadata(baseManifest).errors, []);
  assert.equal(checkMetadata({ ...baseManifest, version: '0.0.0' }).errors.length, 1);
  assert.equal(checkMetadata({ ...baseManifest, license: 'UNLICENSED' }).errors.length, 1);
  assert.equal(checkMetadata({ ...baseManifest, private: true }).errors.length, 1);
  assert.equal(checkMetadata({ ...baseManifest, files: ['src'] }).errors.length, 5);
});

test('a missing repository URL is a warning, never a failure', () => {
  const { errors, warnings } = checkMetadata(baseManifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.deepEqual(checkMetadata({ ...baseManifest, repository: 'https://github.com/example/pi-dag-workflow' }).warnings, []);
});

const goodPack = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/COMMUNICATION.md',
  'docs/RELEASING.md',
  'src/todos/index.ts',
  'src/plan/index.ts',
  'src/agents/index.ts',
  'src/goal/index.ts',
  'src/ui/index.ts',
];

test('tarball whitelist accepts the expected files and rejects local paths', () => {
  assert.deepEqual(checkPack(goodPack).errors, []);
  const errors = checkPack([...goodPack, 'test/release.test.ts', 'artifacts/live/m1/summary.json', '.env.local', 'AGENTS.md', 'docs/DEVELOPMENT.md']).errors;
  assert.ok(errors.some((error: string) => error.includes('test/release.test.ts')));
  assert.ok(errors.some((error: string) => error.includes('artifacts/live/m1/summary.json')));
  assert.ok(errors.some((error: string) => error.includes('.env.local')));
  assert.ok(errors.some((error: string) => error.includes('AGENTS.md')));
  assert.ok(errors.some((error: string) => error.includes('docs/DEVELOPMENT.md')));
});

test('content scan flags machine traces without keeping the traced values in the test file', () => {
  const homePath = ['/ho', 'me/someuser/projects'].join('');
  const modelRef = ['provider: "mycorp', '/internal-model"'].join('');
  const token = ['sk-', 'A'.repeat(24)].join('');
  const patToken = ['gh', 'p_', 'B'.repeat(24)].join('');
  const appToken = ['github', '_pat_', 'C'.repeat(24)].join('');
  const npmToken = ['npm', '_', 'D'.repeat(24)].join('');
  const privateKey = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
  const urlWithCredentials = ['https://user', ':pass', '@example.invalid/file'].join('');
  const personalEmail = ['person@mail', '.test'].join('');

  assert.ok(scanText(`path=${homePath}`).some((finding: Finding) => finding.rule === 'absolute-home-path'));
  assert.ok(scanText(modelRef).some((finding: Finding) => finding.rule === 'hardcoded-private-model-reference'));
  assert.ok(scanText(token).some((finding: Finding) => finding.rule === 'secret-token'));
  assert.ok(scanText(patToken).some((finding: Finding) => finding.rule === 'secret-token'));
  assert.ok(scanText(appToken).some((finding: Finding) => finding.rule === 'secret-token'));
  assert.ok(scanText(npmToken).some((finding: Finding) => finding.rule === 'secret-token'));
  assert.ok(scanText(privateKey).some((finding: Finding) => finding.rule === 'private-key-block'));
  assert.ok(scanText(urlWithCredentials).some((finding: Finding) => finding.rule === 'url-embedded-credentials'));
  assert.ok(scanText(`contact ${personalEmail}`).some((finding: Finding) => finding.rule === 'personal-email'));
});

test('content scan leaves fixtures, registry URLs, and placeholder addresses alone', () => {
  const benign = [
    'const model = { provider: "dag-test", id: "scripted" };',
    'const config = { apiKey: "offline-test-only", baseUrl: "http://offline.invalid" };',
    'resolved: "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.2.tgz"',
    'Follow /home/<user>/ conventions and contact maintainer@example.com.',
    'See https://github.com/<owner>/pi-dag-workflow for details.',
  ].join('\n');
  assert.deepEqual(scanText(benign), []);
});
