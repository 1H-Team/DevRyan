import { expect, test } from 'vitest';
import { createNativeClaudeCheckpointOwner, nativeClaudeStateDirectory } from './native-claude-checkpoint.js';
import { parseProviderDiagnostic } from './native-provider-worker-protocol.js';

const boot = { instanceID: 'b'.repeat(32), globals: { home: '/owned/home' },
  profiles: [{ id: 'selected', claudeConfigDir: '/owned/profile' }], transport: { storage: '/owned/transport', directories: ['/project'] } };
const scope = { attemptID: 'a'.repeat(64), sessionID: 'ses_owned', directory: '/project', profileID: 'selected' };
test('checkpoint directory requires the current exact attempt, location and constructor-owned profile', () => {
  let current = true;
  const owner = createNativeClaudeCheckpointOwner({ boot, assertAttempt(input) {
    if (!current || input.sessionID !== scope.sessionID || input.attemptID !== scope.attemptID) throw new Error('expired');
  } });
  const expected = nativeClaudeStateDirectory({ ...boot.transport, home: boot.globals.home, profile: boot.profiles[0], directory: '/project' });
  expect(() => owner.directory(JSON.stringify(scope), '/project')).toThrow();
  owner.bindTransport(JSON.stringify(scope), '/project');
  expect(owner.directory(JSON.stringify(scope), '/project')).toBe(expected);
  for (const value of [{ ...scope, profileID: 'other' }, { ...scope, directory: '/other' }, { ...scope, sessionID: 'ses_other' },
    { ...scope, attemptID: 'c'.repeat(64) }, { ...scope, configDirectory: '/private' }]) expect(() => owner.directory(JSON.stringify(value), '/project')).toThrow();
  expect(() => owner.directory(JSON.stringify(scope), '/other')).toThrow();
  current = false; expect(() => owner.directory(JSON.stringify(scope), '/project')).toThrow('expired');
});
test('a sibling allowed account cannot replace the physical transport account for a checkpoint', () => {
  const owner = createNativeClaudeCheckpointOwner({ boot: { ...boot, profiles: [...boot.profiles, { id: 'sibling', claudeConfigDir: '/owned/sibling' }] }, assertAttempt() {} });
  owner.bindTransport(JSON.stringify(scope), '/project');
  const sibling = JSON.stringify({ ...scope, profileID: 'sibling' });
  expect(() => owner.directory(sibling, '/project')).toThrow();
  expect(() => owner.bindTransport(sibling, '/project')).toThrow();
  owner.release(scope.attemptID); expect(() => owner.directory(JSON.stringify(scope), '/project')).toThrow();
});
test('checkpoint diagnostics are finite, attempt-bound and capped without raw provider content', () => {
  let active = true; const events = [];
  const owner = createNativeClaudeCheckpointOwner({ boot, assertAttempt() { if (!active) throw new Error('expired'); }, publish: value => events.push(parseProviderDiagnostic(value)) });
  const raw = JSON.stringify(scope), detail = { reason: 'persisted_boundary_unverified', toolCount: 2 };
  owner.diagnostic(raw, 'passthrough.checkpoint_rejected', { ...detail, body: 'private' });
  owner.diagnostic(raw, 'private event', detail); owner.diagnostic(raw, 'passthrough.checkpoint_rejected', { ...detail, reason: 'private reason' });
  expect(events).toEqual([]);
  for (let index = 0; index < 70; index++) owner.diagnostic(raw, 'passthrough.checkpoint_rejected', detail);
  expect(events).toHaveLength(64); expect(events[0].checkpoint).toEqual({ event: 'passthrough.checkpoint_rejected', ...detail });
  const stalled = createNativeClaudeCheckpointOwner({ boot, assertAttempt() {}, publish: value => events.push(parseProviderDiagnostic(value)) });
  for (const event of ['passthrough.checkpoint_aborted', 'passthrough.checkpoint_retry']) stalled.diagnostic(raw, event, { reason: 'upstream_idle', toolCount: 0 });
  expect(events.slice(64).map(value => value.checkpoint)).toEqual([
    { event: 'passthrough.checkpoint_aborted', reason: 'upstream_idle', toolCount: 0 },
    { event: 'passthrough.checkpoint_retry', reason: 'upstream_idle', toolCount: 0 },
  ]);
  events.splice(64);
  active = false; owner.diagnostic(raw, 'passthrough.checkpoint_settled', { reason: 'sdk_terminal', toolCount: 2 });
  expect(events).toHaveLength(64);
  expect(() => parseProviderDiagnostic({ ...events[0], checkpoint: { ...events[0].checkpoint, token: 'private' } })).toThrow();
});
