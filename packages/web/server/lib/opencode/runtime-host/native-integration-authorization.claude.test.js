import { expect, test } from 'vitest';
import { createNativeIntegrationAuthorization } from './native-integration-authorization.js';
import { credentialMutationFingerprint } from './native-credential-mutation-owner.js';
import { toClaudeAgentStatus } from '../v2/native-integration-facade.js';

const directory = '/tmp/devryan-claude-agent-workspace';
const configurationDigest = 'a'.repeat(64);
const grants = () => createNativeIntegrationAuthorization({ controllerIdentity: () => 'controller-1', verifyBinding: async () => {},
  captureWebAuthorization: async () => async () => {}, authorizeConfiguredConnection: async () => {} });
const base = { kind: 'claude', directory, configurationDigest, integrationID: 'claude-agent' };

test('claude scope admits only reading, connecting claude-login and removing a connection', async () => {
  const authorization = grants();
  const run = spec => authorization.withCallerOperation(spec, async () => 'ran');
  await expect(run({ ...base, operation: 'claude.integration', method: 'GET', path: '/api/integration/claude-agent' })).resolves.toBe('ran');
  await expect(run({ ...base, methodID: 'claude-login', operation: 'claude.connect', method: 'POST',
    path: '/api/integration/claude-agent/connect/external', body: { methodID: 'claude-login' } })).resolves.toBe('ran');
  await expect(run({ ...base, operation: 'claude.credential.remove', method: 'DELETE', path: '/api/credential/cred_1',
    credentialID: 'cred_1', requestedFingerprint: credentialMutationFingerprint({ id: 'cred_1' }) })).resolves.toBe('ran');

  for (const spec of [
    // Another external method, another integration, a key, or an OAuth start under the claude kind.
    { ...base, methodID: 'azure-cli', operation: 'claude.connect', method: 'POST', path: '/api/integration/claude-agent/connect/external', body: { methodID: 'azure-cli' } },
    { ...base, integrationID: 'openai', operation: 'claude.integration', method: 'GET', path: '/api/integration/openai' },
    { ...base, operation: 'claude.credential.create', method: 'POST', path: '/api/credential', body: { integrationID: 'claude-agent', value: { type: 'key', key: 'x' } } },
    { ...base, methodID: 'claude-login', operation: 'claude.oauth.start', method: 'POST', path: '/api/integration/claude-agent/connect/oauth', body: { methodID: 'claude-login' } },
    { ...base, operation: 'claude.credential.remove', method: 'DELETE', path: '/api/credential/cred_1', credentialID: 'cred_1', requestedFingerprint: 'b'.repeat(64) },
  ]) await expect(run(spec)).rejects.toThrow('native_integration_scope_invalid');
});

test('browser status carries login state only', () => {
  const info = { id: 'claude-agent', methods: [{ id: 'claude-login', type: 'external', label: 'Claude Code login (claude auth login)' }],
    connections: [{ type: 'credential', id: 'cred_1', method: 'external', label: 'secret-label', value: { token: 'x' },
      status: { status: 'needs_auth', message: 'Claude Code is not logged in. Run `claude auth login` in a terminal.', url: 'javascript:alert(1)' } }] };
  expect(toClaudeAgentStatus(info)).toEqual({ providerID: 'claude-agent', available: true, connected: true,
    problem: { status: 'needs_auth', message: 'Claude Code is not logged in. Run `claude auth login` in a terminal.' } });
  expect(toClaudeAgentStatus({ ...info, connections: [] })).toEqual({ providerID: 'claude-agent', available: true, connected: false });
});

test('claude-agent connects once when Claude Code is installed, never after a Disconnect', async () => {
  const runtime = { generation: 2, baseUrl: 'http://127.0.0.1:1', version: '2.2.5', epoch: 1 };
  const connections = [];
  let choice, installed = true, snapshot = { locations: [{ directory, configuration: { providers: {} } }] };
  const requests = [];
  const owner = { isReady: () => true, getConfigurationSnapshot: () => snapshot,
    withIntegrationOperation: (spec, action) => { requests.push(spec.operation); return action(); },
    claudeAgentConnectionChoice: () => choice, recordClaudeAgentConnectionChoice: async value => { choice = value; } };
  const { createNativeIntegrationFacade } = await import('../v2/native-integration-facade.js');
  const facade = createNativeIntegrationFacade({ getNativeRuntimeOwner: () => owner, getOpenCodeRuntime: () => runtime, claudeInstalled: () => installed,
    request: async ({ method = 'GET', path }) => {
      if (method === 'POST' && path === '/api/integration/claude-agent/connect/external') { connections.push({ type: 'credential', id: 'cred_1', method: 'external' }); return true; }
      if (method === 'DELETE') { connections.splice(0); return true; }
      return { id: 'claude-agent', methods: [{ id: 'claude-login', type: 'external', label: 'Claude Code login' }], connections: [...connections] };
    } });
  const options = { directory };
  installed = false;
  expect(await facade.claudeAutoConnect(options)).toBe(false);
  // A later configuration revisits the choice; one already settled is not read again.
  snapshot = { ...snapshot }; installed = true;
  expect(await facade.claudeAutoConnect(options)).toBe(true);
  expect(connections).toHaveLength(1);
  requests.splice(0);
  expect(await facade.claudeAutoConnect(options)).toBe(false);
  expect(requests).toEqual([]);
  expect(choice).toBeUndefined();
  await facade.claudeDisconnect(options);
  expect(choice).toBe('disconnected');
  snapshot = { ...snapshot };
  expect(await facade.claudeAutoConnect(options)).toBe(false);
  expect(connections).toHaveLength(0);
  expect((await facade.claudeConnect(options)).connected).toBe(true);
  expect(choice).toBe('connected');
});
