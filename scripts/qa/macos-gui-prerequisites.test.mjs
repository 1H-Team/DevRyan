import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireDisposableMacRunner, readGuiPrerequisite } from './macos-gui-prerequisites.mjs';

test('GUI qualification refuses the owner host and never promotes missing prerequisites', () => {
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_SHA: 'a'.repeat(40) };
  requireDisposableMacRunner(env, 'darwin', 'arm64');
  for (const update of [{ CI: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'another/repo' }]) {
    assert.throws(() => requireDisposableMacRunner({ ...env, ...update }, 'darwin', 'arm64'));
  }
  assert.throws(() => requireDisposableMacRunner(env, 'darwin', 'x64'));
  const probe = { protocol: 'devryan.macos-gui-prerequisites/1', status: 'ready', visible: true, windowId: 1,
    checks: { onConsole: true, loggedIn: true, sameUser: true, screenCapture: true } };
  assert.equal(readGuiPrerequisite(JSON.stringify(probe)).status, 'ready');
  assert.throws(() => readGuiPrerequisite(JSON.stringify({ ...probe, checks: { ...probe.checks, screenCapture: false } })));
  assert.throws(() => readGuiPrerequisite(JSON.stringify({ ...probe, visible: false })));
  assert.equal(readGuiPrerequisite(JSON.stringify({ ...probe, status: 'unavailable', checks: { ...probe.checks, onConsole: false } })).status, 'unavailable');
});
