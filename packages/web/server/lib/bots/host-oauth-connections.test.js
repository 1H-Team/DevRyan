import { describe, expect, it, vi } from 'vitest';
import { createOpenAiOAuthCoordinator } from '../opencode/openai-oauth-coordinator.js';
import { createHostOAuthConnections, oauthAccountKey } from './host-oauth-connections.js';

function fixture({ legacyAccount = 'account-a', bound = false } = {}) {
  let host = { type: 'oauth', accountId: 'account-a', access: 'access-a', refresh: 'refresh-a', expires: Date.now() + 3600000 };
  let row = { id: 'credential', bot_id: 'bot', provider: 'openai', kind: 'oauth', status: 'active', updated_at: 'version-1',
    metadata: { label: 'Original label', ...(bound ? { connectionId: 'host:openai', oauthAccountKey: oauthAccountKey('account-a') } : {}) } };
  let secret = legacyAccount ? { ...host, accountId: legacyAccount } : null;
  let version = 1;
  const vault = {
    read: vi.fn(async () => {
      if (!secret) throw Object.assign(new Error('missing'), { code: 'bot_credential_not_found' });
      return { credential: { botId: 'bot', provider: 'openai', secretVersion: version }, secret };
    }),
    rotate: vi.fn(async (_id, next, _metadata, options) => {
      if (options.expectedSecretVersion !== version) throw Object.assign(new Error('conflict'), { code: 'bot_credential_rotation_conflict' });
      secret = next;
      version++;
    }),
  };
  const repository = {
    get: vi.fn(async () => row),
    updateIfRevision: vi.fn(async (_where, patch, expected) => {
      if (row.updated_at !== expected) throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
      row = { ...row, ...patch, updated_at: `version-${Number(row.updated_at.split('-')[1]) + 1}` };
      return row;
    }),
  };
  const coordinator = createOpenAiOAuthCoordinator({ readAuth: () => host });
  coordinator.markReady();
  const connections = createHostOAuthConnections({ coordinator, repository, vault });
  return { connections, repository, vault, row: () => row, secret: () => secret, setHost: (next) => { host = { ...host, ...next }; } };
}

describe('host-linked OpenAI connection identity', () => {
  it('migrates a proven matching legacy identity in place and erases its refresh snapshot', async () => {
    const f = fixture();
    expect(await f.connections.authState(f.row())).toBe('ready');
    expect(f.repository.updateIfRevision).not.toHaveBeenCalled();
    await f.connections.resolve(f.row());
    expect(f.row()).toMatchObject({ id: 'credential', bot_id: 'bot', metadata: { label: 'Original label', connectionId: 'host:openai', oauthAccountKey: oauthAccountKey('account-a') } });
    expect(f.secret()).toEqual({ type: 'host_oauth', connectionId: 'host:openai' });
    expect(JSON.stringify(f.repository.updateIfRevision.mock.calls)).not.toMatch(/access-a|refresh-a|account-a/);
  });

  it.each([null, 'account-b'])('requires Manager reconnection for missing/mismatched legacy identity (%s)', async (legacyAccount) => {
    const f = fixture({ legacyAccount });
    expect(await f.connections.authState(f.row())).toBe('reauth_required');
    await expect(f.connections.resolve(f.row())).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.repository.updateIfRevision).not.toHaveBeenCalled();
    expect(f.vault.rotate).not.toHaveBeenCalled();
  });

  it('adopts a new login for the same account without changing credential or revision IDs', async () => {
    const f = fixture({ bound: true });
    const before = f.row();
    const first = await f.connections.access('account-a');
    f.setHost({ access: 'new-login', refresh: 'new-refresh' });
    const next = await f.connections.access('account-a');
    expect(next.generation).not.toBe(first.generation);
    expect(next.accessToken).toBe('new-login');
    expect(f.row()).toBe(before);
  });

  it('requires explicit reconnect for an account switch and rejects stale reconnect writes', async () => {
    const f = fixture({ bound: true });
    const previous = f.row();
    f.setHost({ accountId: 'account-b' });
    await expect(f.connections.resolve(previous)).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    const updated = await f.connections.reconnect(previous, previous.updated_at);
    expect(updated.id).toBe(previous.id);
    expect(updated.metadata.oauthAccountKey).toBe(oauthAccountKey('account-b'));
    await expect(f.connections.reconnect(previous, previous.updated_at)).rejects.toMatchObject({ code: 'bot_revision_conflict' });
    expect(await f.connections.authState(updated)).toBe('ready');
  });

  it('does not issue old-account access after a reconnection races admission', async () => {
    const f = fixture({ bound: true });
    const binding = await f.connections.resolve(f.row());
    f.setHost({ accountId: 'account-b' });
    await f.connections.reconnect(f.row(), f.row().updated_at);
    await expect(f.connections.access(binding.accountId)).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
  });

  it('keeps legacy cleanup failure explicit and resumable after the binding commits', async () => {
    const f = fixture();
    f.vault.rotate.mockRejectedValueOnce(new Error('disk failure'));
    await expect(f.connections.resolve(f.row())).rejects.toThrow('disk failure');
    expect(f.row().metadata.oauthAccountKey).toBe(oauthAccountKey('account-a'));
    await f.connections.resolve(f.row());
    expect(f.secret().type).toBe('host_oauth');
  });

  it('handles concurrent legacy admission without restoring a discarded secret', async () => {
    const f = fixture();
    const original = f.row();
    const bindings = await Promise.all([f.connections.resolve(original), f.connections.resolve(original)]);
    expect(bindings.every((binding) => binding.accountId === 'account-a')).toBe(true);
    expect(f.secret()).toEqual({ type: 'host_oauth', connectionId: 'host:openai' });
  });
});
