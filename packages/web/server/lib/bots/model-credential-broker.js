import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { canonicalizeBotJson } from '@openchamber/bots-runtime';

import {
  readProviderAuthRecord,
  readScopedProviderAuthRecord,
  writeScopedProviderAuthRecord,
} from '../opencode/auth.js';
import { validateBotModelPolicy } from './config-compiler.js';
import { resolveReviewedBotModelEgressHosts } from './model-catalog.js';
import { createHostOAuthConnections, isHostOpenAiCredential } from './host-oauth-connections.js';
import { validateUuid } from './validation.js';

const MODEL_UNAVAILABLE = 'bot_model_unavailable';
const MODEL_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORBIDDEN_MODEL_HOSTS = new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  'localhost',
  'metadata',
  'metadata.google.internal',
]);
const CANDIDATE_UNAVAILABLE_CODES = new Set([
  MODEL_UNAVAILABLE,
  'bot_model_egress_invalid',
  'bot_credential_not_found',
  'bot_credential_revoked',
]);

export class BotModelCredentialError extends Error {
  constructor(message, code = MODEL_UNAVAILABLE, statusCode = 503) {
    super(message);
    this.name = 'BotModelCredentialError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code = MODEL_UNAVAILABLE, statusCode = 503) => {
  throw new BotModelCredentialError(message, code, statusCode);
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
);

const isValidModelHostname = (hostname) => (
  hostname.length <= 253
  && !hostname.includes('..')
  && hostname.split('.').every((label) => (
    label.length <= 63 && MODEL_HOST_LABEL_PATTERN.test(label)
  ))
);

const normalizeRun = (run, { requireUpdatedAt = true } = {}) => {
  const fields = [
    'botId',
    'channelId',
    'id',
    'ownerUserId',
    'revisionId',
  ];
  const keys = isPlainObject(run) ? Object.keys(run) : [];
  if (!isPlainObject(run)
    || fields.some((field) => !keys.includes(field))
    || keys.some((field) => !fields.includes(field) && field !== 'updatedAt')
    || (requireUpdatedAt && !keys.includes('updatedAt'))) {
    fail('Bot model selection run is invalid', 'bot_model_selection_invalid', 400);
  }
  const updatedAt = requireUpdatedAt && typeof run.updatedAt === 'string' ? run.updatedAt : null;
  if (requireUpdatedAt && !Number.isFinite(Date.parse(updatedAt))) {
    fail('Bot model selection run revision is invalid', 'bot_model_selection_invalid', 400);
  }
  return Object.freeze({
    id: validateUuid(run.id, 'run.id'),
    botId: validateUuid(run.botId, 'run.botId'),
    channelId: validateUuid(run.channelId, 'run.channelId'),
    revisionId: validateUuid(run.revisionId, 'run.revisionId'),
    ownerUserId: validateUuid(run.ownerUserId, 'run.ownerUserId'),
    ...(requireUpdatedAt ? { updatedAt } : {}),
  });
};

const normalizeCatalog = (catalog) => {
  const entries = [];
  const providerModels = (provider, providerId) => {
    if (Array.isArray(provider?.models)) {
      return provider.models.map((model) => ({ ...model, providerId }));
    }
    if (isPlainObject(provider?.models)) {
      return Object.entries(provider.models).map(([modelId, model]) => ({
        ...model,
        providerId,
        modelId: model?.modelId || model?.modelID || model?.id || modelId,
      }));
    }
    return [];
  };
  if (Array.isArray(catalog)) {
    entries.push(...catalog);
  } else if (isPlainObject(catalog) && Array.isArray(catalog.models)) {
    entries.push(...catalog.models);
  } else if (isPlainObject(catalog) && Array.isArray(catalog.providers)) {
    for (const provider of catalog.providers) {
      const providerId = provider?.id || provider?.providerId;
      entries.push(...providerModels(provider, providerId));
    }
  } else if (isPlainObject(catalog)) {
    for (const [providerId, provider] of Object.entries(catalog)) {
      entries.push(...providerModels(provider, providerId));
    }
  } else {
    fail('Bot model catalog is invalid', 'bot_model_catalog_invalid', 503);
  }
  const normalized = [];
  for (const entry of entries) {
    const providerId = typeof entry?.providerId === 'string'
      ? entry.providerId
      : (typeof entry?.providerID === 'string' ? entry.providerID : '');
    const modelId = typeof entry?.modelId === 'string'
      ? entry.modelId
      : (typeof entry?.modelID === 'string' ? entry.modelID : (typeof entry?.id === 'string' ? entry.id : ''));
    if (!providerId || !modelId || entry.available === false || entry.enabled === false) continue;
    normalized.push(Object.freeze({
      providerId,
      modelId,
      egressHosts: Array.isArray(entry.egressHosts) ? [...entry.egressHosts] : null,
      contextLimit: Number.isFinite(Number(entry.contextLimit || entry.limit?.context))
        && Number(entry.contextLimit || entry.limit?.context) > 0
        ? Number(entry.contextLimit || entry.limit?.context)
        : null,
    }));
  }
  return normalized;
};

const normalizeAuthority = (value) => {
  if (typeof value !== 'string' || !value || value.length > 2_048
    || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail('Bot model egress host is invalid', 'bot_model_egress_invalid', 503);
  }
  let parsed;
  try {
    parsed = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    fail('Bot model egress host is invalid', 'bot_model_egress_invalid', 503);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const addressFamily = net.isIP(hostname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || port !== 443 || !hostname || FORBIDDEN_MODEL_HOSTS.has(hostname)
    || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || (!addressFamily && (!hostname.includes('.') || !isValidModelHostname(hostname)))) {
    fail('Bot model egress host is invalid', 'bot_model_egress_invalid', 503);
  }
  if (addressFamily) {
    fail('Bot model egress hosts must use reviewed DNS names', 'bot_model_egress_invalid', 503);
  }
  return `${hostname}:443`;
};

export const validateBotModelEgressHosts = (candidateHosts, catalogHosts = null) => {
  const normalized = candidateHosts.map(normalizeAuthority);
  if (new Set(normalized).size !== normalized.length) {
    fail('Bot model egress hosts contain duplicates', 'bot_model_egress_invalid', 503);
  }
  if (catalogHosts !== null) {
    const expected = catalogHosts.map(normalizeAuthority).sort();
    if (normalized.slice().sort().join('\0') !== expected.join('\0')) {
      fail('Bot model egress hosts do not match the catalog', 'bot_model_egress_invalid', 503);
    }
  }
  return Object.freeze(normalized);
};

const safeRemoveDirectory = async (directory, fsPromises) => {
  try {
    await fsPromises.chmod(directory, 0o700);
  } catch {
  }
  await fsPromises.rm(directory, { recursive: true, force: true });
};

const isVaultMiss = (error) => error?.code === 'bot_credential_not_found';
const isCandidateUnavailable = (error) => CANDIDATE_UNAVAILABLE_CODES.has(error?.code);

const selectedSnapshot = ({ candidate, candidateIndex, egressHosts, now }) => Object.freeze({
  providerId: candidate.providerId,
  modelId: candidate.modelId,
  variant: candidate.variant || null,
  candidateIndex,
  egressHosts: [...egressHosts],
  contextLimit: candidate.contextLimit || null,
  selectedAt: now().toISOString(),
});

export function createBotModelCredentialBroker({
  dataDirectory,
  credentialVault,
  store = null,
  oauthCoordinator = null,
  recordSelectedModel = null,
  readHostProviderAuth = readProviderAuthRecord,
  writeScopedAuth = writeScopedProviderAuthRecord,
  readScopedAuth = readScopedProviderAuthRecord,
  validateEgressHosts = validateBotModelEgressHosts,
  fsPromises = fs,
  now = () => new Date(),
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || !credentialVault || typeof credentialVault.read !== 'function'
    || typeof credentialVault.rotate !== 'function'
    || typeof credentialVault.create !== 'function'
    || typeof readHostProviderAuth !== 'function'
    || typeof writeScopedAuth !== 'function'
    || typeof readScopedAuth !== 'function'
    || typeof validateEgressHosts !== 'function'
    || typeof now !== 'function') {
    fail('Bot model credential broker is misconfigured', 'bot_model_broker_invalid', 500);
  }
  const runRepository = store?.repositories?.bot_runs;
  const credentialRepository = store?.repositories?.bot_credentials;
  const oauthConnections = createHostOAuthConnections({ coordinator: oauthCoordinator,
    repository: credentialRepository, vault: credentialVault });
  const recordModel = typeof recordSelectedModel === 'function'
    ? recordSelectedModel
    : (runRepository?.updateIfRevision
        ? ({ run, snapshot }) => runRepository.updateIfRevision(
            { id: run.id },
            { model_snapshot: snapshot },
            run.updatedAt,
          )
        : null);
  if (!recordModel) fail('Bot model recorder is unavailable', 'bot_model_broker_invalid', 500);

  const authRoot = path.join(dataDirectory, 'bots', 'runtime', 'auth');
  const activeRuns = new Map();

  const readCredential = async ({ candidate, run }) => {
    let credentialRow = null;
    if (credentialRepository?.get) {
      credentialRow = await credentialRepository.get({ id: candidate.credentialId });
      if (!credentialRow || credentialRow.status !== 'active'
        || credentialRow.bot_id !== run.botId || credentialRow.provider !== candidate.providerId
        || (credentialRow.credential_scope === 'team' && credentialRow.owner_user_id !== null)
        || (credentialRow.credential_scope === 'user' && credentialRow.owner_user_id !== run.ownerUserId)
        || !['team', 'user'].includes(credentialRow.credential_scope)) {
        fail('Bot model credential is unavailable');
      }
    }

    if (isHostOpenAiCredential(credentialRow)) {
      const binding = await oauthConnections.resolve(credentialRow);
      await oauthConnections.access(binding.accountId, candidate.credentialId);
      return { authType: 'oauth', accountId: binding.accountId,
        // A non-secret discriminator keeps OpenCode's OAuth model metadata.
        // Only the coordinated transport may authenticate provider requests.
        secret: { type: 'oauth', access: '', refresh: '', expires: 0, accountId: binding.accountId },
        hostOAuth: true };
    }

    try {
      const stored = await credentialVault.read(candidate.credentialId);
      if (stored?.credential?.botId !== run.botId
        || stored?.credential?.provider !== candidate.providerId
        || stored?.credential?.status !== 'active'
        || !isPlainObject(stored.secret)) {
        fail('Bot model credential is unavailable');
      }
      if (candidate.providerId === 'openai' && stored.secret.type === 'oauth') {
        fail('A bound host OAuth connection is required', 'bot_oauth_coordinator_unavailable');
      }
      return {
        secret: stored.secret,
        authType: stored.credential.kind || stored.secret.type || credentialRow?.kind || null,
      };
    } catch (error) {
      if (!isVaultMiss(error) || !credentialRow) throw error;
    }

    const selectedHostRecord = readHostProviderAuth(candidate.providerId);
    if (!isPlainObject(selectedHostRecord)) fail('Bot model credential is unavailable');
    if (candidate.providerId === 'openai' && selectedHostRecord.type === 'oauth') {
      fail('A bound host OAuth connection is required', 'bot_oauth_coordinator_unavailable');
    }
    try {
      await credentialVault.create({
        id: candidate.credentialId,
        botId: run.botId,
        provider: candidate.providerId,
        kind: credentialRow.kind,
        credentialScope: credentialRow.credential_scope,
        ownerUserId: credentialRow.owner_user_id,
        createdBy: credentialRow.created_by,
        metadata: credentialRow.metadata || {},
        secret: selectedHostRecord,
      });
    } catch (error) {
      if (error?.code !== 'bot_credential_exists') throw error;
      const stored = await credentialVault.read(candidate.credentialId);
      return {
        secret: stored.secret,
        authType: stored.credential.kind || stored.secret.type || credentialRow.kind,
      };
    }
    return { secret: selectedHostRecord, authType: credentialRow.kind || selectedHostRecord.type };
  };

  const choose = async ({ run, models, catalog }) => {
    const candidates = [models.primary, ...models.fallbacks];
    const catalogEntries = normalizeCatalog(catalog);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const catalogEntry = catalogEntries.find((entry) => (
        entry.providerId === candidate.providerId && entry.modelId === candidate.modelId
      ));
      if (!catalogEntry) continue;
      try {
        const credential = await readCredential({ candidate, run });
        const reviewedEgressHosts = resolveReviewedBotModelEgressHosts({
          providerId: candidate.providerId,
          authType: credential.authType,
          catalogHosts: catalogEntry.egressHosts,
        });
        const egressHosts = await validateEgressHosts(candidate.egressHosts, reviewedEgressHosts);
        return {
          candidate: {
            ...candidate,
            contextLimit: catalogEntry.contextLimit,
          },
          candidateIndex,
          egressHosts,
          secret: credential.secret,
          authType: credential.authType,
          hostOAuth: credential.hostOAuth === true,
          accountId: credential.accountId,
        };
      } catch (error) {
        if (!isCandidateUnavailable(error)) throw error;
      }
    }
    fail('No configured Bot model is currently available');
  };

  const materializeRun = async ({ rawRun, rawModels, catalog, provisional }) => {
    const run = normalizeRun(rawRun, { requireUpdatedAt: provisional !== true });
    let models;
    try {
      models = validateBotModelPolicy(rawModels);
    } catch (error) {
      fail(error.message, 'bot_model_selection_invalid', 400);
    }
    if (activeRuns.has(run.id)) {
      fail('Bot run credentials are already materialized', 'bot_run_already_prepared', 409);
    }
    const selection = await choose({ run, models, catalog });
    const authDirectory = path.join(authRoot, run.id);
    await safeRemoveDirectory(authDirectory, fsPromises);
    await fsPromises.mkdir(authRoot, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(authRoot, 0o700);
    try {
      await writeScopedAuth({
        directory: authDirectory,
        providerId: selection.candidate.providerId,
        record: selection.secret,
        fsPromises,
      });
      const snapshot = selectedSnapshot({ ...selection, now });
      if (!provisional) await recordModel({ run, snapshot });
      const metadata = {
        runId: run.id,
        providerId: selection.candidate.providerId,
        credentialId: selection.candidate.credentialId,
        authDirectory,
        provisional: provisional === true,
        hostOAuth: selection.hostOAuth === true,
        accountId: selection.accountId,
        run,
        candidate: selection.candidate,
      };
      activeRuns.set(run.id, metadata);
      return Object.freeze({
        authDirectory,
        model: Object.freeze({
          providerId: selection.candidate.providerId,
          modelId: selection.candidate.modelId,
          variant: selection.candidate.variant || null,
        }),
        credentialId: selection.candidate.credentialId,
        coordinatedOAuth: selection.hostOAuth === true,
        egressHosts: selection.egressHosts,
        chatgptImageGeneration: selection.candidate.providerId === 'openai'
          && selection.authType === 'oauth',
        modelSnapshot: snapshot,
        provisional: provisional === true,
      });
    } catch (error) {
      await safeRemoveDirectory(authDirectory, fsPromises);
      throw error;
    }
  };

  return Object.freeze({
    authRoot,
    oauthConnections,
    async runtimeOAuth(claims, operation) {
      const active = activeRuns.get(claims.runId);
      if (!active || claims.kind !== 'reasoning' || claims.botId !== active.run.botId
        || claims.channelId !== active.run.channelId || claims.revisionId !== active.run.revisionId) {
        fail('Bot OAuth scope is invalid', 'bot_oauth_access_denied', 403);
      }
      if (operation === 'ready') {
        active.runtimeReady = true;
        return { protocol: 1, oauth: active.hostOAuth };
      }
      if (!active.hostOAuth) fail('Bot OAuth is unavailable', 'bot_oauth_access_denied', 403);
      const current = await readCredential({ run: active.run, candidate: active.candidate });
      if (!current.hostOAuth || current.accountId !== active.accountId) fail('Bot connection changed', 'bot_opencode_provider_authentication', 401);
      if (activeRuns.get(claims.runId) !== active) fail('Bot OAuth scope is invalid', 'bot_oauth_access_denied', 403);
      return oauthConnections.access(active.accountId, active.credentialId);
    },
    async assertRuntimeReady(runId) {
      const active = activeRuns.get(runId);
      if (!active?.hostOAuth) return;
      if (!active.runtimeReady) fail('Update the Bot runtime to enable coordinated OAuth', 'bot_oauth_runtime_update_required');
      await this.runtimeOAuth({ runId, botId: active.run.botId, channelId: active.run.channelId,
        revisionId: active.run.revisionId, kind: 'reasoning' }, 'access');
    },
    async preflightRun({ run: rawRun, models: rawModels, catalog } = {}) {
      const run = normalizeRun(rawRun, { requireUpdatedAt: false });
      let models;
      try {
        models = validateBotModelPolicy(rawModels);
      } catch (error) {
        fail(error.message, 'bot_model_selection_invalid', 400);
      }
      const selection = await choose({ run, models, catalog });
      const snapshot = selectedSnapshot({ ...selection, now });
      return Object.freeze({
        model: Object.freeze({
          providerId: selection.candidate.providerId,
          modelId: selection.candidate.modelId,
          variant: selection.candidate.variant || null,
        }),
        credentialId: selection.candidate.credentialId,
        egressHosts: selection.egressHosts,
        chatgptImageGeneration: selection.candidate.providerId === 'openai'
          && selection.authType === 'oauth',
        modelSnapshot: snapshot,
      });
    },

    async prepareRun({ run, models, catalog } = {}) {
      return materializeRun({ rawRun: run, rawModels: models, catalog, provisional: false });
    },

    async prepareProvisionalRun({ run, models, catalog } = {}) {
      return materializeRun({ rawRun: run, rawModels: models, catalog, provisional: true });
    },

    async finalizeRun(runId) {
      const normalizedRunId = validateUuid(runId, 'runId');
      const active = activeRuns.get(normalizedRunId);
      if (!active) return Object.freeze({ removed: false, refreshed: false });
      activeRuns.delete(normalizedRunId);
      let failure = null;
      let refreshed = false;
      try {
        if (!active.hostOAuth) {
          const refreshedRecord = await readScopedAuth({
            directory: active.authDirectory,
            providerId: active.providerId,
            fsPromises,
          });
          await credentialVault.rotate(active.credentialId, refreshedRecord);
          refreshed = true;
        }
      } catch (error) {
        failure = error;
      } finally {
        try {
          await safeRemoveDirectory(active.authDirectory, fsPromises);
        } catch (error) {
          failure ||= error;
        }
      }
      if (failure) {
        const digest = crypto.createHash('sha256')
          .update(canonicalizeBotJson({ runId: normalizedRunId, providerId: active.providerId }))
          .digest('hex');
        const error = new BotModelCredentialError(
          'Scoped Bot model credentials could not be finalized',
          'bot_credential_refresh_ingest_failed',
          500,
        );
        error.correlationDigest = digest;
        throw error;
      }
      return Object.freeze({ removed: true, refreshed });
    },

    async discardRun(runId) {
      const normalizedRunId = validateUuid(runId, 'runId');
      const active = activeRuns.get(normalizedRunId);
      if (!active) return false;
      activeRuns.delete(normalizedRunId);
      await safeRemoveDirectory(active.authDirectory, fsPromises);
      return true;
    },

    getActiveRunCount: () => activeRuns.size,
  });
}
