import crypto from 'node:crypto';
import { OpenAiOAuthError, OPENAI_OAUTH_AUTHENTICATION, openAiAccountId } from '../opencode/openai-oauth-coordinator.js';

export const oauthAccountKey = (id) => crypto.createHash('sha256').update(`openai:${id}`).digest('hex');
export const isHostOpenAiCredential = (row) => row?.provider === 'openai' && row?.kind === 'oauth';

export function createHostOAuthConnections({ coordinator, repository, vault }) {
  const requireCoordinator = () => {
    if (!coordinator) throw new OpenAiOAuthError('bot_oauth_coordinator_unavailable');
    return coordinator;
  };
  const bindingMetadata = () => {
    const binding = requireCoordinator().getBinding();
    return { connectionId: binding.connectionId, oauthAccountKey: oauthAccountKey(binding.accountId) };
  };
  const forgetLegacySecret = async (row) => {
    let stored;
    try { stored = await vault.read(row.id); } catch (error) {
      if (error?.code === 'bot_credential_not_found') return;
      throw error;
    }
    if (stored.credential.botId !== row.bot_id || stored.credential.provider !== 'openai') {
      throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
    }
    if (stored.secret?.type === 'host_oauth') return;
    try {
      await vault.rotate(row.id, { type: 'host_oauth', connectionId: 'host:openai' }, undefined,
        { expectedSecretVersion: stored.credential.secretVersion });
    } catch (error) {
      if (error?.code !== 'bot_credential_rotation_conflict') throw error;
      const current = await vault.read(row.id);
      if (current.credential.botId !== row.bot_id || current.credential.provider !== 'openai'
        || current.secret?.type !== 'host_oauth') throw error;
    }
  };
  return Object.freeze({
    bindingMetadata,
    async resolve(row, { migrate = true } = {}) {
      const botId = row.bot_id;
      const binding = requireCoordinator().getBinding();
      const key = oauthAccountKey(binding.accountId);
      if (!row.metadata?.oauthAccountKey) {
        // Legacy connections imported a host snapshot without binding its account.
        // Only the encrypted old snapshot can establish identity; absence is not
        // permission to use whichever account happens to be signed in today.
        let stored;
        try { stored = await vault.read(row.id); } catch (error) {
          if (error?.code !== 'bot_credential_not_found') throw error;
        }
        if (stored?.credential?.botId !== row.bot_id || stored?.credential?.provider !== 'openai'
          || openAiAccountId(stored?.secret) !== binding.accountId) {
          throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
        }
        if (migrate) {
          try {
            row = await repository.updateIfRevision({ id: row.id, bot_id: row.bot_id }, {
              metadata: { ...row.metadata, connectionId: 'host:openai', oauthAccountKey: key },
            }, row.updated_at);
          } catch (error) {
            if (error?.code !== 'bot_revision_conflict') throw error;
            row = await repository.get({ id: row.id });
          }
        } else return binding;
      }
      if (row?.bot_id !== botId || !isHostOpenAiCredential(row)
        || row?.metadata?.connectionId !== 'host:openai' || row.metadata.oauthAccountKey !== key
        || row.status !== 'active') throw new OpenAiOAuthError(OPENAI_OAUTH_AUTHENTICATION, 401);
      if (migrate) await forgetLegacySecret(row);
      return binding;
    },
    async authState(row) {
      try {
        const binding = await this.resolve(row, { migrate: false });
        return coordinator.getAuthState(binding.accountId);
      } catch (error) { return error?.code === OPENAI_OAUTH_AUTHENTICATION ? 'reauth_required' : 'unavailable'; }
    },
    async reconnect(row, expectedUpdatedAt) {
      const metadata = bindingMetadata();
      const updated = await repository.updateIfRevision({ id: row.id, bot_id: row.bot_id }, {
        metadata: { ...row.metadata, ...metadata },
      }, expectedUpdatedAt);
      // Database binding commits first. Failure to erase a legacy sealed copy is
      // explicit and resumable; execution never uses it after the binding exists.
      await forgetLegacySecret(updated);
      return updated;
    },
    access: (accountId, credentialId = null) => requireCoordinator().access({ expectedAccountId: accountId, credentialId }),
  });
}
