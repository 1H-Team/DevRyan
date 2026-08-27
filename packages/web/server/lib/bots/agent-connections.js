import { randomUUID } from 'node:crypto';

import {
  AG_UI_CONNECTION_PROTOCOL_VERSION,
  createAgUiReasoningAdapter,
  normalizeAgUiConnectionDescriptor,
} from './ag-ui-reasoning-adapter.js';
import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

export class BotAgentConnectionError extends Error {
  constructor(message, code = 'bot_agent_connection_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotAgentConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotAgentConnectionError(message, code, statusCode);
};

const publicConnection = (row) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  name: row.name,
  endpointUrl: row.endpoint_url,
  protocolVersion: row.protocol_version,
  authMode: row.auth_mode,
  hasCredential: Boolean(row.credential_id),
  modelHint: row.model_hint || null,
  limits: Object.freeze(structuredClone(row.limits || {})),
  descriptorDigest: row.descriptor_digest,
  status: row.status,
  health: row.health ? Object.freeze(structuredClone(row.health)) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revokedAt: row.revoked_at || null,
});

const descriptorFromRow = (row) => normalizeAgUiConnectionDescriptor({
  id: row.id,
  botId: row.bot_id,
  endpointUrl: row.endpoint_url,
  protocolVersion: row.protocol_version,
  authMode: row.auth_mode,
  credentialId: row.credential_id,
  modelHint: row.model_hint,
  limits: row.limits,
  descriptorDigest: row.descriptor_digest,
  status: row.status,
  revokedAt: row.revoked_at,
});

const normalizeRequest = (value, { updating = false } = {}) => {
  try {
    assertExactObject(value, {
      label: 'Bot agent connection',
      required: updating
        ? ['name', 'endpointUrl', 'authMode', 'modelHint', 'limits', 'expectedUpdatedAt']
        : ['name', 'endpointUrl', 'authMode', 'modelHint', 'limits'],
      optional: ['bearer'],
    });
  } catch (error) {
    fail(error.message);
  }
  const authMode = value.authMode;
  if (!['none', 'bearer'].includes(authMode)
    || (authMode === 'none' && Object.hasOwn(value, 'bearer'))
    || (authMode === 'bearer' && !Object.hasOwn(value, 'bearer'))) {
    fail('Bot agent connection authentication is invalid');
  }
  let endpointUrl;
  try {
    endpointUrl = new URL(value.endpointUrl).href;
  } catch {
    fail('Bot agent endpoint URL is invalid');
  }
  const limits = validateBoundedJsonObject(value.limits, 'limits', 8 * 1024);
  const modelHint = value.modelHint === null || value.modelHint === ''
    ? null
    : validateBoundedString(value.modelHint, 'modelHint', { maximum: 256 });
  return Object.freeze({
    name: validateBoundedString(value.name, 'name', { maximum: 120 }),
    endpointUrl,
    authMode,
    bearer: authMode === 'bearer'
      ? validateBoundedString(value.bearer, 'bearer', {
          minimum: 1,
          maximum: 8_192,
          pattern: /^\S+$/u,
        })
      : null,
    modelHint,
    limits,
    expectedUpdatedAt: updating
      ? validateBoundedString(value.expectedUpdatedAt, 'expectedUpdatedAt', { maximum: 64 })
      : null,
  });
};

