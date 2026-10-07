import { describe, expect, it, vi } from 'vitest';
import { configurationResourceBlockers } from './configuration-readiness.js';

describe('retained Bot configuration resources', () => {
  const botId = 'bot';
  const contract = {
    skillBindings: [{ id: 'skill', digest: 'skill-digest' }],
    libraryVersionIds: ['library'],
    mcpBindings: [{ id: 'mcp', descriptorDigest: 'descriptor', manifestDigest: 'manifest' }],
    agent: { kind: 'opencode', models: { primary: { credentialId: 'primary' }, fallbacks: [{ credentialId: 'fallback' }] } },
  };
  const rows = () => ({
    skill: { id: 'skill', bot_id: botId, package_digest: 'skill-digest' },
    library: { id: 'library', source_id: 'source' },
    source: { id: 'source', bot_id: botId, retired_at: null },
    mcp: { id: 'mcp', bot_id: botId, descriptor_digest: 'descriptor', manifest_digest: 'manifest' },
    primary: { id: 'primary', bot_id: botId, status: 'active', revoked_at: null },
    fallback: { id: 'fallback', bot_id: botId, status: 'active', revoked_at: null },
  });
  it('uses valid existing local resources without rewriting the contract', async () => {
    const resources = rows();
    const before = structuredClone(contract);
    const get = vi.fn(async (_table, id) => resources[id]);
    expect(await configurationResourceBlockers({ botId, contract, get })).toEqual([]);
    expect(contract).toEqual(before);
    expect(get).toHaveBeenCalledWith('bot_credentials', 'fallback');
  });
  it('reports exact missing, mismatched and disconnected references', async () => {
    const resources = rows();
    delete resources.library;
    resources.skill.package_digest = 'changed';
    resources.mcp.bot_id = 'other-bot';
    resources.primary.status = 'error';
    expect(await configurationResourceBlockers({ botId, contract, get: async (_table, id) => resources[id],
      environmentSecrets: [{ id: 'environment', bot_id: botId, status: 'error' }] }))
      .toEqual([
        { botId, kind: 'skill', resourceId: 'skill' },
        { botId, kind: 'library', resourceId: 'library' },
        { botId, kind: 'mcp', resourceId: 'mcp' },
        { botId, kind: 'credential', resourceId: 'primary' },
        { botId, kind: 'environment', resourceId: 'environment' },
      ]);
  });
  it('requires an AG-UI bearer credential to be usable locally', async () => {
    const get = async (table) => table === 'bot_agent_connections'
      ? { id: 'agent', bot_id: botId, descriptor_digest: 'digest', status: 'active', auth_mode: 'bearer', credential_id: 'token' }
      : { id: 'token', bot_id: botId, status: 'error', revoked_at: null };
    expect(await configurationResourceBlockers({ botId, get,
      contract: { agent: { kind: 'ag_ui', connectionRef: 'agent', connectionDigest: 'digest' } } }))
      .toEqual([{ botId, kind: 'credential', resourceId: 'token' }]);
  });
  it('resolves required MCP credentials with the connector team/personal scope rules', async () => {
    const resources = rows();
    resources.mcp.display_metadata = { credentialRequired: true };
    resources.mcp.credential_provider = 'mcp.binding';
    const credential = { bot_id: botId, provider: 'mcp.binding', status: 'active', revoked_at: null,
      credential_scope: 'user', owner_user_id: 'alice' };
    const options = { botId, contract, get: async (_table, id) => resources[id], credentials: [credential] };
    expect(await configurationResourceBlockers({ ...options, ownerUserId: 'bob' }))
      .toEqual([{ botId, kind: 'mcp-credential', resourceId: 'mcp' }]);
    expect(await configurationResourceBlockers({ ...options, ownerUserId: 'alice' })).toEqual([]);
    credential.credential_scope = 'team'; credential.owner_user_id = null;
    expect(await configurationResourceBlockers(options)).toEqual([]);
    credential.status = 'error';
    expect(await configurationResourceBlockers(options)).toEqual([{ botId, kind: 'mcp-credential', resourceId: 'mcp' }]);
  });
});
