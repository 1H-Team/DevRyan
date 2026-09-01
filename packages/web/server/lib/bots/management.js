import { randomUUID } from 'node:crypto';

import { hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { readProviderAuthRecord } from '../opencode/auth.js';
import {
  BOT_CURRENT_GATEWAY_PLUGIN_VERSION,
  BOT_FILE_TOOLS,
  BOT_RUNTIME_TOOLS,
  validateBotRevisionRuntimeContract,
} from './config-compiler.js';
import { sanitizeBotCredentialMetadata } from './credential-vault.js';
import { isHostOpenAiCredential } from './host-oauth-connections.js';
import { decryptBotJson, encryptBotJson } from './encryption.js';
import { sanitizeBotModelOptions } from './model-catalog.js';
import { buildStarterSoul } from './soul-template.js';
import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateOptionalUuid,
  validateUuid,
} from './validation.js';

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const BOT_ROLES = Object.freeze(['member', 'operator', 'manager']);
const BOT_TENANCIES = Object.freeze(['team', 'personalized']);
const LIFECYCLE_TRANSITIONS = Object.freeze({
  active: Object.freeze(['paused', 'retired']),
  paused: Object.freeze(['active', 'retired']),
});

export class BotManagementError extends Error {
  constructor(message, code = 'bot_management_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotManagementError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotManagementError(message, code, statusCode, details);
};

const publicBot = (row) => Object.freeze({
  id: row.id,
  name: row.name,
  title: row.title || row.name,
  summary: row.summary || '',
  avatarUrl: row.avatar_object_id
    ? `/api/bots/${row.id}/avatar?v=${encodeURIComponent(row.updated_at)}`
    : null,
  avatarFallback: row.avatar_fallback || null,
  lifecycle: row.lifecycle,
  tenancy: row.tenancy,
  activeRevisionId: row.active_revision_id || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  retiredAt: row.retired_at || null,
});

const publicRevision = (row, includeContract = false) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  revisionNumber: Number(row.revision_number),
  compiledHash: row.compiled_hash,
  specHash: row.spec_hash || null,
  hasPortableSpec: Boolean(row.portable_spec),
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  activatedAt: row.activated_at || null,
  retiredAt: row.retired_at || null,
  ...(includeContract ? { contract: structuredClone(row.contract) } : {}),
});