export function createBotAgentConnections({
  store,
  authorization,
  getCredentialVault,
  request,
  audit = async () => {},
  uuid = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!store?.repositories?.bot_agent_connections || !store.repositories?.bot_credentials
    || !authorization || typeof authorization.requireManager !== 'function'
    || typeof getCredentialVault !== 'function' || typeof request !== 'function'
    || typeof audit !== 'function' || typeof uuid !== 'function' || typeof now !== 'function') {
    throw new TypeError('Bot agent connection service is misconfigured');
  }

  const requireVault = () => {
    const vault = getCredentialVault();
    if (!vault || typeof vault.create !== 'function' || typeof vault.read !== 'function'
      || typeof vault.revoke !== 'function' || typeof vault.deleteCreated !== 'function'
      || typeof vault.toSupabaseRecord !== 'function') {
      fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
    }
    return vault;
  };

  const createBearer = async ({ botId, actorId, bearer, label }) => {
    const id = validateUuid(uuid(), 'credentialId');
    const vault = requireVault();
    await vault.create({
      id,
      botId,
      provider: 'ag_ui',
      kind: 'bearer',
      credentialScope: 'team',
      ownerUserId: null,
      createdBy: actorId,
      metadata: { label, maskedIdentifier: 'Bearer ••••' },
      secret: { type: 'bearer', token: bearer },
    });
    try {
      const persisted = vault.toSupabaseRecord(id);
      await store.repositories.bot_credentials.insert({
        id: persisted.id,
        bot_id: persisted.bot_id,
        provider: persisted.provider,
        kind: persisted.kind,
        credential_scope: persisted.credential_scope,
        owner_user_id: persisted.owner_user_id,
        local_vault_reference: persisted.local_vault_reference,
        metadata: persisted.metadata,
        status: persisted.status,
        created_by: persisted.created_by,
        revoked_at: persisted.revoked_at,
      });
      return id;
    } catch (error) {
      await vault.deleteCreated(id).catch(() => undefined);
      throw error;
    }
  };

  const resolveBearer = async (credentialId) => {
    const result = await requireVault().read(credentialId);
    if (result.credential.provider !== 'ag_ui' || result.credential.kind !== 'bearer'
      || result.secret?.type !== 'bearer' || typeof result.secret.token !== 'string') {
      fail('AG-UI bearer credential is invalid', 'bot_agent_connection_credential_unavailable', 409);
    }
    return result.secret.token;
  };

  const adapter = createAgUiReasoningAdapter({
    resolveConnection: async (connectionId) => {
      const row = await store.repositories.bot_agent_connections.get({
        id: validateUuid(connectionId, 'connectionId'),
      });
      if (!row) fail('Bot agent connection was not found', 'bot_agent_connection_not_found', 404);
      return descriptorFromRow(row);
    },
    resolveBearer,
    request,
  });

  const load = async (botId, connectionId) => {
    const row = await store.repositories.bot_agent_connections.get({
      id: validateUuid(connectionId, 'connectionId'),
      bot_id: validateUuid(botId, 'botId'),
    });
    if (!row) fail('Bot agent connection was not found', 'bot_agent_connection_not_found', 404);
    return row;
  };

  const recordHealth = async (row, health, status) => store.repositories.bot_agent_connections
    .updateIfRevision(
      { id: row.id, bot_id: row.bot_id },
      { status, health },
      row.updated_at,
    );

  const testRow = async (row) => {
    const checkedAt = now().toISOString();
    try {
      const result = await adapter.health({
        binding: {
          kind: 'ag_ui',
          connectionRef: row.id,
          connectionDigest: row.descriptor_digest,
          modelHint: row.model_hint,
        },
      });
      const updated = await recordHealth(row, {
        state: result.ok ? 'healthy' : 'failed',
        checkedAt,
        code: result.ok ? null : 'bot_agent_endpoint_unhealthy',
      }, result.ok ? 'active' : 'error');
      return Object.freeze({ connection: publicConnection(updated) });
    } catch (error) {
      const updated = await recordHealth(row, {
        state: 'failed',
        checkedAt,
        code: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'bot_agent_endpoint_failed',
      }, 'error').catch(() => row);
      return Object.freeze({ connection: publicConnection(updated) });
    }
  };

  return Object.freeze({
    adapter,
    resolveBearer,
    async resolve(connectionId) {
      const row = await store.repositories.bot_agent_connections.get({
        id: validateUuid(connectionId, 'connectionId'),
      });
      if (!row) fail('Bot agent connection was not found', 'bot_agent_connection_not_found', 404);
      return descriptorFromRow(row);
    },
    async list(principal, botId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const page = await store.repositories.bot_agent_connections.list({
        filters: { bot_id: normalizedBotId },
        limit: 100,
      });
      return Object.freeze({ connections: Object.freeze(page.items.map(publicConnection)) });
    },
    async create(principal, botId, requestValue) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const input = normalizeRequest(requestValue);
      const connectionId = validateUuid(uuid(), 'connectionId');
      const credentialId = input.authMode === 'bearer'
        ? await createBearer({
            botId: normalizedBotId,
            actorId: validateUuid(principal.id, 'principal.id'),
            bearer: input.bearer,
            label: `${input.name} AG-UI bearer`,
          })
        : null;
      const descriptor = normalizeAgUiConnectionDescriptor({
        id: connectionId,
        botId: normalizedBotId,
        endpointUrl: input.endpointUrl,
        protocolVersion: AG_UI_CONNECTION_PROTOCOL_VERSION,
        authMode: input.authMode,
        credentialId,
        modelHint: input.modelHint,
        limits: input.limits,
        status: 'active',
        revokedAt: null,
      });
      let row;
      try {
        row = await store.repositories.bot_agent_connections.insert({
          id: connectionId,
          bot_id: normalizedBotId,
          name: input.name,
          endpoint_url: descriptor.endpointUrl,
          protocol_version: descriptor.protocolVersion,
          auth_mode: descriptor.authMode,
          credential_id: credentialId,
          model_hint: descriptor.modelHint,
          limits: descriptor.limits,
          descriptor_digest: descriptor.descriptorDigest,
          status: 'active',
          health: null,
          created_by: validateUuid(principal.id, 'principal.id'),
          revoked_at: null,
        });
      } catch (error) {
        if (credentialId) {
          await requireVault().deleteCreated(credentialId).catch(() => undefined);
          await store.deleteCreated?.('bot_credentials', { id: credentialId }).catch(() => undefined);
        }
        throw error;
      }
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_agent_connection',
        targetId: row.id,
        action: 'bot.agent_connection.create',
        result: 'success',
        metadata: { authMode: row.auth_mode, protocolVersion: row.protocol_version },
      });
      return testRow(row);
    },
    async update(principal, botId, connectionId, requestValue) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const current = await load(normalizedBotId, connectionId);
      const input = normalizeRequest(requestValue, { updating: true });
      if (current.updated_at !== input.expectedUpdatedAt || current.status === 'revoked') {
        fail('Bot agent connection changed before update', 'bot_revision_conflict', 409);
      }
      const nextCredentialId = input.authMode === 'bearer'
        ? await createBearer({
            botId: normalizedBotId,
            actorId: validateUuid(principal.id, 'principal.id'),
            bearer: input.bearer,
            label: `${input.name} AG-UI bearer`,
          })
        : null;
      const descriptor = normalizeAgUiConnectionDescriptor({
        id: current.id,
        botId: current.bot_id,
        endpointUrl: input.endpointUrl,
        protocolVersion: AG_UI_CONNECTION_PROTOCOL_VERSION,
        authMode: input.authMode,
        credentialId: nextCredentialId,
        modelHint: input.modelHint,
        limits: input.limits,
        status: 'active',
        revokedAt: null,
      });
      let updated;
      try {
        updated = await store.repositories.bot_agent_connections.updateIfRevision(
          { id: current.id, bot_id: current.bot_id },
          {
            name: input.name,
            endpoint_url: descriptor.endpointUrl,
            auth_mode: descriptor.authMode,
            credential_id: nextCredentialId,
            model_hint: descriptor.modelHint,
            limits: descriptor.limits,
            descriptor_digest: descriptor.descriptorDigest,
            status: 'active',
            health: null,
          },
          current.updated_at,
        );
      } catch (error) {
        if (nextCredentialId) {
          await requireVault().deleteCreated(nextCredentialId).catch(() => undefined);
          await store.deleteCreated?.('bot_credentials', { id: nextCredentialId }).catch(() => undefined);
        }
        throw error;
      }
      if (current.credential_id) {
        const revokedAt = now().toISOString();
        await requireVault().revoke(current.credential_id).catch(() => undefined);
        const prior = await store.repositories.bot_credentials.get({ id: current.credential_id });
        if (prior) await store.repositories.bot_credentials.updateIfRevision(
          { id: prior.id },
          { status: 'revoked', revoked_at: revokedAt },
          prior.updated_at,
        ).catch(() => undefined);
      }
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_agent_connection',
        targetId: updated.id,
        action: 'bot.agent_connection.update',
        result: 'success',
        metadata: { authMode: updated.auth_mode, protocolVersion: updated.protocol_version },
      });
      return testRow(updated);
    },
    async test(principal, botId, connectionId) {
      await authorization.requireManager(principal, validateUuid(botId, 'botId'));
      return testRow(await load(botId, connectionId));
    },
    async revoke(principal, botId, connectionId, requestValue) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      try {
        assertExactObject(requestValue, {
          label: 'Bot agent connection revocation',
          required: ['expectedUpdatedAt'],
        });
      } catch (error) {
        fail(error.message);
      }
      const row = await load(normalizedBotId, connectionId);
      if (row.updated_at !== requestValue.expectedUpdatedAt) {
        fail('Bot agent connection changed before revocation', 'bot_revision_conflict', 409);
      }
      if (row.status === 'revoked') return Object.freeze({ connection: publicConnection(row) });
      const revokedAt = now().toISOString();
      const updated = await store.repositories.bot_agent_connections.updateIfRevision(
        { id: row.id, bot_id: row.bot_id },
        {
          status: 'revoked',
          revoked_at: revokedAt,
          health: { state: 'revoked', checkedAt: revokedAt, code: 'bot_agent_connection_revoked' },
        },
        row.updated_at,
      );
      if (row.credential_id) {
        await requireVault().revoke(row.credential_id);
        const credential = await store.repositories.bot_credentials.get({ id: row.credential_id });
        if (credential) await store.repositories.bot_credentials.updateIfRevision(
          { id: credential.id },
          { status: 'revoked', revoked_at: revokedAt },
          credential.updated_at,
        );
      }
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_agent_connection',
        targetId: row.id,
        action: 'bot.agent_connection.revoke',
        result: 'success',
        metadata: {},
      });
      return Object.freeze({ connection: publicConnection(updated) });
    },
    async preflightRevision({ bot, contract }) {
      if (contract?.agent?.kind !== 'ag_ui') {
        return Object.freeze({ id: 'agent', label: 'Reasoning adapter', status: 'pass', detail: 'OpenCode adapter.' });
      }
      const row = await load(bot.id, contract.agent.connectionRef);
      if (row.status === 'revoked' || row.revoked_at || row.descriptor_digest !== contract.agent.connectionDigest) {
        return Object.freeze({
          id: 'agent', label: 'Reasoning adapter', status: 'fail',
          detail: 'The selected AG-UI connection is revoked or changed.',
        });
      }
      const tested = await testRow(row);
      return Object.freeze({
        id: 'agent',
        label: 'Reasoning adapter',
        status: tested.connection.health?.state === 'healthy' ? 'pass' : 'fail',
        detail: tested.connection.health?.state === 'healthy'
          ? 'AG-UI endpoint is healthy and digest-bound.'
          : 'AG-UI endpoint health check failed.',
      });
    },
  });
}

export { publicConnection as publicBotAgentConnection };
