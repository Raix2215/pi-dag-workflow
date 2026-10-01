import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../src/agents/profiles.ts';

test('removed user Profile file invalidates cached named profiles instead of retaining ghosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-profile-'));
  const path = join(dir, 'pi-dag-workflow-profile.json');
  const model = { provider: 'offline', id: 'model' };
  const profiles = new ProfileStore({ path, registry: { find: () => model } });
  try {
    profiles.set({ name: 'test', model }); await profiles.save(); await profiles.load();
    assert.equal(profiles.list().length, 1);
    await rm(path); await profiles.load();
    assert.deepEqual(profiles.list(), []);
    assert.throws(() => profiles.resolve('test', model), /Unknown profile/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