// A member is a person, so the projection carries the name and email a Manager
// would recognize. The profile is optional: an unresolvable id still returns a
// usable membership rather than failing the whole detail load.
const publicMembership = (row, profile = null) => Object.freeze({
  botId: row.bot_id,
  userId: row.user_id,
  displayName: typeof profile?.display_name === 'string' && profile.display_name.trim()
    ? profile.display_name.trim()
    : null,
  email: typeof profile?.email === 'string' && profile.email.trim()
    ? profile.email.trim()
    : null,
  role: row.role,
  assignedBy: row.assigned_by,
  activatedAt: row.activated_at,
  revokedAt: row.revoked_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const publicCredentialLabel = (row) => {
  const label = typeof row.metadata?.label === 'string' ? row.metadata.label.trim() : '';
  return label.length > 0 && label.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(label)
    ? label
    : row.provider;
};

const publicMaskedCredentialIdentifier = (row) => {
  const masked = row.metadata?.maskedIdentifier;
  return typeof masked === 'string' && /^••••\S{4}$/u.test(masked) ? masked : null;
};

const publicCredential = (row, authState = 'unknown') => Object.freeze({
  id: row.id,
  provider: row.provider,
  label: publicCredentialLabel(row),
  kind: row.kind,
  scope: row.credential_scope,
  maskedIdentifier: publicMaskedCredentialIdentifier(row),
  status: row.status,
  authState,
  version: Number.isSafeInteger(Number(row.metadata?.secretVersion))
    && Number(row.metadata?.secretVersion) > 0
    ? Number(row.metadata.secretVersion)
    : 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  rotatedAt: typeof row.metadata?.rotatedAt === 'string'
    && Number.isFinite(Date.parse(row.metadata.rotatedAt))
    ? row.metadata.rotatedAt
    : null,
});

const publicEvalRun = (row) => Object.freeze({
  id: row.id,
  evalCaseId: row.eval_case_id,
  revisionId: row.revision_id,
  mode: row.mode,
  state: row.state,
  result: row.result ? structuredClone(row.result) : null,
  initiatedBy: row.initiated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at || null,
  finishedAt: row.finished_at || null,
});

// Every Bot runs one shared computer. Callers may still send a tenancy; it is
// validated and then collapsed so no Bot can be created on a per-member scope.
const normalizeTenancy = (value) => {
  if (value !== undefined && !BOT_TENANCIES.includes(value)) fail('Bot tenancy is invalid');
  return 'team';
};

const normalizeRole = (value) => {
  if (!BOT_ROLES.includes(value)) fail('Bot membership role is invalid');
  return value;
};

const normalizeContract = (value) => {
  try {
    return validateBotRevisionRuntimeContract(value);
  } catch (error) {
    if (error?.code) throw error;
    fail(error instanceof Error ? error.message : 'Bot revision contract is invalid');
  }
};

const normalizeManagementContract = (value) => {
  const contract = normalizeContract({
    ...value,
    skillBindings: value?.skillBindings ?? [],
    mcpBindings: value?.mcpBindings ?? [],
  });
  if (!contract.identity.title) {
    fail('Bot identity title is required', 'bot_revision_contract_invalid', 400);
  }
  if (contract.objectives.length === 0) {
    fail('At least one Bot objective is required', 'bot_revision_contract_invalid', 400);
  }
  return contract;
};

const applyCapabilityFirstCreationDefaults = (value) => {
  if (value?.contractVersion === 3 && value?.agent?.kind !== 'opencode') {
    fail(
      'New Bots always run through OpenCode',
      'bot_agent_must_use_opencode',
      400,
    );
  }
  const browserPolicy = {
    allowedOrigins: [],
    deniedOrigins: [],
    ...(value?.contractVersion === 3
      ? { networkAccess: { mode: 'public_only', hosts: [] } }
      : {}),
  };
  return {
    ...value,
    fileTools: [...BOT_FILE_TOOLS],
    runtimeTools: [...BOT_RUNTIME_TOOLS],
    operatingInstructions: '',
    prohibitedInstructions: '',
    advancedPrompt: '',
    mcpBindings: [],
    actionPolicy: {
      defaultEffect: 'allow',
      defaultRisk: 'low',
      rules: [],
    },
    browserPolicy,
    ...(value?.contractVersion === 3
      ? { computerPolicy: { isolationTier: 'standard' } }
      : {}),
  };
};

const migrateLegacyReasoningVariants = (value, modelOptions) => {
  const effort = typeof value?.reasoning?.effort === 'string'
    ? value.reasoning.effort.trim()
    : '';
  if (!effort || !value?.models || !Array.isArray(modelOptions?.providers)) return value;
  let fullyMigrated = true;
  const migrateBinding = (binding) => {
    if (!binding || binding.variant !== undefined) return binding;
    const provider = modelOptions.providers.find((entry) => entry.id === binding.providerId);
    const model = provider?.models.find((entry) => entry.id === binding.modelId);
    const supported = model?.variants.some((variant) => variant.id === effort && variant.available);
    if (!supported) {
      fullyMigrated = false;
      return binding;
    }
    return { ...binding, variant: effort };
  };
  const primary = migrateBinding(value.models.primary);
  const fallbacks = Array.isArray(value.models.fallbacks)
    ? value.models.fallbacks.map(migrateBinding)
    : value.models.fallbacks;
  const reasoning = { ...value.reasoning };
  if (fullyMigrated) delete reasoning.effort;
  return {
    ...value,
    models: { ...value.models, primary, fallbacks },
    reasoning,
  };
};

const skillBindingsFor = (contract) => Object.freeze({
  skillBindings: structuredClone(contract?.skillBindings ?? []),
});

const assertSkillBindingsMatch = (candidate, expected) => {
  if (hashCanonicalBotJson(skillBindingsFor(candidate))
    !== hashCanonicalBotJson(skillBindingsFor(expected))) {
    fail(
      'Skill assignments must be changed from the Bot Resources screen',
      'bot_capability_binding_mutation_required',
      409,
    );
  }
};

const normalizeExpectedRevision = (value, field = 'expectedUpdatedAt') => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${field} is required`, 'bot_revision_required', 400);
  }
  return value;
};

const evalCaseAssociatedData = (botId, evalCaseId) => (
  `devryan:bot-eval-case:${validateUuid(botId, 'botId')}:${validateUuid(evalCaseId, 'evalCaseId')}`
);

const isGlobalAdminByDefault = (principal) => (
  principal?.role === 'admin'
  && (principal?.scope === 'managed' || principal?.scope === 'local-admin')
);

const activeMembership = (row) => Boolean(row && row.revoked_at === null);

const runtimeReadinessDetail = (capabilities) => {
  if (capabilities.available) {
    return 'Electron verified the bundled runtime image digests.';
  }
  if (capabilities.state === 'docker_stopped') {
    return 'Docker Desktop is not running. Start Docker, then publish again.';
  }
  if (capabilities.state === 'docker_not_installed') {
    return 'Docker Desktop is required before this Bot can be published.';
  }
  if (capabilities.state === 'setup_required') {
    return 'The bundled Bot runtime needs to be set up.';
  }
  if (capabilities.state === 'image_update_available') {
    return 'The bundled Bot runtime needs to be updated.';
  }
  if (capabilities.state === 'index_rebuilding') {
    return 'The Bot retrieval index is still being prepared.';
  }
  if (capabilities.state === 'unsupported_host') {
    return 'Bot runtime setup is available only in the local DevRyan desktop app.';
  }
  const runtimeIssue = capabilities.runtime?.issues?.[0]?.message;
  if (typeof runtimeIssue === 'string' && runtimeIssue.trim()) return runtimeIssue.trim();
  return `Runtime state: ${capabilities.state || capabilities.code || 'unavailable'}.`;
};

export function createBotManagement({
  store,
  authorization,
  encryption,
  audit = async () => {},
  isGlobalAdmin = isGlobalAdminByDefault,
  resolveCapabilities = async () => ({ available: false, state: 'runtime_unavailable' }),
  preflightModel = async () => fail(
    'Bot model validation is unavailable',
    'bot_model_unavailable',
    503,
  ),
  preflightCapabilities = async () => Object.freeze({
    skills: Object.freeze({ count: 0, materialized: true, error: null }),
    mcp: Object.freeze([]),
    mcpReady: true,
    mcpError: null,
  }),
  preflightAgent = async () => Object.freeze({
    id: 'agent',
    label: 'Reasoning adapter',
    status: 'pass',
    detail: 'OpenCode adapter.',
  }),
  preflightComputer = async () => Object.freeze({
    id: 'computer',
    label: 'Computer isolation',
    status: 'pass',
    detail: 'Standard container isolation is available.',
  }),
  getCredentialVault = () => null,
  getOAuthConnections = async () => null,
  readHostProviderAuth = readProviderAuthRecord,
  eventStream = null,
  blobStore = null,
  loadModelCatalog = async () => fail(
    'Bot model catalog is unavailable',
    'bot_model_catalog_unavailable',
    503,
  ),
  testRunner = Object.freeze({
    run: async ({ mode, writeMode, computerScopeKey }) => ({
      passed: true,
      mode,
      writeMode,
      computerScopeKey,
      summary: mode === 'simulation'
        ? 'Draft simulation completed with every external write replaced by a simulated receipt.'
        : 'Live canary policy admission completed.',
    }),
  }),
  beforeActivateComputer = async () => null,
  afterDeactivateComputer = async () => null,
  onRuntimeInvalidated = () => {},
  uuid = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.list !== 'function'
    || typeof store.createBot !== 'function' || typeof store.activateRevision !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || typeof audit !== 'function'
    || typeof isGlobalAdmin !== 'function' || typeof resolveCapabilities !== 'function'
    || typeof preflightModel !== 'function' || typeof preflightCapabilities !== 'function'
    || typeof preflightAgent !== 'function' || typeof preflightComputer !== 'function'
    || typeof getCredentialVault !== 'function'
    || typeof readHostProviderAuth !== 'function'
    || (eventStream !== null && typeof eventStream?.publish !== 'function')
    || typeof loadModelCatalog !== 'function'
    || typeof testRunner?.run !== 'function'
    || typeof beforeActivateComputer !== 'function'
    || typeof afterDeactivateComputer !== 'function'
    || typeof onRuntimeInvalidated !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function') {
    throw new TypeError('Bot management is misconfigured');
  }

  const requirePrincipal = (principal) => {
    if (!principal?.id) fail('Authentication required', 'bot_authentication_required', 401);
    return principal;
  };

  const requireGlobalAdmin = (principal) => {
    requirePrincipal(principal);
    if (!isGlobalAdmin(principal)) {
      fail('Global administrator access is required', 'bot_global_admin_required', 403);
    }
    return principal;
  };

  const loadBot = async (botId) => {
    const id = validateUuid(botId, 'botId');
    const row = await store.get('bots', { id });
    if (!row) fail('Bot not found', 'bot_not_found', 404);
    return row;
  };

  const managerDecision = async (principal, botId) => {
    requirePrincipal(principal);
    return authorization.requireManager(principal, validateUuid(botId, 'botId'));
  };

  const readDecision = async (principal, botId) => {
    requirePrincipal(principal);
    const bot = await loadBot(botId);
    if (isGlobalAdmin(principal)) return { bot, membership: null, canManage: true };
    const membership = await store.get('bot_memberships', {
      bot_id: bot.id,
      user_id: validateUuid(principal.id, 'principal.id'),
    });
    if (!activeMembership(membership)) {
      fail('Active Bot membership is required', 'bot_membership_required', 403);
    }
    return { bot, membership, canManage: membership.role === 'manager' };
  };

  const withKey = async (operation) => {
    let provided = null;
    let key = null;
    try {
      if (typeof encryption?.getKey !== 'function') {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      provided = await encryption.getKey();
      key = Buffer.from(provided || []);
      if (key.byteLength !== 32) {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      return await operation(key);
    } finally {
      key?.fill(0);
      if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
    }
  };

  const listRows = async (tableName, filters = {}, limit = 100) => (
    (await store.list(tableName, { filters, limit })).items
  );

  const loadSafeModelOptions = async () => sanitizeBotModelOptions(
    await loadModelCatalog(),
    {
      resolveAuthType: (providerId) => {
        try {
          return readHostProviderAuth(providerId)?.type ?? null;
        } catch {
          // An unreadable host record is not a selectable connection. Its
          // contents must never escape into the public model catalog.
          return null;
        }
      },
    },
  );

  const canCreateBot = (principal) => {
    if (!principal?.id || !isGlobalAdmin(principal)) return false;
    try {
      validateUuid(principal.id, 'principal.id');
      return true;
    } catch {
      return false;
    }
  };

  const audienceForBot = async (botId) => {
    const memberships = await listRows('bot_memberships', {
      bot_id: validateUuid(botId, 'botId'),
    }, 1_000);
    const audience = new Set();
    for (const row of memberships) {
      if (!activeMembership(row)) continue;
      if (row.activated_at && Date.parse(row.activated_at) > now().getTime()) continue;
      audience.add(row.user_id);
    }
    return Object.freeze({ memberships: Object.freeze(memberships), audience: Object.freeze([...audience]) });
  };

  const publishActivationEvents = async ({ bot: botRow, revision: revisionRow }) => {
    if (!eventStream) return;
    try {
      const { memberships, audience } = await audienceForBot(botRow.id);
      const events = [{
        kind: 'bot.activated',
        botId: botRow.id,
        audienceUserIds: audience,
        payload: { bot: publicBot(botRow) },
      }, {
        kind: 'revision.activated',
        botId: botRow.id,
        audienceUserIds: audience,
        payload: { revision: publicRevision(revisionRow, false) },
      }];
      for (const membershipRow of memberships) {
        if (!activeMembership(membershipRow) || !audience.includes(membershipRow.user_id)) continue;
        events.push({
          kind: 'membership.assigned',
          botId: botRow.id,
          audienceUserIds: [membershipRow.user_id],
          payload: { membership: publicMembership(membershipRow) },
        });
      }
      await Promise.allSettled(events.map((event) => (
        Promise.resolve().then(() => eventStream.publish(event))
      )));
    } catch {
      // Publication is already committed. Reconnect snapshots are authoritative,
      // so a transient delivery failure must never roll back an active revision.
    }
  };

  const publishBotManagementEvent = async (kind, botRow) => {
    if (!eventStream || !botRow?.active_revision_id) return;
    try {
      const { audience } = await audienceForBot(botRow.id);
      await eventStream.publish({
        kind,
        botId: botRow.id,
        audienceUserIds: audience,
        payload: { bot: publicBot(botRow) },
      });
    } catch {
      // The committed database row is authoritative on reconnect.
    }
  };

  const publishMembershipAccess = async ({ bot: botRow, revision: revisionRow, membership: row, kind }) => {
    if (!eventStream || !revisionRow || !botRow?.active_revision_id) return;
    try {
      const audienceUserIds = [row.user_id];
      await Promise.allSettled([{
        kind: 'bot.activated',
        botId: botRow.id,
        audienceUserIds,
        payload: { bot: publicBot(botRow) },
      }, {
        kind: 'revision.activated',
        botId: botRow.id,
        audienceUserIds,
        payload: { revision: publicRevision(revisionRow, false) },
      }, {
        kind,
        botId: botRow.id,
        audienceUserIds,
        payload: { membership: publicMembership(row) },
      }].map((event) => Promise.resolve().then(() => eventStream.publish(event))));
    } catch {
      // The reconnect snapshot reconciles committed membership changes.
    }
  };

  const publishMembershipRevocation = async (botId, row) => {
    if (!eventStream) return;
    try {
      await eventStream.publish({
        kind: 'membership.revoked',
        botId,
        audienceUserIds: [row.user_id],
        payload: { membership: publicMembership(row) },
      });
    } catch {
      // The reconnect snapshot removes access even if this delivery is lost.
    }
  };

  const decryptEvalCase = (row, key) => {
    const input = decryptBotJson({
      key,
      envelope: row.input_envelope,
      expectedKeyId: DEPLOYMENT_KEY_ID,
      associatedData: evalCaseAssociatedData(row.bot_id, row.id),
    });
    return Object.freeze({
      id: row.id,
      botId: row.bot_id,
      name: row.name,
      input: structuredClone(input),
      expectedOutcome: structuredClone(row.expected_outcome),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at || null,
    });
  };

  const listEvalCases = async (principal, botId, includeArchived = false) => {
    await managerDecision(principal, botId);
    const rows = await listRows('bot_eval_cases', { bot_id: validateUuid(botId, 'botId') });
    if (rows.length === 0) return Object.freeze([]);
    return withKey(async (key) => rows
      .filter((row) => includeArchived || row.archived_at === null)
      .map((row) => decryptEvalCase(row, key)));
  };

  const listCatalog = async (principal) => {
    requirePrincipal(principal);
    if (isGlobalAdmin(principal)) {
      const rows = await listRows('bots');
      return Object.freeze({
        bots: Object.freeze(rows.map(publicBot)),
        canCreateBot: canCreateBot(principal),
      });
    }
    const memberships = await listRows('bot_memberships', {
      user_id: validateUuid(principal.id, 'principal.id'),
    });
    const bots = [];
    for (const membership of memberships) {
      if (!activeMembership(membership)) continue;
      const row = await store.get('bots', { id: membership.bot_id });
      if (row) bots.push(publicBot(row));
    }
    bots.sort((left, right) => left.name.localeCompare(right.name));
    return Object.freeze({ bots: Object.freeze(bots), canCreateBot: false });
  };

  const getDetail = async (principal, botId) => {
    const decision = await readDecision(principal, botId);
    const revisions = await listRows('bot_revisions', { bot_id: decision.bot.id });
    if (!decision.canManage) {
      return Object.freeze({
        bot: publicBot(decision.bot),
        canManage: false,
        revisions: Object.freeze(revisions.map((row) => publicRevision(row, false))),
        memberships: Object.freeze([]),
        credentials: Object.freeze([]),
        evalCases: Object.freeze([]),
      });
    }
    const [memberships, credentials, evalCases] = await Promise.all([
      listRows('bot_memberships', { bot_id: decision.bot.id }),
      listRows('bot_credentials', { bot_id: decision.bot.id }),
      listEvalCases(principal, decision.bot.id, true),
    ]);
    // Names are a display concern: if the directory is unreachable the members
    // list still renders, just without them.
    const profiles = typeof store.listUserProfiles === 'function'
      ? await store.listUserProfiles(memberships.map((row) => row.user_id)).catch(() => new Map())
      : new Map();
    return Object.freeze({
      bot: publicBot(decision.bot),
      canManage: true,
      revisions: Object.freeze(revisions.map((row) => publicRevision(row, true))),
      memberships: Object.freeze(memberships.map(
        (row) => publicMembership(row, profiles.get(row.user_id) || null),
      )),
      credentials: Object.freeze(await Promise.all(credentials.map(async (row) => {
        if (!isHostOpenAiCredential(row)) return publicCredential(row);
        const connections = await getOAuthConnections().catch(() => null);
        return publicCredential(row, connections ? await connections.authState(row) : 'unavailable');
      }))),
      evalCases: Object.freeze(evalCases),
    });
  };

  // Every published Library source is pinned automatically. Managers curate
  // sources; which immutable version a revision rides is bookkeeping the server
  // owns, so it is never accepted from the client.
  const resolvePinnedLibraryVersionIds = async (botId) => {
    if (!botId) return [];
    const sources = await listRows('bot_library_sources', { bot_id: botId });
    return [...new Set(sources
      .map((source) => source.current_published_version_id)
      .filter((id) => typeof id === 'string' && id.length > 0))].sort();
  };

  // A soul is seeded once and then belongs to whoever edits it. Bots created
  // before souls existed get one backfilled from their profile on their next
  // configuration edit, folding in any tone they already had.
  const resolveSoul = ({ candidate, existingContract, bot }) => {
    const submitted = typeof candidate?.soul === 'string' ? candidate.soul.trim() : '';
    if (submitted) return submitted;
    if (Object.hasOwn(candidate ?? {}, 'soul') && candidate.soul !== undefined) {
      const retained = typeof existingContract?.soul === 'string' ? existingContract.soul.trim() : '';
      if (retained) return retained;
    }
    const inherited = typeof existingContract?.soul === 'string' ? existingContract.soul.trim() : '';
    if (inherited) return inherited;
    return buildStarterSoul({
      name: bot?.name ?? candidate?.identity?.title,
      title: candidate?.identity?.title ?? bot?.title,
      summary: candidate?.identity?.summary ?? bot?.summary,
      tone: typeof candidate?.tone === 'string' ? candidate.tone : existingContract?.tone,
    });
  };

  const prepareDraftContract = async (value, { bot = null, existingContract = null } = {}) => {
    let candidate = value;
    try {
      const modelOptions = await loadSafeModelOptions();
      candidate = migrateLegacyReasoningVariants(value, modelOptions);
    } catch {
      // Catalog availability must not make an otherwise valid Draft unsaveable.
    }
    candidate = {
      ...candidate,
      operatingInstructions: '',
      prohibitedInstructions: '',
      advancedPrompt: '',
      mcpBindings: [],
      soul: resolveSoul({ candidate, existingContract, bot }),
      gatewayPluginVersion: BOT_CURRENT_GATEWAY_PLUGIN_VERSION,
      libraryVersionIds: await resolvePinnedLibraryVersionIds(bot?.id),
      tenancy: 'team',
    };
    return normalizeManagementContract(candidate);
  };

  const create = async (principal, request) => {
    requireGlobalAdmin(principal);
    assertExactObject(request, {
      label: 'Bot creation',
      required: ['name', 'tenancy', 'contract'],
    });
    const name = validateBoundedString(request.name, 'name', { maximum: 120 });
    const tenancy = normalizeTenancy(request.tenancy);
    const contract = await prepareDraftContract(
      applyCapabilityFirstCreationDefaults(request.contract),
      { bot: { name } },
    );
    assertSkillBindingsMatch(contract, { skillBindings: [] });
    const botId = uuid();
    const revisionId = uuid();
    const result = await store.createBot({
      botId,
      revisionId,
      name,
      tenancy,
      contract,
      compiledHash: hashCanonicalBotJson(contract),
      actorId: validateUuid(principal.id, 'principal.id'),
    });
    await audit({
      principal,
      botId,
      targetType: 'bot',
      targetId: botId,
      action: 'bot.create',
      result: 'success',
      metadata: { tenancy },
    });
    return Object.freeze({
      bot: publicBot(result.bot),
      revision: publicRevision(result.revision, true),
      membership: publicMembership(result.membership),
    });
  };

  const updateProfile = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot profile update',
      required: ['name', 'title', 'summary', 'expectedUpdatedAt'],
      optional: ['avatar'],
    });
    const name = validateBoundedString(request.name, 'name', { maximum: 120 });
    const title = validateBoundedString(request.title, 'title', { maximum: 160 });
    const summary = typeof request.summary === 'string' ? request.summary.trim() : '';
    if (summary.length > 500) {
      fail('summary is invalid', 'bot_request_invalid', 400);
    }
    const expectedUpdatedAt = normalizeExpectedRevision(request.expectedUpdatedAt);
    const changes = { name, title, summary };
    let uploadedAvatar = null;
    let replacementRequested = false;
    if (Object.hasOwn(request, 'avatar')) {
      replacementRequested = true;
      if (request.avatar !== null) {
        if (!blobStore || typeof blobStore.uploadProfileAvatar !== 'function') {
          fail('Bot avatar storage is unavailable', 'bot_avatar_unavailable', 503);
        }
        uploadedAvatar = await blobStore.uploadProfileAvatar({
          principal,
          botId: decision.bot.id,
          contentType: request.avatar.contentType,
          bytes: request.avatar.bytes,
          provenance: { purpose: 'bot-profile-avatar' },
        });
        changes.avatar_object_id = uploadedAvatar.id;
      } else {
        changes.avatar_object_id = null;
      }
    }

    let row;
    try {
      row = await store.updateIfRevision(
        'bots',
        { id: decision.bot.id },
        changes,
        expectedUpdatedAt,
      );
    } catch (error) {
      if (uploadedAvatar && blobStore?.deleteObject) {
        await blobStore.deleteObject({
          principal,
          botId: decision.bot.id,
          objectId: uploadedAvatar.id,
        }).catch(() => undefined);
      }
      throw error;
    }

    let avatarCleanupRequired = false;
    if (replacementRequested
      && decision.bot.avatar_object_id
      && decision.bot.avatar_object_id !== uploadedAvatar?.id
      && blobStore?.deleteObject) {
      const cleanup = await blobStore.deleteObject({
        principal,
        botId: decision.bot.id,
        objectId: decision.bot.avatar_object_id,
      }).catch(() => null);
      avatarCleanupRequired = !cleanup || cleanup.cleanupRequired === true;
    }
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot',
      targetId: decision.bot.id,
      action: 'bot.profile.update',
      result: 'success',
      metadata: {
        avatarChanged: replacementRequested,
        avatarCleanupRequired,
      },
    });
    await publishBotManagementEvent('bot.updated', row);
    return Object.freeze({
      bot: publicBot(row),
      avatarCleanupRequired,
    });
  };

  const downloadAvatar = async (principal, botId) => {
    const decision = await readDecision(principal, botId);
    if (!decision.bot.avatar_object_id) {
      fail('Bot avatar not found', 'bot_avatar_not_found', 404);
    }
    if (!blobStore || typeof blobStore.download !== 'function') {
      fail('Bot avatar storage is unavailable', 'bot_avatar_unavailable', 503);
    }
    const result = await blobStore.download({
      principal,
      botId: decision.bot.id,
      objectId: decision.bot.avatar_object_id,
    });
    if (result.object.visibility !== 'profile') {
      fail('Bot avatar not found', 'bot_avatar_not_found', 404);
    }
    return result;
  };

  const modelOptions = async (principal, botId) => {
    await managerDecision(principal, botId);
    return loadSafeModelOptions();
  };

  const createRevision = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot revision creation',
      required: ['contract'],
      optional: ['basedOnRevisionId'],
    });
    let source = null;
    if (request.basedOnRevisionId !== undefined) {
      source = await store.get('bot_revisions', {
        id: validateUuid(request.basedOnRevisionId, 'basedOnRevisionId'),
        bot_id: decision.bot.id,
      });
      if (!source) fail('Source Bot revision not found', 'bot_revision_not_found', 404);
    }
    const contract = await prepareDraftContract(request.contract, {
      bot: decision.bot,
      existingContract: source?.contract ?? null,
    });
    assertSkillBindingsMatch(
      contract,
      source?.contract ?? { skillBindings: [] },
    );
    const existing = await listRows('bot_revisions', { bot_id: decision.bot.id });
    const revisionNumber = existing.reduce(
      (maximum, row) => Math.max(maximum, Number(row.revision_number)),
      0,
    ) + 1;
    const row = await store.insert('bot_revisions', {
      id: uuid(),
      bot_id: decision.bot.id,
      revision_number: revisionNumber,
      contract,
      compiled_hash: hashCanonicalBotJson(contract),
      created_by: validateUuid(principal.id, 'principal.id'),
    });
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_revision',
      targetId: row.id,
      action: 'bot.revision.create',
      result: 'success',
      metadata: { revisionNumber },
    });
    return Object.freeze({ revision: publicRevision(row, true) });
  };

  // Bot-as-code imports deliberately bypass Draft convenience defaults: the
  // verified portable document is the source of truth, and local binding IDs
  // are supplied only by the import resolver. The resulting revision is still
  // a normal Draft and has no path to activation outside the regular gates.
  const createImportedDraft = async (principal, {
    botId = null,
    newBotName = null,
    contract: candidateContract,
    portableSpec,
    specHash,
  } = {}) => {
    const contract = normalizeContract(candidateContract);
    const compiledHash = hashCanonicalBotJson(contract);
    let botRow;
    let revisionRow;
    let membershipRow = null;
    if (botId) {
      const decision = await managerDecision(principal, botId);
      botRow = decision.bot;
      const existing = await listRows('bot_revisions', { bot_id: botRow.id });
      const revisionNumber = existing.reduce(
        (maximum, row) => Math.max(maximum, Number(row.revision_number)),
        0,
      ) + 1;
      revisionRow = await store.insert('bot_revisions', {
        id: uuid(),
        bot_id: botRow.id,
        revision_number: revisionNumber,
        contract,
        compiled_hash: compiledHash,
        portable_spec: structuredClone(portableSpec),
        spec_hash: specHash,
        created_by: validateUuid(principal.id, 'principal.id'),
      });
    } else {
      requireGlobalAdmin(principal);
      const name = validateBoundedString(newBotName, 'newBotName', { maximum: 120 });
      const created = await store.createBot({
        botId: uuid(),
        revisionId: uuid(),
        name,
        tenancy: 'team',
        contract,
        compiledHash,
        actorId: validateUuid(principal.id, 'principal.id'),
      });
      botRow = created.bot;
      membershipRow = created.membership;
      revisionRow = await store.attachRevisionSpec({
        revisionId: created.revision.id,
        portableSpec,
        specHash,
        compiledHash,
      });
    }
    await audit({
      principal,
      botId: botRow.id,
      targetType: 'bot_revision',
      targetId: revisionRow.id,
      action: 'bot.revision.import',
      result: 'success',
      metadata: {
        revisionNumber: Number(revisionRow.revision_number),
        specHash,
        unresolvedBindingsAllowed: true,
      },
    });
    return Object.freeze({
      bot: publicBot(botRow),
      revision: publicRevision(revisionRow, true),
      ...(membershipRow ? { membership: publicMembership(membershipRow) } : {}),
    });
  };

  const updateImportedDraftBindings = async (principal, botId, revisionId, {
    contract: candidateContract,
    expectedUpdatedAt,
    specHash,
  } = {}) => {
    const decision = await managerDecision(principal, botId);
    const id = validateUuid(revisionId, 'revisionId');
    const current = await store.get('bot_revisions', { id, bot_id: decision.bot.id });
    if (!current) fail('Bot revision not found', 'bot_revision_not_found', 404);
    if (current.activated_at !== null) {
      fail('Active Bot revisions are read only', 'bot_revision_active', 409);
    }
    if (!current.portable_spec || current.spec_hash !== specHash) {
      fail('Bot revision is not the matching imported Draft', 'bot_spec_import_mismatch', 409);
    }
    const contract = normalizeContract(candidateContract);
    const row = await store.updateIfRevision(
      'bot_revisions',
      { id, bot_id: decision.bot.id },
      { contract, compiled_hash: hashCanonicalBotJson(contract) },
      normalizeExpectedRevision(expectedUpdatedAt),
    );
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_revision',
      targetId: id,
      action: 'bot.revision.import_bindings.resolve',
      result: 'success',
      metadata: { specHash },
    });
    return Object.freeze({ revision: publicRevision(row, true) });
  };

  const updateDraftRevision = async (principal, botId, revisionId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot revision update',
      required: ['contract', 'expectedUpdatedAt'],
    });
    const id = validateUuid(revisionId, 'revisionId');
    const current = await store.get('bot_revisions', { id, bot_id: decision.bot.id });
    if (!current) fail('Bot revision not found', 'bot_revision_not_found', 404);
    if (current.activated_at !== null) {
      fail('Active Bot revisions are read only', 'bot_revision_active', 409);
    }
    if (Object.hasOwn(request.contract, 'skillBindings')) {
      assertSkillBindingsMatch(request.contract, current.contract);
    }
    const bindings = skillBindingsFor(current.contract);
    const contract = await prepareDraftContract({
      ...request.contract,
      ...bindings,
    }, { bot: decision.bot, existingContract: current.contract });
    const row = await store.updateIfRevision(
      'bot_revisions',
      { id, bot_id: decision.bot.id },
      { contract, compiled_hash: hashCanonicalBotJson(contract) },
      normalizeExpectedRevision(request.expectedUpdatedAt),
    );
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_revision',
      targetId: id,
      action: 'bot.revision.update',
      result: 'success',
      metadata: { revisionNumber: Number(row.revision_number) },
    });
    return Object.freeze({ revision: publicRevision(row, true) });
  };

  const activationHealth = async (principal, botId, revisionId) => {
    const decision = await managerDecision(principal, botId);
    const revision = await store.get('bot_revisions', {
      id: validateUuid(revisionId, 'revisionId'),
      bot_id: decision.bot.id,
    });
    if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
    if (revision.activated_at !== null) {
      return Object.freeze({ ready: true, gates: Object.freeze([]), revision: publicRevision(revision, true) });
    }

    let contract = null;
    let contractError = null;
    try {
      contract = normalizeManagementContract(revision.contract);
    } catch (error) {
      contractError = error;
    }
    const capabilities = await resolveCapabilities().catch((error) => ({
      available: false,
      state: 'runtime_unavailable',
      code: error?.code || 'bot_runtime_unavailable',
    }));
    let modelResult = null;
    let modelError = null;
    let capabilityResult = null;
    let capabilityError = null;
    let agentError = null;
    let computerResult = null;
    let computerError = null;
    if (contract) {
      if (contract.agent?.kind === 'ag_ui') {
        agentError = Object.assign(new Error('New Bot configurations always run through OpenCode.'), {
          code: 'bot_agent_must_use_opencode',
        });
      } else {
        try {
          modelResult = await preflightModel({
            principal,
            bot: decision.bot,
            revision,
            contract,
          });
        } catch (error) {
          modelError = error;
        }
      }
      const hasCapabilityBindings = contract.skillBindings.length > 0;
      if (hasCapabilityBindings) {
        try {
          capabilityResult = await preflightCapabilities({
            principal,
            bot: decision.bot,
            revision,
            contract,
          });
        } catch (error) {
          capabilityError = error;
        }
      }
      if (contract.contractVersion === 3) {
        try {
          computerResult = await preflightComputer({
            principal,
            bot: decision.bot,
            revision,
            contract,
          });
        } catch (error) {
          computerError = error;
        }
      }
    }
    const libraryBindings = contract
      ? await Promise.all(contract.libraryVersionIds.map(async (id) => {
          const version = await store.get('bot_library_versions', { id });
          if (!version) return null;
          const source = await store.get('bot_library_sources', {
            id: version.source_id,
            bot_id: decision.bot.id,
          });
          return source && source.retired_at === null ? { version, source } : null;
        }))
      : [];
    const policyCovered = Boolean(contract && !contractError);
    const gates = [
      {
        id: 'schema',
        label: 'Control-plane schema',
        status: store.available ? 'pass' : 'fail',
        detail: store.available ? 'Required Bot schema is available.' : 'Bot schema is unavailable.',
      },
      {
        id: 'images',
        label: 'Bot runtime',
        status: capabilities.available ? 'pass' : 'fail',
        detail: runtimeReadinessDetail(capabilities),
      },
      ...(contract?.agent?.kind === 'ag_ui' ? [{
        id: 'agent',
        label: 'Reasoning adapter',
        status: 'fail',
        detail: agentError?.message || 'New Bot configurations always run through OpenCode.',
      }] : [{
        id: 'models',
        label: 'Model catalog and credential',
        status: modelResult ? 'pass' : 'fail',
        detail: modelResult
          ? `${modelResult.model.providerId}/${modelResult.model.modelId} is available.`
          : (modelError?.message || 'No configured model and credential passed preflight.'),
      }, {
        id: 'egress',
        label: 'Reviewed egress hosts',
        status: modelResult?.egressHosts?.length > 0 ? 'pass' : 'fail',
        detail: modelResult?.egressHosts?.length > 0
          ? `${modelResult.egressHosts.length} reviewed HTTPS authority binding(s).`
          : 'Model egress authorities did not match the live catalog.',
      }]),
      {
        id: 'tools',
        label: 'Tool manifest',
        status: contractError ? 'fail' : 'pass',
        detail: contractError?.message || `${contract.fileTools.length} file and ${contract.runtimeTools?.length || 0} runtime tool(s); gateway manifest is pinned.`,
      },
      {
        id: 'policy',
        label: 'Policy coverage',
        status: policyCovered ? 'pass' : 'fail',
        detail: policyCovered
          ? `${contract.actionPolicy.defaultEffect} is the ordinary-action default; hard safety rules and denied origins remain enforced.`
          : (contractError?.message || 'Action or browser policy is invalid.'),
      },
      ...(contract?.contractVersion === 3 ? [{
        id: 'computer',
        label: 'Computer isolation',
        status: computerResult?.status === 'pass' ? 'pass' : 'fail',
        detail: computerResult?.detail
          || computerError?.message
          || 'The selected computer isolation tier is unavailable.',
      }] : []),
      ...(contract?.libraryVersionIds.length > 0 ? [{
        id: 'library',
        label: 'Library and index',
        status: libraryBindings.every(Boolean) ? 'pass' : 'fail',
        detail: libraryBindings.every(Boolean)
          ? `${libraryBindings.length} pinned Library version(s) resolved.`
          : 'A pinned Library version or its local index is unavailable.',
      }] : []),
      ...(contract?.skillBindings.length > 0 ? [{
        id: 'skills',
        label: 'Assigned skills',
        status: capabilityResult?.skills?.materialized === true ? 'pass' : 'fail',
        detail: capabilityResult?.skills?.materialized === true
          ? `${capabilityResult.skills.count} pinned skill package(s) passed digest and read-only materialization checks.`
          : (capabilityResult?.skills?.error || capabilityError?.message
            || 'A skill package or read-only materialization check failed.'),
      }] : []),
    ].map((gate) => Object.freeze(gate));
    return Object.freeze({
      ready: gates.every((gate) => gate.status === 'pass'),
      gates: Object.freeze(gates),
      revision: publicRevision(revision, true),
    });
  };

  const activateRevision = async (principal, botId, revisionId) => {
    const health = await activationHealth(principal, botId, revisionId);
    if (!health.ready) {
      fail('Bot revision did not pass activation health checks', 'bot_activation_blocked', 409, {
        gates: health.gates,
      });
    }
    const bot = await store.activateRevision({
      botId: validateUuid(botId, 'botId'),
      revisionId: validateUuid(revisionId, 'revisionId'),
      actorId: validateUuid(principal.id, 'principal.id'),
    });
    await audit({
      principal,
      botId: bot.id,
      targetType: 'bot_revision',
      targetId: revisionId,
      action: 'bot.revision.activate',
      result: 'success',
      metadata: { futureRunsOnly: true },
    });
    const activated = await store.get('bot_revisions', {
      id: validateUuid(revisionId, 'revisionId'),
      bot_id: bot.id,
    });
    if (activated) await publishActivationEvents({ bot, revision: activated });
    return Object.freeze({ bot: publicBot(bot), health });
  };

  const publishRevision = async (principal, botId, revisionId, request) => {
    assertExactObject(request, {
      label: 'Bot revision publish',
      required: ['contract', 'expectedUpdatedAt'],
      optional: ['profile'],
    });
    const decision = await managerDecision(principal, botId);
    let profileCandidate = null;
    if (request.profile !== undefined) {
      assertExactObject(request.profile, {
        label: 'Bot publication profile',
        required: ['name', 'title', 'summary', 'expectedUpdatedAt'],
        optional: ['avatar'],
      });
      const summary = typeof request.profile.summary === 'string'
        ? request.profile.summary.trim()
        : '';
      if (summary.length > 500) fail('profile.summary is invalid', 'bot_request_invalid', 400);
      profileCandidate = {
        name: validateBoundedString(request.profile.name, 'profile.name', { maximum: 120 }),
        title: validateBoundedString(request.profile.title, 'profile.title', { maximum: 160 }),
        summary,
        expectedUpdatedAt: normalizeExpectedRevision(
          request.profile.expectedUpdatedAt,
          'profile.expectedUpdatedAt',
        ),
        ...(Object.hasOwn(request.profile, 'avatar') ? { avatar: request.profile.avatar } : {}),
      };
    }
    const saved = await updateDraftRevision(principal, botId, revisionId, {
      contract: request.contract,
      expectedUpdatedAt: request.expectedUpdatedAt,
    });

    let savedProfile = null;
    let uploadedAvatar = null;
    let avatarReplacementRequested = false;
    const cleanUploadedAvatar = async () => {
      if (!uploadedAvatar) return Object.freeze({ cleanupRequired: false, errorCode: null });
      if (!blobStore || typeof blobStore.deleteObject !== 'function') {
        return Object.freeze({
          cleanupRequired: true,
          errorCode: 'bot_avatar_cleanup_unavailable',
        });
      }
      try {
        const cleanup = await blobStore.deleteObject({
          principal,
          botId: decision.bot.id,
          objectId: uploadedAvatar.id,
        });
        return Object.freeze({
          cleanupRequired: !cleanup || cleanup.cleanupRequired === true,
          errorCode: typeof cleanup?.errorCode === 'string'
            ? cleanup.errorCode
            : (!cleanup || cleanup.cleanupRequired === true ? 'bot_avatar_cleanup_pending' : null),
        });
      } catch (error) {
        return Object.freeze({
          cleanupRequired: true,
          errorCode: typeof error?.code === 'string' ? error.code : 'bot_avatar_cleanup_failed',
        });
      }
    };
    const saveCandidateProfile = async () => {
      const changes = {
        name: profileCandidate.name,
        title: profileCandidate.title,
        summary: profileCandidate.summary,
      };
      if (Object.hasOwn(profileCandidate, 'avatar')) {
        avatarReplacementRequested = true;
        if (profileCandidate.avatar !== null) {
          if (!blobStore || typeof blobStore.uploadProfileAvatar !== 'function') {
            fail('Bot avatar storage is unavailable', 'bot_avatar_unavailable', 503);
          }
          uploadedAvatar = await blobStore.uploadProfileAvatar({
            principal,
            botId: decision.bot.id,
            contentType: profileCandidate.avatar.contentType,
            bytes: profileCandidate.avatar.bytes,
            provenance: { purpose: 'bot-profile-avatar' },
          });
          changes.avatar_object_id = uploadedAvatar.id;
        } else {
          changes.avatar_object_id = null;
        }
      }
      try {
        savedProfile = await store.updateIfRevision(
          'bots',
          { id: decision.bot.id },
          changes,
          profileCandidate.expectedUpdatedAt,
        );
      } catch (error) {
        const cleanup = await cleanUploadedAvatar();
        if (cleanup.cleanupRequired) {
          fail(
            'Bot profile save failed and its candidate avatar cleanup requires recovery',
            'bot_publish_avatar_cleanup_failed',
            500,
            {
              operationCode: typeof error?.code === 'string'
                ? error.code
                : 'bot_profile_update_failed',
              cleanupCode: cleanup.errorCode,
            },
          );
        }
        throw error;
      }
    };

    const cleanReplacedAvatar = async () => {
      if (!avatarReplacementRequested
        || !decision.bot.avatar_object_id
        || decision.bot.avatar_object_id === uploadedAvatar?.id) {
        return Object.freeze({ cleanupRequired: false, errorCode: null });
      }
      if (!blobStore || typeof blobStore.deleteObject !== 'function') {
        return Object.freeze({
          cleanupRequired: true,
          errorCode: 'bot_avatar_cleanup_unavailable',
        });
      }
      try {
        const cleanup = await blobStore.deleteObject({
          principal,
          botId: decision.bot.id,
          objectId: decision.bot.avatar_object_id,
        });
        return Object.freeze({
          cleanupRequired: !cleanup || cleanup.cleanupRequired === true,
          errorCode: typeof cleanup?.errorCode === 'string'
            ? cleanup.errorCode
            : (!cleanup || cleanup.cleanupRequired === true ? 'bot_avatar_cleanup_pending' : null),
        });
      } catch (error) {
        return Object.freeze({
          cleanupRequired: true,
          errorCode: typeof error?.code === 'string' ? error.code : 'bot_avatar_cleanup_failed',
        });
      }
    };

    const setupOnly = !decision.bot.active_revision_id;
    if (setupOnly && profileCandidate) await saveCandidateProfile();
    const health = await activationHealth(principal, botId, revisionId);
    if (!health.ready) {
      const avatarCleanup = savedProfile
        ? await cleanReplacedAvatar()
        : { cleanupRequired: false, errorCode: null };
      fail('Bot revision did not pass activation health checks', 'bot_activation_blocked', 409, {
        gates: health.gates,
        revision: saved.revision,
        ...(savedProfile ? {
          bot: publicBot(savedProfile),
          profileRetained: true,
          avatarCleanupRequired: avatarCleanup.cleanupRequired,
          ...(avatarCleanup.errorCode ? { avatarCleanupCode: avatarCleanup.errorCode } : {}),
        } : {}),
      });
    }
    if (typeof store.publishRevision !== 'function') {
      const avatarCleanup = savedProfile
        ? await cleanReplacedAvatar()
        : { cleanupRequired: false, errorCode: null };
      fail('Bot revision publishing is unavailable', 'bot_publish_unavailable', 503, {
        ...(savedProfile ? {
          bot: publicBot(savedProfile),
          profileRetained: true,
          avatarCleanupRequired: avatarCleanup.cleanupRequired,
          ...(avatarCleanup.errorCode ? { avatarCleanupCode: avatarCleanup.errorCode } : {}),
        } : {}),
      });
    }
    if (!setupOnly && profileCandidate) await saveCandidateProfile();
    let bot;
    await beforeActivateComputer({
      bot: decision.bot,
      revision: saved.revision,
      setupOnly,
    });
    try {
      bot = await store.publishRevision({
        botId: validateUuid(botId, 'botId'),
        revisionId: validateUuid(revisionId, 'revisionId'),
        expectedUpdatedAt: saved.revision.updatedAt,
        compiledHash: saved.revision.compiledHash,
        actorId: validateUuid(principal.id, 'principal.id'),
      });
    } catch (error) {
      if (setupOnly) {
        await afterDeactivateComputer({
          bot: decision.bot,
          previousLifecycle: decision.bot.lifecycle,
        }).catch(() => undefined);
      }
      if (!setupOnly && savedProfile) {
        try {
          await store.updateIfRevision(
            'bots',
            { id: decision.bot.id },
            {
              name: decision.bot.name,
              title: decision.bot.title || decision.bot.name,
              summary: decision.bot.summary || '',
              avatar_object_id: decision.bot.avatar_object_id || null,
            },
            savedProfile.updated_at,
          );
        } catch (rollbackError) {
          fail(
            'Bot publication failed and its profile rollback requires recovery',
            'bot_publish_profile_rollback_failed',
            500,
            {
              publishCode: typeof error?.code === 'string' ? error.code : 'bot_publish_failed',
              rollbackCode: typeof rollbackError?.code === 'string'
                ? rollbackError.code
                : 'bot_profile_rollback_failed',
            },
          );
        }
        const candidateCleanup = await cleanUploadedAvatar();
        if (candidateCleanup.cleanupRequired) {
          fail(
            'Bot publication failed and its candidate avatar cleanup requires recovery',
            'bot_publish_avatar_cleanup_failed',
            500,
            {
              publishCode: typeof error?.code === 'string' ? error.code : 'bot_publish_failed',
              cleanupCode: candidateCleanup.errorCode,
            },
          );
        }
      } else if (setupOnly && savedProfile) {
        // A setup Bot has no live revision to protect. Keep all entered values
        // available for correction and retry, including its selected avatar.
        const avatarCleanup = await cleanReplacedAvatar();
        if (avatarCleanup.cleanupRequired) {
          const details = error?.details && typeof error.details === 'object'
            && !Array.isArray(error.details)
            ? error.details
            : {};
          throw new BotManagementError(
            error instanceof Error ? error.message : 'Bot publication failed',
            typeof error?.code === 'string' ? error.code : 'bot_publish_failed',
            Number.isInteger(error?.statusCode) ? error.statusCode : 500,
            {
              ...details,
              bot: publicBot(savedProfile),
              profileRetained: true,
              avatarCleanupRequired: true,
              avatarCleanupCode: avatarCleanup.errorCode,
            },
          );
        }
      }
      throw error;
    }
    const avatarCleanup = savedProfile
      ? await cleanReplacedAvatar()
      : { cleanupRequired: false, errorCode: null };
    const avatarCleanupRequired = avatarCleanup.cleanupRequired;
    const published = await store.get('bot_revisions', {
      id: validateUuid(revisionId, 'revisionId'),
      bot_id: validateUuid(botId, 'botId'),
    });
    await audit({
      principal,
      botId: bot.id,
      targetType: 'bot_revision',
      targetId: revisionId,
      action: 'bot.revision.publish',
      result: 'success',
      metadata: {
        futureRunsOnly: true,
        profileUpdated: savedProfile !== null,
        avatarChanged: avatarReplacementRequested,
        avatarCleanupRequired,
      },
    });
    await publishActivationEvents({ bot, revision: published });
    return Object.freeze({
      bot: publicBot(bot),
      revision: publicRevision(published, true),
      health: Object.freeze({ ...health, revision: publicRevision(published, true) }),
      futureRunsOnly: true,
      profileUpdated: savedProfile !== null,
      avatarCleanupRequired,
    });
  };

  const transitionLifecycle = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot lifecycle transition',
      required: ['lifecycle', 'expectedUpdatedAt'],
    });
    const allowed = LIFECYCLE_TRANSITIONS[decision.bot.lifecycle] || [];
    if (!allowed.includes(request.lifecycle)) {
      fail(
        `Bot cannot transition from ${decision.bot.lifecycle} to ${String(request.lifecycle)}`,
        'bot_lifecycle_transition_invalid',
        409,
      );
    }
    const timestamp = now().toISOString();
    const computerPrepared = request.lifecycle === 'active';
    if (computerPrepared) {
      await beforeActivateComputer({
        bot: decision.bot,
        revision: { id: decision.bot.active_revision_id },
        setupOnly: false,
      });
    }
    let row;
    try {
      row = await store.updateIfRevision(
        'bots',
        { id: decision.bot.id },
        {
          lifecycle: request.lifecycle,
          ...(request.lifecycle === 'retired' ? { retired_at: timestamp } : {}),
        },
        normalizeExpectedRevision(request.expectedUpdatedAt),
      );
    } catch (error) {
      if (computerPrepared) {
        await afterDeactivateComputer({
          bot: decision.bot,
          previousLifecycle: decision.bot.lifecycle,
        }).catch(() => undefined);
      }
      throw error;
    }
    await audit({
      principal,
      botId: row.id,
      targetType: 'bot',
      targetId: row.id,
      action: `bot.lifecycle.${request.lifecycle}`,
      result: 'success',
      metadata: { previousLifecycle: decision.bot.lifecycle },
    });
    await publishBotManagementEvent(
      request.lifecycle === 'active' ? 'bot.activated' : `bot.${request.lifecycle}`,
      row,
    );
    if (request.lifecycle !== 'active') {
      await afterDeactivateComputer({ bot: row, previousLifecycle: decision.bot.lifecycle });
    }
    return Object.freeze({ bot: publicBot(row) });
  };

  const setMembership = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot membership assignment',
      required: ['userId', 'role'],
      optional: ['expectedUpdatedAt'],
    });
    const userId = validateUuid(request.userId, 'userId');
    const role = normalizeRole(request.role);
    const current = await store.get('bot_memberships', {
      bot_id: decision.bot.id,
      user_id: userId,
    });
    let row;
    if (current) {
      row = await store.updateIfRevision(
        'bot_memberships',
        { bot_id: decision.bot.id, user_id: userId },
        {
          role,
          assigned_by: validateUuid(principal.id, 'principal.id'),
          activated_at: now().toISOString(),
          revoked_at: null,
        },
        normalizeExpectedRevision(request.expectedUpdatedAt),
      );
    } else {
      row = await store.insert('bot_memberships', {
        bot_id: decision.bot.id,
        user_id: userId,
        role,
        assigned_by: validateUuid(principal.id, 'principal.id'),
        activated_at: now().toISOString(),
        revoked_at: null,
      });
    }
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_membership',
      targetId: userId,
      action: 'bot.membership.assign',
      result: 'success',
      metadata: { role },
    });
    if (decision.bot.active_revision_id) {
      const activeRevision = await store.get('bot_revisions', {
        id: decision.bot.active_revision_id,
        bot_id: decision.bot.id,
      });
      await publishMembershipAccess({
        bot: decision.bot,
        revision: activeRevision,
        membership: row,
        kind: activeMembership(current) ? 'membership.updated' : 'membership.assigned',
      });
    }
    return Object.freeze({
      membership: publicMembership(
        row,
        typeof store.listUserProfiles === 'function'
          ? (await store.listUserProfiles([row.user_id]).catch(() => new Map())).get(row.user_id) || null
          : null,
      ),
    });
  };

  // Backs the member picker. Manager-scoped and deliberately narrow: a name, an
  // email, and an id, with people who already belong to this Bot marked so the
  // picker can show them as already added instead of offering them twice.
  const searchDirectory = async (principal, botId, { query = '', limit = 20 } = {}) => {
    const decision = await managerDecision(principal, botId);
    if (typeof store.searchUserProfiles !== 'function') {
      return Object.freeze({ users: Object.freeze([]) });
    }
    const [rows, memberships] = await Promise.all([
      store.searchUserProfiles(query, limit),
      listRows('bot_memberships', { bot_id: decision.bot.id }),
    ]);
    const assigned = new Map(memberships
      .filter((row) => !row.revoked_at)
      .map((row) => [row.user_id, row.role]));
    return Object.freeze({
      users: Object.freeze(rows.map((row) => Object.freeze({
        id: row.id,
        displayName: typeof row.display_name === 'string' && row.display_name.trim()
          ? row.display_name.trim()
          : null,
        email: typeof row.email === 'string' ? row.email : null,
        assignedRole: assigned.get(row.id) || null,
      }))),
    });
  };

  const revokeMembership = async (principal, botId, userId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot membership revocation',
      required: ['expectedUpdatedAt'],
    });
    const normalizedUserId = validateUuid(userId, 'userId');
    const current = await store.get('bot_memberships', {
      bot_id: decision.bot.id,
      user_id: normalizedUserId,
    });
    if (!current || current.revoked_at !== null) {
      fail('Active Bot membership not found', 'bot_membership_not_found', 404);
    }
    if (current.role === 'manager') {
      const memberships = await listRows('bot_memberships', { bot_id: decision.bot.id });
      const otherManagers = memberships.filter((row) => (
        row.user_id !== normalizedUserId && row.role === 'manager' && row.revoked_at === null
      ));
      if (otherManagers.length === 0) {
        fail('Bot must retain at least one active Manager', 'bot_final_manager_required', 409);
      }
    }
    const row = await store.updateIfRevision(
      'bot_memberships',
      { bot_id: decision.bot.id, user_id: normalizedUserId },
      { revoked_at: now().toISOString() },
      normalizeExpectedRevision(request.expectedUpdatedAt),
    );
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_membership',
      targetId: normalizedUserId,
      action: 'bot.membership.revoke',
      result: 'success',
      metadata: { previousRole: current.role },
    });
    await publishMembershipRevocation(decision.bot.id, row);
    return Object.freeze({
      membership: publicMembership(
        row,
        typeof store.listUserProfiles === 'function'
          ? (await store.listUserProfiles([row.user_id]).catch(() => new Map())).get(row.user_id) || null
          : null,
      ),
    });
  };

  const saveCredentialMetadata = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot credential metadata',
      required: ['provider', 'kind', 'credentialScope', 'ownerUserId', 'metadata'],
      optional: ['id', 'expectedUpdatedAt'],
    });
    const id = request.id === undefined ? uuid() : validateUuid(request.id, 'credentialId');
    const credentialScope = request.credentialScope;
    if (!['team', 'user'].includes(credentialScope)) fail('Bot credential scope is invalid');
    const ownerUserId = validateOptionalUuid(request.ownerUserId, 'ownerUserId');
    if ((credentialScope === 'team' && ownerUserId !== null)
      || (credentialScope === 'user' && ownerUserId === null)) {
      fail('Bot credential owner does not match its scope');
    }
    const provider = validateBoundedString(request.provider, 'provider', { maximum: 120 });
    const kind = validateBoundedString(request.kind, 'kind', { maximum: 120 });
    if (!['api_key', 'oauth'].includes(kind)) {
      fail('Bot credential kind is invalid', 'bot_credential_kind_invalid', 400);
    }
    const metadata = sanitizeBotCredentialMetadata(
      validateBoundedJsonObject(request.metadata, 'metadata'),
    );
    if (Object.hasOwn(metadata, 'maskedIdentifier')
      && (typeof metadata.maskedIdentifier !== 'string'
        || !/^••••\S{4}$/u.test(metadata.maskedIdentifier))) {
      delete metadata.maskedIdentifier;
    }
    if (Object.hasOwn(metadata, 'rotatedAt')
      && (typeof metadata.rotatedAt !== 'string'
        || !Number.isFinite(Date.parse(metadata.rotatedAt)))) {
      delete metadata.rotatedAt;
    }
    const current = await store.get('bot_credentials', { id, bot_id: decision.bot.id });
    if (!current) {
      fail(
        'New Bot credentials require a write-only API key or an existing OAuth connection',
        'bot_credential_secret_required',
        400,
      );
    }
    if (current.provider !== provider || current.kind !== kind
      || current.credential_scope !== credentialScope
      || (current.owner_user_id || null) !== ownerUserId) {
      fail('Bot credential identity is immutable', 'bot_credential_identity_invalid', 409);
    }
    const row = await store.updateIfRevision(
      'bot_credentials',
      { id, bot_id: decision.bot.id },
      { metadata },
      normalizeExpectedRevision(request.expectedUpdatedAt),
    );
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_credential',
      targetId: id,
      action: 'bot.credential.update_metadata',
      result: 'success',
      metadata: { provider, credentialScope },
    });
    return Object.freeze({ credential: publicCredential(row) });
  };

  const createOAuthCredentialConnection = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot OAuth connection',
      required: [
        'provider',
        'connectionId',
        'label',
        'kind',
        'credentialScope',
        'ownerUserId',
      ],
    });
    const provider = validateBoundedString(request.provider, 'provider', {
      maximum: 120,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,
    });
    const connectionId = validateBoundedString(request.connectionId, 'connectionId', {
      maximum: 160,
      pattern: /^host:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,
    });
    const label = validateBoundedString(request.label, 'label', { maximum: 120 });
    if (request.kind !== 'oauth') {
      fail('Bot OAuth connection kind is invalid', 'bot_credential_kind_invalid', 400);
    }
    const credentialScope = request.credentialScope;
    if (!['team', 'user'].includes(credentialScope)) {
      fail('Bot credential scope is invalid', 'bot_credential_scope_invalid', 400);
    }
    const ownerUserId = validateOptionalUuid(request.ownerUserId, 'ownerUserId');
    if ((credentialScope === 'team' && ownerUserId !== null)
      || (credentialScope === 'user' && ownerUserId === null)) {
      fail('Bot credential owner does not match its scope', 'bot_credential_scope_invalid', 400);
    }
    // Every Bot shares one computer, so its credentials are team-scoped.
    const expectedScope = 'team';
    if (credentialScope !== expectedScope
      || (credentialScope === 'user' && ownerUserId !== principal.id)) {
      fail(
        'Bot credentials are shared by the whole Bot and must be team-scoped',
        'bot_credential_scope_invalid',
        409,
      );
    }

    const options = await loadSafeModelOptions();
    const liveProvider = options.providers.find((entry) => entry.id === provider);
    const liveConnection = liveProvider?.available === true
      ? liveProvider.connections.find((entry) => entry.id === connectionId)
      : null;
    if (liveProvider?.authType !== 'oauth' || !liveConnection) {
      fail(
        'The selected OAuth provider connection is unavailable',
        'bot_oauth_connection_unavailable',
        409,
      );
    }

    const oauthMetadata = provider === 'openai'
      ? (await getOAuthConnections())?.bindingMetadata()
      : null;
    if (provider === 'openai' && !oauthMetadata) fail('Managed OAuth is unavailable', 'bot_oauth_coordinator_unavailable', 503);
    const id = uuid();
    const row = await store.insert('bot_credentials', {
      id,
      bot_id: decision.bot.id,
      provider,
      kind: 'oauth',
      credential_scope: credentialScope,
      owner_user_id: ownerUserId,
      local_vault_reference: `bot-credential:${id}`,
      metadata: { label, connectionId, ...oauthMetadata },
      status: 'active',
      created_by: validateUuid(principal.id, 'principal.id'),
      revoked_at: null,
    });
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_credential',
      targetId: id,
      action: 'bot.credential.connect_oauth',
      result: 'success',
      metadata: { provider, credentialScope, kind: 'oauth' },
    });
    return Object.freeze({ credential: publicCredential(row) });
  };

  const reconnectCredentialConnection = async (principal, botId, credentialId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, { label: 'Bot OAuth reconnection', required: ['connectionId', 'expectedUpdatedAt'] });
    if (request.connectionId !== 'host:openai') fail('OAuth connection is invalid', 'bot_oauth_connection_unavailable', 409);
    const current = await store.get('bot_credentials', { id: validateUuid(credentialId, 'credentialId'), bot_id: decision.bot.id });
    if (!current || current.status !== 'active' || current.revoked_at !== null) fail('Active Bot credential not found', 'bot_credential_not_found', 404);
    if (!isHostOpenAiCredential(current)) fail('Only host OpenAI OAuth can be reconnected here', 'bot_credential_kind_invalid', 409);
    const expectedUpdatedAt = normalizeExpectedRevision(request.expectedUpdatedAt);
    if (current.updated_at !== expectedUpdatedAt) fail('Bot credential changed', 'bot_revision_conflict', 409);
    const connections = await getOAuthConnections();
    if (!connections) fail('Managed OAuth is unavailable', 'bot_oauth_coordinator_unavailable', 503);
    const row = await connections.reconnect(current, expectedUpdatedAt);
    await audit({ principal, botId: decision.bot.id, targetType: 'bot_credential', targetId: current.id,
      action: 'bot.credential.reconnect_oauth', result: 'success', metadata: { provider: 'openai', credentialScope: current.credential_scope } });
    return { credential: publicCredential(row, await connections.authState(row)) };
  };

  const createCredentialConnection = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot API key connection',
      required: ['provider', 'label', 'kind', 'credentialScope', 'ownerUserId', 'secret'],
    });
    const provider = validateBoundedString(request.provider, 'provider', {
      maximum: 120,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,
    });
    const label = validateBoundedString(request.label, 'label', { maximum: 120 });
    if (request.kind !== 'api_key') {
      fail('Bot API key connection kind is invalid', 'bot_credential_kind_invalid', 400);
    }
    const credentialScope = request.credentialScope;
    if (!['team', 'user'].includes(credentialScope)) {
      fail('Bot credential scope is invalid', 'bot_credential_scope_invalid', 400);
    }
    const ownerUserId = validateOptionalUuid(request.ownerUserId, 'ownerUserId');
    if ((credentialScope === 'team' && ownerUserId !== null)
      || (credentialScope === 'user' && ownerUserId === null)) {
      fail('Bot credential owner does not match its scope', 'bot_credential_scope_invalid', 400);
    }
    // Every Bot shares one computer, so its credentials are team-scoped.
    const expectedScope = 'team';
    if (credentialScope !== expectedScope
      || (credentialScope === 'user' && ownerUserId !== principal.id)) {
      fail(
        'Bot credentials are shared by the whole Bot and must be team-scoped',
        'bot_credential_scope_invalid',
        409,
      );
    }
    const apiKey = validateBoundedString(request.secret, 'secret', {
      minimum: 8,
      maximum: 256 * 1024,
      pattern: /^\S+$/u,
    });
    const maskedIdentifier = `••••${apiKey.slice(-4)}`;
    const vault = getCredentialVault();
    if (!vault || typeof vault.create !== 'function' || typeof vault.toSupabaseRecord !== 'function') {
      fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
    }
    const id = uuid();
    await vault.create({
      id,
      botId: decision.bot.id,
      provider,
      kind: 'api_key',
      credentialScope,
      ownerUserId,
      createdBy: validateUuid(principal.id, 'principal.id'),
      metadata: { label, maskedIdentifier },
      secret: { type: 'api', key: apiKey },
    });
    let row;
    try {
      const persisted = vault.toSupabaseRecord(id);
      row = await store.insert('bot_credentials', {
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
    } catch (error) {
      try {
        await vault.deleteCreated?.(id);
      } catch (cleanupError) {
        fail(
          'Bot credential persistence failed and encrypted vault cleanup requires recovery',
          'bot_credential_cleanup_failed',
          500,
          {
            persistCode: typeof error?.code === 'string' ? error.code : 'bot_credential_persist_failed',
            cleanupCode: typeof cleanupError?.code === 'string'
              ? cleanupError.code
              : 'bot_credential_cleanup_failed',
          },
        );
      }
      throw error;
    }
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_credential',
      targetId: id,
      action: 'bot.credential.create',
      result: 'success',
      metadata: { provider, credentialScope, kind: 'api_key' },
    });
    return Object.freeze({ credential: publicCredential(row) });
  };

  const rotateCredentialConnection = async (principal, botId, credentialId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot API key rotation',
      required: ['secret', 'expectedUpdatedAt'],
    });
    const id = validateUuid(credentialId, 'credentialId');
    const current = await store.get('bot_credentials', { id, bot_id: decision.bot.id });
    if (!current || current.revoked_at !== null || current.status !== 'active') {
      fail('Active Bot credential not found', 'bot_credential_not_found', 404);
    }
    if (current.kind !== 'api_key') {
      fail('Only API key connections can be replaced here', 'bot_credential_kind_invalid', 409);
    }
    const expectedUpdatedAt = normalizeExpectedRevision(
      request.expectedUpdatedAt,
      'expectedUpdatedAt',
    );
    if (current.updated_at !== expectedUpdatedAt) {
      fail('Bot credential changed before it could be replaced', 'bot_revision_conflict', 409);
    }
    const apiKey = validateBoundedString(request.secret, 'secret', {
      minimum: 8,
      maximum: 256 * 1024,
      pattern: /^\S+$/u,
    });
    const maskedIdentifier = `••••${apiKey.slice(-4)}`;
    const vault = getCredentialVault();
    if (!vault || typeof vault.read !== 'function' || typeof vault.rotate !== 'function'
      || typeof vault.toSupabaseRecord !== 'function') {
      fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
    }
    const previous = await vault.read(id);
    if (previous.credential.botId !== decision.bot.id) {
      fail('Bot credential identity is invalid', 'bot_credential_identity_invalid', 409);
    }
    const rotated = await vault.rotate(
      id,
      { type: 'api', key: apiKey },
      {
        ...current.metadata,
        label: typeof current.metadata?.label === 'string'
          ? current.metadata.label
          : current.provider,
        maskedIdentifier,
      },
    );
    let row;
    try {
      const persisted = vault.toSupabaseRecord(id);
      row = await store.updateIfRevision(
        'bot_credentials',
        { id, bot_id: decision.bot.id },
        {
          metadata: persisted.metadata,
          status: persisted.status,
          revoked_at: persisted.revoked_at,
        },
        expectedUpdatedAt,
      );
    } catch (error) {
      try {
        if (typeof vault.rollbackRotation === 'function') {
          await vault.rollbackRotation(id, rotated.secretVersion, previous);
        } else {
          await vault.rotate(id, previous.secret);
        }
      } catch (rollbackError) {
        fail(
          'Bot credential rotation failed and encrypted vault rollback requires recovery',
          'bot_credential_rotation_rollback_failed',
          500,
          {
            persistCode: typeof error?.code === 'string' ? error.code : 'bot_credential_persist_failed',
            rollbackCode: typeof rollbackError?.code === 'string'
              ? rollbackError.code
              : 'bot_credential_rollback_failed',
          },
        );
      }
      throw error;
    }
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_credential',
      targetId: id,
      action: 'bot.credential.rotate',
      result: 'success',
      metadata: { provider: current.provider, credentialScope: current.credential_scope },
    });
    return Object.freeze({ credential: publicCredential(row) });
  };

  const saveEvalCase = async (principal, botId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot evaluation case',
      required: ['name', 'input', 'expectedOutcome'],
      optional: ['id', 'expectedUpdatedAt'],
    });
    const id = request.id === undefined ? uuid() : validateUuid(request.id, 'evalCaseId');
    const name = validateBoundedString(request.name, 'name', { maximum: 160 });
    const input = validateBoundedJsonObject(request.input, 'input', 64 * 1024);
    const expectedOutcome = validateBoundedJsonObject(
      request.expectedOutcome,
      'expectedOutcome',
      64 * 1024,
    );
    const envelope = await withKey(async (key) => encryptBotJson({
      key,
      keyId: DEPLOYMENT_KEY_ID,
      value: input,
      associatedData: evalCaseAssociatedData(decision.bot.id, id),
    }));
    const current = await store.get('bot_eval_cases', { id, bot_id: decision.bot.id });
    const row = current
      ? await store.updateIfRevision(
          'bot_eval_cases',
          { id, bot_id: decision.bot.id },
          { name, input_envelope: envelope, expected_outcome: expectedOutcome, archived_at: null },
          normalizeExpectedRevision(request.expectedUpdatedAt),
        )
      : await store.insert('bot_eval_cases', {
          id,
          bot_id: decision.bot.id,
          name,
          input_envelope: envelope,
          expected_outcome: expectedOutcome,
          created_by: validateUuid(principal.id, 'principal.id'),
          archived_at: null,
        });
    const evalCase = await withKey(async (key) => decryptEvalCase(row, key));
    return Object.freeze({ evalCase });
  };

  const runEvalCase = async (principal, botId, evalCaseId, request) => {
    const decision = await managerDecision(principal, botId);
    assertExactObject(request, {
      label: 'Bot evaluation run',
      required: ['revisionId', 'mode', 'confirmed', 'confirmation'],
    });
    if (!['simulation', 'live_canary'].includes(request.mode)) {
      fail('Bot evaluation mode is invalid');
    }
    const revision = await store.get('bot_revisions', {
      id: validateUuid(request.revisionId, 'revisionId'),
      bot_id: decision.bot.id,
    });
    if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
    if (revision.activated_at !== null) {
      fail('Test Lab runs only Draft revisions', 'bot_test_revision_not_draft', 409);
    }
    if (request.mode === 'live_canary'
      && (request.confirmed !== true || request.confirmation !== decision.bot.name)) {
      fail('Live canary requires the exact Bot name', 'bot_live_canary_confirmation_required', 409);
    }
    if (request.mode === 'simulation' && request.confirmed !== false) {
      fail('Simulation cannot request live-write confirmation', 'bot_simulation_escape_blocked', 400);
    }
    const evalCaseRow = await store.get('bot_eval_cases', {
      id: validateUuid(evalCaseId, 'evalCaseId'),
      bot_id: decision.bot.id,
    });
    if (!evalCaseRow || evalCaseRow.archived_at !== null) {
      fail('Bot evaluation case not found', 'bot_eval_case_not_found', 404);
    }
    const evalCase = await withKey(async (key) => decryptEvalCase(evalCaseRow, key));
    const startedAt = now().toISOString();
    let row = await store.insert('bot_eval_runs', {
      id: uuid(),
      eval_case_id: evalCase.id,
      revision_id: revision.id,
      mode: request.mode,
      state: 'running',
      result: null,
      initiated_by: validateUuid(principal.id, 'principal.id'),
      started_at: startedAt,
      finished_at: null,
    });
    const computerScopeKey = `test:${decision.bot.id}:${principal.id}`;
    try {
      const result = validateBoundedJsonObject(await testRunner.run(Object.freeze({
        principal: Object.freeze({ id: principal.id }),
        bot: publicBot(decision.bot),
        revision: publicRevision(revision, true),
        evalCase,
        mode: request.mode,
        computerScopeKey,
        writeMode: request.mode === 'simulation' ? 'simulated' : 'live',
        executeMutations: request.mode === 'live_canary',
      })), 'result', 128 * 1024);
      row = await store.updateIfRevision(
        'bot_eval_runs',
        { id: row.id },
        { state: 'completed', result, finished_at: now().toISOString() },
        row.updated_at,
      );
    } catch (error) {
      row = await store.updateIfRevision(
        'bot_eval_runs',
        { id: row.id },
        {
          state: 'failed',
          result: {
            code: typeof error?.code === 'string' ? error.code : 'bot_eval_failed',
            message: error instanceof Error ? error.message.slice(0, 500) : 'Evaluation failed',
          },
          finished_at: now().toISOString(),
        },
        row.updated_at,
      );
    }
    await audit({
      principal,
      botId: decision.bot.id,
      targetType: 'bot_eval_run',
      targetId: row.id,
      action: request.mode === 'simulation' ? 'bot.eval.simulate' : 'bot.eval.live_canary',
      result: row.state === 'completed' ? 'success' : 'failure',
      metadata: { revisionId: revision.id, computerScopeKey, writeMode: request.mode },
    });
    return Object.freeze({ run: publicEvalRun(row) });
  };

  const purgePreview = async (principal, botId) => {
    const decision = await managerDecision(principal, botId);
    const count = async (tableName, filters) => (
      (await listRows(tableName, filters)).length
    );
    const [
      channels,
      sharedMemory,
      privateMemory,
      skillPackages,
      mcpBindings,
      objects,
      credentials,
    ] = await Promise.all([
      count('bot_channels', { bot_id: decision.bot.id }),
      count('bot_memories', { bot_id: decision.bot.id, scope: 'shared' }),
      count('bot_memories', { bot_id: decision.bot.id, scope: 'user_private' }),
      count('bot_skill_packages', { bot_id: decision.bot.id }),
      count('bot_mcp_bindings', { bot_id: decision.bot.id }),
      count('bot_objects', { bot_id: decision.bot.id }),
      count('bot_credentials', { bot_id: decision.bot.id }),
    ]);
    return Object.freeze({
      bot: publicBot(decision.bot),
      requiresTypedName: decision.bot.name,
      resources: Object.freeze([
        { id: 'channels', label: 'Channels and transcripts', count: channels, disposition: 'delete' },
        { id: 'shared_memory', label: 'Shared memory', count: sharedMemory, disposition: 'delete' },
        { id: 'private_memory', label: 'Private memory', count: privateMemory, disposition: 'delete' },
        {
          id: 'capability_bindings',
          label: 'Skill and MCP bindings',
          count: skillPackages + mcpBindings,
          disposition: 'delete',
        },
        { id: 'objects', label: 'Encrypted objects', count: objects, disposition: 'delete' },
        { id: 'credentials', label: 'Credential metadata and vault entries', count: credentials, disposition: 'delete' },
        { id: 'browser_profiles', label: 'Browser profiles', count: 1, disposition: 'delete-local' },
        { id: 'workspaces', label: 'Scoped workspaces', count: 1, disposition: 'delete-local' },
        { id: 'indexes', label: 'Local retrieval indexes', count: 1, disposition: 'delete-local' },
        { id: 'audit', label: 'Security audit', count: null, disposition: 'retain-by-policy' },
      ].map((resource) => Object.freeze(resource))),
      irreversible: true,
      resumable: true,
      policy: 'An active Manager or global administrator must approve every purge attempt.',
    });
  };

  const invalidating = (operation) => async (...args) => {
    const result = await operation(...args);
    onRuntimeInvalidated();
    return result;
  };

  return Object.freeze({
    canCreateBot,
    listCatalog,
    getDetail,
    create: invalidating(create),
    updateProfile,
    downloadAvatar,
    modelOptions,
    createRevision: invalidating(createRevision),
    createImportedDraft: invalidating(createImportedDraft),
    updateImportedDraftBindings: invalidating(updateImportedDraftBindings),
    updateDraftRevision: invalidating(updateDraftRevision),
    activationHealth,
    activateRevision: invalidating(activateRevision),
    publishRevision: invalidating(publishRevision),
    transitionLifecycle: invalidating(transitionLifecycle),
    setMembership: invalidating(setMembership),
    revokeMembership: invalidating(revokeMembership),
    searchDirectory,
    saveCredentialMetadata: invalidating(saveCredentialMetadata),
    createOAuthCredentialConnection: invalidating(createOAuthCredentialConnection),
    reconnectCredentialConnection: invalidating(reconnectCredentialConnection),
    createCredentialConnection: invalidating(createCredentialConnection),
    rotateCredentialConnection: invalidating(rotateCredentialConnection),
    listEvalCases,
    saveEvalCase,
    runEvalCase,
    purgePreview,
  });
}
