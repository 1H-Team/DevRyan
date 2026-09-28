import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PRODUCTION_BOTS_MIGRATION,
  productionBotsMigrationFailurePayload,
} from '../multi-user/auth-compat.js';
import { translateDirectoryValue } from '../multi-user/path-translation.js';
import { getMcpOAuthCredential, listMcpConfigs } from '../opencode/mcp.js';
import { discoverSkills } from '../opencode/skills.js';
import { createBotActionGateway } from './action-gateway.js';
import { createBotAgentConnections } from './agent-connections.js';
import { createBotApprovalService } from './approval-service.js';
import { createBotArtifactService } from './artifact-service.js';
import { createBotAuditQuery } from './audit-query.js';
import { createBotAuditRetention } from './audit-retention.js';
import { createBotAuthorization } from './authorization.js';
import { createBotBlobStore } from './blob-store.js';
import { createBotBrowserService } from './browser-service.js';
import { createBotChannels } from './channels.js';
import { createBotCatalogVisibility } from './catalog-visibility.js';
import { createBotCapabilityBindings } from './capability-bindings.js';
import { createBotConfigCompiler } from './config-compiler.js';
import { createBotComputerRuntimeManager } from './computer-runtime-manager.js';
import { createBotComputerResources } from './computer-resources.js';
import { createDockerBotComputerBackend } from './computer-backend.js';
import { createBotConnectorRegistry } from './connector-registry.js';
import { createBotContextAssembler } from './context-assembler.js';
import { createBotCredentialVault } from './credential-vault.js';
import { createBotTelegramService } from './telegram/service.js';
import { registerBotTelegramRoutes } from './telegram-routes.js';
import { createBotVoiceService } from './bot-voice.js';
import { registerBotVoiceRoutes } from './bot-voice-routes.js';
import { createBotEnvironmentSecretVault } from './environment-secret-vault.js';
import { createBotEnvironmentSecrets } from './environment-secrets.js';
import { createBotDockerProvider } from './docker-provider.js';
import { createBotEvidenceService } from './evidence-service.js';
import { BotGatewayHostError, createBotGatewayHost } from './gateway-host.js';
import { createBotEventStream } from './event-stream.js';
import { createBotModelCredentialBroker } from './model-credential-broker.js';
import { createBotManagement } from './management.js';
import { createBotMcpConnectorHost } from './mcp-connector.js';
import { createBotWorkspaceConnector } from './workspace-connector.js';
import { createBotIndexerClient } from './indexer-client.js';
import { createBotMemoryRuntime } from './memory-runtime.js';
import { createBotLibraryRuntime } from './library-runtime.js';
import { createBotOpenCodeProvider } from './opencode-provider.js';
import { createOpenCodeReasoningAdapter } from './opencode-reasoning-adapter.js';
import { createBotReasoningAdapterRegistry } from './reasoning-adapter.js';
import { createBotPolicyEngine } from './policy-engine.js';
import { createBotPrewarmCache } from './prewarm-cache.js';
import { createBotRoutineDrafter } from './routine-drafter.js';
import { createBotRoutineRuntime } from './routine-runtime.js';
import { createBotRunDispatcher } from './run-dispatcher.js';
import { createBotRunRecovery } from './run-recovery.js';
import { createBotSharedFileService } from './shared-files.js';
import { createBotSharedConnector } from './shared-connector.js';
import { createBotStreamAccessLeases } from './stream-access-lease.js';
import { createBotRecoveryBundleRuntime } from './recovery-bundle.js';
import { createBotPurgeRuntime } from './purge-runtime.js';
import { createBotPurgeAdapter, createBotRecoveryAdapter } from './recovery-adapter.js';
import { createBotHostStatusCache, registerBotRoutes, resolveBotCapabilities } from './routes.js';
import { createBotStore } from './store.js';
import { createLocalBotCatalogTransport } from './local-catalog.js';
import { createLocalBotObjectStorage } from './local-object-storage.js';
import { BOT_OWNER_SCOPE } from './local-owner.js';
import { createBotActivationHold } from './activation-hold.js';
import { createBotCatalogMaintenance } from './catalog-maintenance.js';
import { registerBotCatalogRoutes } from './catalog-routes.js';
import { createBotCatalogImport } from './catalog-import.js';
import { createBotSourceScanner } from './source-scanner.js';
import { createBotSpecService } from './bot-spec.js';
import { createBotSpecSigner } from './bot-spec-signer.js';
import { runBotStructuredTask } from './structured-task.js';
import { botErrorLogFields } from './error-normalization.js';
import { createBotPeriodicJob } from './periodic-job.js';

const defaultPrincipalPolicy = Object.freeze({
  isGlobalAdmin: (principal) => (
    principal?.role === 'admin'
    && (principal?.scope === 'managed' || principal?.scope === 'local-admin')
  ),
});

const MEMORY_START_RETRY_MIN_MS = 15_000;
const MEMORY_START_RETRY_MAX_MS = 5 * 60 * 1000;

const BOT_STARTUP_FAILURE_MESSAGES = Object.freeze({
  bot_runtime_docker_not_installed: 'Docker is not installed. Install Docker, then retry Bot preparation.',
  bot_runtime_docker_unavailable: 'Docker is installed but is not running or cannot be reached.',
  bot_runtime_manifest_required: 'Bot runtime release metadata is missing. Install the latest DevRyan update.',
  bot_runtime_manifest_invalid: 'Bot runtime release metadata is invalid. Install the latest DevRyan update.',
  bot_runtime_state_invalid: 'The private Bot runtime installation state is outdated or invalid. Run Setup to reinstall it.',
  bot_runtime_state_unreadable: 'The private Bot runtime installation state cannot be read. Check its permissions, then retry.',
  bot_runtime_setup_required: 'The private Bot runtime needs to be installed.',
  bot_runtime_update_required: 'The private Bot runtime needs to be updated before it can run.',
  bot_runtime_setup_failed: 'The private Bot runtime could not be installed.',
  bot_runtime_repair_failed: 'The private Bot runtime could not be repaired.',
  bot_runtime_update_failed: 'The private Bot runtime could not be updated.',
  bot_runtime_startup_timeout: 'Bot preparation timed out. Check Docker and the network, then retry.',
  bot_runtime_degraded: 'The private Bot runtime did not become healthy.',
  bot_runtime_execution_unavailable: 'Shared Bot services did not become ready.',
});

const botStartupFailure = (error) => {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = Object.hasOwn(BOT_STARTUP_FAILURE_MESSAGES, rawCode)
    ? rawCode
    : 'bot_runtime_warmup_failed';
  return Object.freeze({
    state: 'failed',
    code,
    message: BOT_STARTUP_FAILURE_MESSAGES[code] || 'Shared Bot services could not be prepared.',
  });
};

export const BOT_SWEEP_IDLE_WINDOW_MS = 6 * 60 * 60 * 1000;
// Mirrors the dispatcher's run timeout: a run this process started stays live
// for the sweep gate at most this long once the dispatcher stops reporting it.
export const BOT_SWEEP_LIVE_RUN_GRACE_MS = 15 * 60 * 1000;

const BOT_ACTIVITY_METHODS = Object.freeze([
  'enqueueMessage',
  'drainScope',
  'resumeRun',
  'retryRun',
  'cancelRun',
  'failQueuedRun',
  'prewarmChannel',
]);

const isoOrNull = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const INACTIVE_BOT_SWEEP_DIAGNOSTICS = Object.freeze({
  idle: false,
  liveRunCount: 0,
  lastActivityAt: null,
  lastSweepAt: null,
  lastSweepSkipped: false,
  idleWindowMs: BOT_SWEEP_IDLE_WINDOW_MS,
});

// The queued-run sweep only has work while runs exist, yet on its own it pages
// the run store every 30 s and probes Docker for anything it decides to resume.
// With nobody using a Bot that is pure load, so the sweep is skipped once the
// runtime is idle: no run this process knows about is live and nothing was
// enqueued, drained, started or settled within the idle window. The first
// sweep after start always runs so restart recovery keeps its safety net, and
// the periodic job keeps ticking so the next activity re-enables sweeping.
export function createBotRunSweepGate({
  now = Date.now,
  idleWindowMs = BOT_SWEEP_IDLE_WINDOW_MS,
  liveRunGraceMs = BOT_SWEEP_LIVE_RUN_GRACE_MS,
  isExecuting = () => false,
  logger = null,
} = {}) {
  if (typeof now !== 'function' || typeof isExecuting !== 'function'
    || !Number.isFinite(idleWindowMs) || idleWindowMs < 0
    || !Number.isFinite(liveRunGraceMs) || liveRunGraceMs < 0) {
    throw new TypeError('Bot run sweep gate configuration is invalid');
  }
  const liveRuns = new Map();
  let lastActivityAt = now();
  let lastSweepAt = null;
  let lastSweepSkipped = false;
  let idle = false;

  const noteActivity = () => {
    lastActivityAt = now();
  };
  const liveRunCount = () => {
    const at = now();
    for (const [runId, startedAt] of liveRuns) {
      if (!isExecuting(runId) && at - startedAt >= liveRunGraceMs) liveRuns.delete(runId);
    }
    return liveRuns.size;
  };
  const shouldSweep = () => (
    lastSweepAt === null
    || liveRunCount() > 0
    || now() - lastActivityAt < idleWindowMs
  );
  const setIdle = (next) => {
    if (next === idle) return;
    idle = next;
    logger?.debug?.(next ? '[Bots] run sweep paused while idle' : '[Bots] run sweep resumed', {
      job: 'run_sweep',
      lastActivityAt: isoOrNull(lastActivityAt),
      idleWindowMs,
    });
  };

  return Object.freeze({
    noteActivity,
    noteRunStarted(runId) {
      noteActivity();
      if (typeof runId === 'string' && runId) liveRuns.set(runId, now());
    },
    noteRunSettled(runId) {
      noteActivity();
      if (typeof runId === 'string') liveRuns.delete(runId);
    },
    shouldSweep,
    // Runs `sweep` unless the runtime is idle, in which case it resolves null
    // without touching the store or Docker.
    async sweep(sweep) {
      if (typeof sweep !== 'function') throw new TypeError('Bot run sweep requires a sweep function');
      if (!shouldSweep()) {
        lastSweepSkipped = true;
        setIdle(true);
        return null;
      }
      setIdle(false);
      lastSweepSkipped = false;
      lastSweepAt = now();
      return sweep();
    },
    diagnostics() {
      return Object.freeze({
        idle,
        liveRunCount: liveRunCount(),
        lastActivityAt: isoOrNull(lastActivityAt),
        lastSweepAt: isoOrNull(lastSweepAt),
        lastSweepSkipped,
        idleWindowMs,
      });
    },
  });
}

// The dispatcher is a frozen object of closures (no `this`), so a delegating
// facade can count every externally initiated enqueue/drain/resume/retry/cancel
// as Bot activity without the dispatcher knowing about the sweep gate.
// Accessors are forwarded live; everything else is copied as-is.
export function trackBotDispatcherActivity(dispatcher, noteActivity) {
  if (!dispatcher || typeof dispatcher !== 'object' || typeof noteActivity !== 'function') {
    throw new TypeError('Bot dispatcher activity tracking is misconfigured');
  }
  const tracked = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(dispatcher))) {
    if (typeof descriptor.get === 'function') {
      Object.defineProperty(tracked, name, {
        enumerable: descriptor.enumerable,
        get: () => descriptor.get.call(dispatcher),
      });
      continue;
    }
    const value = descriptor.value;
    tracked[name] = typeof value === 'function' && BOT_ACTIVITY_METHODS.includes(name)
      ? (...args) => {
        noteActivity();
        return value(...args);
      }
      : value;
  }
  return Object.freeze(tracked);
}

// Bots always persist to the local catalog owned by the Electron host. Tests
// may inject a repository transport through `supabase`; production derives it
// from `botHost.catalog`. The cloud connection is never a Bot store.
export function createBotsRuntime({
  supabase = null,
  audit = async () => {},
  principalPolicy = defaultPrincipalPolicy,
  dataDirectory,
  botHost = Object.freeze({ owner: 'unsupported' }),
  encryption = Object.freeze({ getKey: null }),
  withAuditDeliveryBarrier = async (operation) => operation(),
  recordDiagnostic = () => {},
  executionEnabled = true,
  isAdmissionPaused = () => false,
  resolvePrincipal = null,
  oauthCoordinator = null,
  localOwner = null,
  // Optional cloud member directory (Supabase enabled). Results are mirrored
  // as display projections so a Manager can assign any current cloud user.
  searchCloudDirectory = null,
  // Read-only cloud import source ({ url, secretKey } or null) and the
  // workstation owner's verified cloud identity (never inferred by email).
  readCloudSource = null,
  resolveVerifiedSourceOwner = null,
  // Whether this host may look for hosted Bots on its own. Only a connected
  // Supabase does; with Supabase off or absent the hosted project is contacted
  // solely when the owner asks (check or import).
  discoverCloudSource = false,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    throw new TypeError('Bots runtime requires an absolute data directory');
  }
  if (typeof audit !== 'function' || typeof recordDiagnostic !== 'function') {
    throw new TypeError('Bots runtime requires audit and diagnostic functions');
  }

  let objectStoragePromise = null;
  const objectStorage = () => {
    objectStoragePromise ||= createLocalBotObjectStorage({
      directory: path.join(dataDirectory, 'bots', 'objects'),
      assertWritable: (operation) => assertCatalogWritable(operation),
    }).catch((error) => {
      objectStoragePromise = null;
      throw error;
    });
    return objectStoragePromise;
  };
  const localCatalog = !supabase && botHost?.catalog
    ? createLocalBotCatalogTransport({
        catalog: botHost.catalog,
        objectStorage: Object.freeze({
          storageUpload: async (...args) => (await objectStorage()).storageUpload(...args),
          storageDownload: async (...args) => (await objectStorage()).storageDownload(...args),
          storageDelete: async (...args) => (await objectStorage()).storageDelete(...args),
        }),
      })
    : null;
  const transport = supabase || localCatalog;
  // Writes are fenced during maintenance (backup, import, restore, migration).
  let maintenanceFence = null;
  // Runs after every successful catalog start (owner identity projection).
  let onCatalogReady = null;
  // Catalog recovery routes (status, backups, restore, start empty, import)
  // registered ahead of the catalog readiness gate.
  const recoveryRouteRegistrars = [];
  // Set once the cloud importer exists (it needs the maintenance fence).
  const catalogImportRef = { current: null };
  function assertCatalogWritable(operation) {
    if (!maintenanceFence) return;
    throw Object.assign(new Error('Bots are paused for maintenance'), {
      code: 'bots_maintenance',
      statusCode: 503,
      retryable: true,
      operation,
    });
  }
  const catalogState = () => (localCatalog
    ? localCatalog.getState()
    : Object.freeze({ state: transport ? 'ready' : 'unavailable', code: transport ? null : 'bot_database_unavailable', generation: 0 }));
  const catalogReady = () => catalogState().state === 'ready';
  const activationHold = createBotActivationHold({ dataDirectory });
  // Database outages, maintenance and a post-import/restore activation hold
  // close new admissions immediately, including background work; admitted
  // work drains on its own terms.
  const admissionPaused = () => isAdmissionPaused() === true || !catalogReady()
    || maintenanceFence !== null || activationHold.isHeld();
  const describeAdmissionPause = () => {
    if (maintenanceFence) return { message: 'Bots are paused for maintenance', code: 'bots_maintenance' };
    if (activationHold.isHeld()) {
      return { message: 'Bots are paused until the owner resumes them after an import or restore', code: 'bots_activation_hold' };
    }
    if (!catalogReady()) return { message: 'The local Bot catalog is unavailable', code: catalogState().code || 'bot_database_unavailable' };
    return { message: 'Supabase connection is changing', code: 'supabase_change_pending' };
  };
  // In-flight HTTP writes, counted by the route gate, are drained by maintenance.
  let inflightWrites = 0;
  const trackWrite = () => {
    inflightWrites += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inflightWrites -= 1;
    };
  };

  const store = createBotStore({ supabase: transport });

  // Identity. The workstation owner acts as its immutable local identity, or
  // for an imported Bot as that Bot's verified source owner (sparse mapping
  // committed with the catalog). Managed principals keep their cloud identity.
  const ownerId = typeof localOwner?.id === 'string' ? localOwner.id : null;
  const ownerMappings = new Map();
  const isOwnerPrincipal = (principal) => Boolean(ownerId)
    && principal?.scope === BOT_OWNER_SCOPE && principal.botOwner === true;
  const ownerIdentityFor = (botId) => ownerMappings.get(botId) || ownerId;
  const ownerIdentities = () => [...new Set([ownerId, ...ownerMappings.values()].filter(Boolean))];
  const isOwnerIdentity = (userId) => Boolean(ownerId) && (userId === ownerId
    || [...ownerMappings.values()].includes(userId));
  // Effective identity for one Bot. Tunnel guests act for the owner under their
  // own grant restrictions; they never become administrators.
  const effectivePrincipal = (principal, botId) => {
    if (!ownerId || typeof botId !== 'string') return principal;
    if (isOwnerPrincipal(principal) || principal?.scope === 'tunnel-bot') {
      const id = ownerIdentityFor(botId);
      return id === principal.id ? principal : Object.freeze({ ...principal, id });
    }
    return principal;
  };
  const basePrincipalPolicy = principalPolicy;
  principalPolicy = Object.freeze({
    isGlobalAdmin: (principal) => isOwnerPrincipal(principal)
      || (principal?.scope !== 'tunnel-bot' && basePrincipalPolicy?.isGlobalAdmin?.(principal) === true),
  });
  const loadOwnerMappings = async () => {
    if (!ownerId || !transport) return;
    const rows = await transport.rpc('devryan_local_bot_owner_mappings', {});
    ownerMappings.clear();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.bot_id === 'string' && typeof row?.source_owner_user_id === 'string') {
        ownerMappings.set(row.bot_id, row.source_owner_user_id);
      }
    }
  };
  const upsertIdentity = (identity) => transport.rpc('devryan_local_upsert_identity', {
    p_user_id: identity.id,
    p_email: identity.email,
    p_display_name: identity.displayName,
    p_account_kind: identity.accountKind === 'agent_test' ? 'agent_test' : 'human',
    p_role: ['admin', 'senior_developer', 'developer'].includes(identity.role) ? identity.role : 'developer',
    p_status: ['active', 'suspended', 'archived'].includes(identity.status) ? identity.status : 'active',
  });
  const ensureOwnerProjection = async () => {
    if (!ownerId || !transport) return;
    await upsertIdentity({
      id: ownerId,
      email: `owner-${ownerId}@workstation.invalid`,
      displayName: 'Workstation owner',
      role: 'admin',
      status: 'active',
    });
    await loadOwnerMappings();
  };
  // Managed accounts are mirrored as identity/display projections when they
  // use Bots; the projection never authorizes anything.
  const mirroredAt = new Map();
  const MIRROR_INTERVAL_MS = 10 * 60 * 1000;
  const mirrorManagedIdentity = async (principal) => {
    if (principal?.scope !== 'managed' || typeof principal.id !== 'string'
      || typeof principal.email !== 'string' || !catalogReady()) return;
    const at = Date.now();
    if (at - (mirroredAt.get(principal.id) || 0) < MIRROR_INTERVAL_MS) return;
    mirroredAt.set(principal.id, at);
    if (mirroredAt.size > 5_000) mirroredAt.delete(mirroredAt.keys().next().value);
    try {
      await upsertIdentity({
        id: principal.id,
        email: principal.email,
        displayName: principal.displayName || principal.email,
        accountKind: principal.accountKind,
        role: principal.role,
        status: principal.status || 'active',
      });
    } catch (error) {
      mirroredAt.delete(principal.id);
      recordDiagnostic({ type: 'lifecycle', event: 'bot.identity.mirror_failed', payload: { code: error?.code || 'bot_identity_mirror_failed' } });
    }
  };
  // Autonomous admission (routines, Telegram, speech): owner identities need
  // no cloud; any other account needs current Supabase authorization and is
  // dormant (null) when that cannot be established.
  const resolveAutonomousPrincipal = async (userId) => {
    if (isOwnerIdentity(userId)) {
      return Object.freeze({ ...localOwner.principal, id: userId });
    }
    if (typeof resolvePrincipal !== 'function') return null;
    try {
      return await resolvePrincipal(userId);
    } catch {
      return null;
    }
  };
  onCatalogReady = ensureOwnerProjection;

  // Multi-Bot reads for the owner (or its tunnel guests) cover every identity
  // it acts as; results are merged and de-duplicated by stable identifiers.
  const actsAsOwner = (principal) => Boolean(ownerId)
    && (isOwnerPrincipal(principal) || principal?.scope === 'tunnel-bot');
  const identitiesForPrincipal = (principal) => (actsAsOwner(principal)
    ? ownerIdentities()
    : [principal?.id]);
  const identityItemKey = (item) => {
    if (!item || typeof item !== 'object') return JSON.stringify(item);
    if (typeof item.id === 'string') return item.id;
    if (typeof item.messageId === 'string') return `message:${item.messageId}`;
    if (typeof item.botId === 'string' && typeof item.userId === 'string') return `member:${item.botId}:${item.userId}`;
    return JSON.stringify(item);
  };
  const mergeIdentityResults = (results) => {
    const merged = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result || {})) {
        if (Array.isArray(value)) {
          const items = merged[key] instanceof Map ? merged[key] : new Map();
          for (const item of value) {
            const itemKey = identityItemKey(item);
            if (!items.has(itemKey)) items.set(itemKey, item);
          }
          merged[key] = items;
        } else if (!Object.hasOwn(merged, key)) {
          merged[key] = value;
        }
      }
    }
    return Object.freeze(Object.fromEntries(Object.entries(merged).map(([key, value]) => [
      key,
      value instanceof Map ? Object.freeze([...value.values()]) : value,
    ])));
  };
  const forEachIdentity = async (principal, operation) => {
    const identities = identitiesForPrincipal(principal);
    if (identities.length <= 1) {
      const id = identities[0] ?? principal?.id;
      return operation(id === principal?.id ? principal : Object.freeze({ ...principal, id }));
    }
    const results = [];
    for (const id of identities) results.push(await operation(Object.freeze({ ...principal, id })));
    return mergeIdentityResults(results);
  };
  // Viewer-specific projections carry the identity the viewer acts as for
  // each Bot, so the UI never compares ownership against one global id.
  const viewerUserIdFor = (principal, botId) => effectivePrincipal(principal, botId)?.id ?? principal?.id ?? null;
  const withViewerIds = (principal, value) => {
    if (!value || typeof value !== 'object') return value;
    const annotate = (bot) => (bot && typeof bot.id === 'string'
      ? Object.freeze({ ...bot, viewerUserId: viewerUserIdFor(principal, bot.id) })
      : bot);
    return Object.freeze({
      ...value,
      ...(Array.isArray(value.bots) ? { bots: Object.freeze(value.bots.map(annotate)) } : {}),
      ...(value.bot && typeof value.bot === 'object' ? { bot: annotate(value.bot) } : {}),
    });
  };
  const auditRetention = createBotAuditRetention({
    store,
    platformAudit: audit,
    withAuditDeliveryBarrier,
    isPaused: () => maintenanceFence !== null,
  });
  const botAudit = (entry) => auditRetention.record(entry);
  const authorization = createBotAuthorization({
    store,
    audit: botAudit,
    principalPolicy,
  });
  const blobStore = createBotBlobStore({ store, authorization, encryption });
  const catalogVisibility = createBotCatalogVisibility({ store });
  const channels = createBotChannels({ store, authorization, encryption, filterCatalog: catalogVisibility.filterBots });
  const streamAccessLeases = createBotStreamAccessLeases({
    revalidate: (input) => channels.preflightMessage(input),
  });
  const eventStream = createBotEventStream({
    recordDiagnostic,
    principalIds: (principal) => identitiesForPrincipal(principal),
    loadSnapshot: async (principal, options) => withViewerIds(
      principal,
      await forEachIdentity(principal, (identity) => channels.snapshotForPrincipal(identity, options)),
    ),
    filterSnapshot: catalogVisibility.filterSnapshot,
    canDeliver: async (subscriberPrincipal, botId, channelId) => {
      const principal = effectivePrincipal(subscriberPrincipal, botId);
      if (!await catalogVisibility.isVisible(principal, botId)) return false;
      if (principal?.scope !== 'tunnel-bot') return true;
      try {
        if (channelId) await authorization.requireChannelRead(principal, botId, channelId);
        else await authorization.requireActiveMembership(principal, botId);
        return true;
      } catch { return false; }
    },
  });
  const dockerProvider = createBotDockerProvider({ botHost });
  const computerBackend = createDockerBotComputerBackend({ dockerProvider });
  let credentialVault = null;
  let configCompiler = null;
  const mcpHost = createBotMcpConnectorHost({
    store,
    encryption,
    getCredentialVault: () => credentialVault,
  });
  const connectorRegistry = createBotConnectorRegistry({
    // MCP bindings are retained only so deployed revisions can be inspected
    // and detached. They are deliberately absent from the execution registry.
    connectors: [createBotWorkspaceConnector({ dockerProvider })],
  });
  let capabilityBindings = null;
  capabilityBindings = createBotCapabilityBindings({
    store,
    authorization,
    blobStore,
    encryption,
    scanner: createBotSourceScanner({
      maximumFiles: 128,
      maximumFileBytes: 256 * 1024,
      maximumTotalBytes: 2 * 1024 * 1024,
      maximumTextBytes: 256 * 1024,
    }),
    discoverSkills,
    listMcpConfigs,
    resolveMcpOAuthCredential: getMcpOAuthCredential,
    resolveDirectory: translateDirectoryValue,
    mcpHost,
    getCredentialVault: () => credentialVault,
    compileRevision: (input) => configCompiler.compile(input),
    audit: botAudit,
  });
  configCompiler = createBotConfigCompiler({
    dataDirectory,
    resolveSkillPackages: (input) => capabilityBindings.resolveSkillPackages(input),
    recordDiagnostic,
  });
  const policyEngine = createBotPolicyEngine();
  let gatewayOperationHandler = null;
  // Computer containers outlive DevRyan restarts and carry the gateway address
  // they were created with, so the loopback port is remembered per deployment.
  const gatewayPortPath = path.join(dataDirectory, 'bots', 'gateway', 'port.v1.json');
  const rememberedGatewayPort = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(gatewayPortPath, 'utf8'));
      return Number.isInteger(parsed?.port) && parsed.port > 1024 && parsed.port <= 65535 ? parsed.port : 0;
    } catch {
      return 0;
    }
  };
  const rememberGatewayPort = async (port) => {
    try {
      await fs.promises.mkdir(path.dirname(gatewayPortPath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(gatewayPortPath, JSON.stringify({ version: 1, port }), { mode: 0o600 });
    } catch (error) {
      recordDiagnostic({ code: 'bot_gateway_port_persist_failed', message: error?.message || 'unknown' });
    }
  };
  const gatewayHost = createBotGatewayHost({
    port: rememberedGatewayPort(),
    onBound: rememberGatewayPort,
    handleOAuth: (claims, operation) => modelCredentialBroker.runtimeOAuth(claims, operation),
    handleOperation(input) {
      if (!gatewayOperationHandler) {
        throw new BotGatewayHostError(
          'Bot gateway operation is unavailable',
          'bot_gateway_operation_unavailable',
          503,
        );
      }
      return gatewayOperationHandler(input);
    },
  });
  const computerRuntimeManager = createBotComputerRuntimeManager({
    store,
    computerBackend,
    gatewayHost,
    encryption,
    recordDiagnostic,
  });
  const browserService = createBotBrowserService({
    store,
    authorization,
    gatewayHost,
    computerRuntimeManager,
    eventStream,
    audienceForChannel: (channelId) => channels.audienceForChannel(channelId),
    audit: botAudit,
    recordDiagnostic,
  });
  eventStream.addSnapshotSource('computer_activity', (principal, options) => forEachIdentity(
    principal,
    (identity) => browserService.activity.snapshotForPrincipal(identity, options),
  ));
  const evidenceService = createBotEvidenceService({
    store,
    blobStore,
    authorization,
    browserService,
  });
  const approvalService = createBotApprovalService({
    onPending: () => approvalExpiryJob?.trigger(),
    store,
    authorization,
    channels,
    eventStream,
    audit: botAudit,
    onRunSettled: (input) => routineSettlementHandler?.(input),
  });
  let routineSettlementHandler = null;
  const actionGateway = createBotActionGateway({
    store,
    channels,
    authorization,
    policyEngine,
    approvalService,
    browserService,
    connectorRegistry,
    evidenceService,
    eventStream,
    encryption,
    audit: botAudit,
    recordDiagnostic,
    onRunSettled: (input) => routineSettlementHandler?.(input),
    onQuestion: async (input) => {
      if (!dispatcher || typeof dispatcher.recordRunQuestion !== 'function') {
        throw Object.assign(new Error('Bot questions are unavailable'), {
          code: 'bot_question_unavailable', statusCode: 503,
        });
      }
      return dispatcher.recordRunQuestion(input);
    },
  });
  gatewayOperationHandler = actionGateway.handleGatewayOperation;
  eventStream.addSnapshotSource('operations', async (principal, options) => ({
    ...(await forEachIdentity(principal, (identity) => approvalService.snapshotForPrincipal(identity, options))),
    computers: [],
  }));
  let modelCredentialBroker = null;
  let environmentSecretVault = null;
  let environmentSecrets = null;
  let opencodeProvider = null;
  let agentConnections = null;
  let reasoningAdapterRegistry = null;
  let contextAssembler = null;
  let indexerClient = null;
  let libraryRuntime = null;
  let artifactService = null;
  let memoryRuntime = null;
  let routineDrafter = null;
  let routineRuntime = null;
  let dispatcher = null;
  let prewarmCache = null;
  const requireMemoryIndexer = () => {
    if (indexerClient) return indexerClient;
    throw Object.assign(new Error('Bot retrieval index is unavailable'), {
      code: 'bot_indexer_unavailable',
      statusCode: 503,
    });
  };
  const memoryIndexer = Object.freeze({
    upsert: (input) => requireMemoryIndexer().upsert(input),
    delete: (input) => requireMemoryIndexer().delete(input),
    rebuild: (input) => requireMemoryIndexer().rebuild(input),
    status: () => indexerClient
      ? indexerClient.status()
      : Promise.resolve(Object.freeze({ state: 'unavailable' })),
  });
  const memoryAudienceForBot = async (botId) => {
    const users = [];
    let cursor = null;
    do {
      const page = await store.repositories.bot_memberships.list({
        filters: { bot_id: botId, revoked_at: null },
        cursor,
        limit: 100,
      });
      users.push(...page.items.map((membership) => membership.user_id));
      cursor = page.nextCursor;
    } while (cursor);
    return [...new Set(users)];
  };
  const computerResources = createBotComputerResources({
    dataDirectory,
    authorization,
    dockerProvider,
    computerRuntimeManager,
    encryption,
    getIndexer: () => indexerClient,
    audit: botAudit,
  });
  memoryRuntime = createBotMemoryRuntime({
    isAdmissionPaused: admissionPaused,
    store,
    authorization,
    channels,
    encryption,
    indexer: memoryIndexer,
    prepareExtraction: (input) => dispatcher?.prepareMemoryExtraction(input),
    extractCandidates: async (input) => {
      if (!reasoningAdapterRegistry) {
        throw Object.assign(new Error('Bot reasoning runtime is unavailable'), {
          code: 'bot_memory_reasoning_unavailable',
          statusCode: 503,
        });
      }
      const selection = reasoningAdapterRegistry.forRevision(input.revision.contract);
      const binding = Object.freeze({
        ...selection.binding,
        botId: input.bot.id,
        revisionId: input.revision.id,
      });
      const runId = randomUUID();
      return runBotStructuredTask({
        adapter: selection.adapter,
        run: {
          id: runId,
          botId: input.bot.id,
          channelId: input.channel.id,
          revisionId: input.revision.id,
          ownerUserId: input.channel.owner_user_id,
          updatedAt: input.revision.updated_at || new Date().toISOString(),
        },
        contract: input.revision.contract,
        binding,
        prompt: input.prompt,
        schema: input.schema,
        title: `Bot memory extraction ${input.runId.slice(0, 8)}`,
        system: 'Extract structured memory only. Do not call tools or perform actions.',
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
    audit: botAudit,
    recordDiagnostic,
    onMemoryChanged: async ({ botId, source }) => {
      await eventStream.publish({
        kind: 'memory.changed',
        botId,
        audienceUserIds: await memoryAudienceForBot(botId),
        payload: { botId, source },
      });
      recordDiagnostic({
        type: 'lifecycle',
        event: 'bot.memory.changed',
        payload: { botId, source },
      });
    },
    loadAdditionalIndexDocuments: async () => {
      const [libraryDocuments, resourceDocuments] = await Promise.all([
        libraryRuntime?.listIndexDocuments() || [],
        computerResources.listIndexDocuments(),
      ]);
      return [...libraryDocuments, ...resourceDocuments];
    },
  });
  const sharedFileService = createBotSharedFileService({
    store,
    authorization,
    blobStore,
    dockerProvider,
    computerRuntimeManager,
    eventStream,
    channels,
    recordDiagnostic,
    onMessageReady: (computerScopeKey) => dispatcher?.drainScope(computerScopeKey),
    onMessageBlocked: (input) => dispatcher?.failQueuedRun(input),
  });
  connectorRegistry.register(createBotSharedConnector({ sharedFileService }));
  // One Docker status probe per minute serves every capabilities read (routes.js).
  const botHostStatusCache = createBotHostStatusCache();
  let runRecovery = null;
  let schemaFailure = null;
  let controlPlaneFailure = null;
  let executionFailure = executionEnabled
    ? null
    : Object.freeze({ code: 'bots_background_disabled' });
  let started = false;
  let startupState = store.available ? 'idle' : 'unavailable';
  let startPromise = null;
  let retryTimer = null;
  let credentialVaultStartPromise = null;
  let executionStartPromise = null;
  let executionRetryTimer = null;
  let executionRetryAttempt = 0;
  let approvalExpiryJob = null;
  let runSweepJob = null;
  let runRecoveryDeferred = false;
  let runSweepGate = null;
  let memoryStartRetryTimer = null;
  let memoryStartDelayMs = MEMORY_START_RETRY_MIN_MS;
  let memoryStartFailure = null;

  // Memory extraction depends on the loopback retrieval index. An index that is
  // slow or down must not take Bot chat down with it: the runtime keeps
  // executing runs, extraction jobs stay durable in the database, and the
  // memory worker keeps retrying its start with backoff until the index answers.
  const clearMemoryStartRetry = () => {
    if (memoryStartRetryTimer) clearTimeout(memoryStartRetryTimer);
    memoryStartRetryTimer = null;
  };
  const startMemoryRuntimeResiliently = async () => {
    clearMemoryStartRetry();
    if (!memoryRuntime || backgroundStopped) return false;
    try {
      await memoryRuntime.start();
      if (memoryStartFailure) {
        console.info('[BotsMemory] memory runtime started after earlier failures', {
          code: memoryStartFailure.code,
        });
      }
      memoryStartFailure = null;
      memoryStartDelayMs = MEMORY_START_RETRY_MIN_MS;
      return true;
    } catch (error) {
      const fields = botErrorLogFields(error, 'bot_memory_runtime_unavailable');
      // The runtime itself being down (Docker stopped, setup/update required)
      // is an execution failure for every service, not an index outage.
      if (/^bot_runtime_/.test(fields.code)) throw error;
      if (memoryStartFailure?.code !== fields.code) {
        console.warn('[BotsMemory] memory runtime start failed; Bots stay available and extraction resumes when the index is reachable', fields);
      }
      memoryStartFailure = { code: fields.code, since: memoryStartFailure?.since || new Date().toISOString() };
      memoryStartRetryTimer = setTimeout(() => {
        memoryStartRetryTimer = null;
        void startMemoryRuntimeResiliently();
      }, memoryStartDelayMs);
      memoryStartRetryTimer.unref?.();
      memoryStartDelayMs = Math.min(MEMORY_START_RETRY_MAX_MS, memoryStartDelayMs * 2);
      return false;
    }
  };
  let shutdownPromise = null;
  let backgroundStopped = false;
  let telegramService = null;
  let voiceService = null;
  let integrationStartPromise = null;
  const startIntegrations = async () => {
    if (!store.available || typeof encryption?.getKey !== 'function'
      || (!ownerId && typeof resolvePrincipal !== 'function')) return;
    if (telegramService) return;
    integrationStartPromise ||= (async () => {
      voiceService ||= createBotVoiceService({
        dataDirectory, encryption, authorization, resolvePrincipal: resolveAutonomousPrincipal,
      });
      telegramService = await createBotTelegramService({
        supabase: transport, store, authorization, channels, blobStore, encryption, dataDirectory,
        resolvePrincipal: resolveAutonomousPrincipal, getDispatcher: () => backgroundStopped ? null : dispatcher,
        speech: voiceService,
        isAdmissionPaused: admissionPaused,
        isOwner: () => executionEnabled && started && !backgroundStopped && !shutdownPromise,
      });
      if (executionEnabled && !backgroundStopped && !shutdownPromise) telegramService.start();
    })().finally(() => { integrationStartPromise = null; });
    return integrationStartPromise;
  };
  const auditQuery = createBotAuditQuery({
    supabase: transport,
    assertSchemaVersion: (expectedVersion) => store.assertSchemaVersion(expectedVersion),
  });
  const managementStore = typeof searchCloudDirectory === 'function'
    ? Object.freeze({
        ...store,
        async searchUserProfiles(query, limit = 20) {
          let cloud = [];
          try {
            cloud = await searchCloudDirectory(query, limit);
          } catch {
            cloud = [];
          }
          for (const row of Array.isArray(cloud) ? cloud : []) {
            await upsertIdentity({
              id: row.id,
              email: row.email,
              displayName: row.display_name || row.email,
              accountKind: row.account_kind,
              role: row.role,
              status: row.status,
            }).catch(() => undefined);
          }
          const local = await store.searchUserProfiles(query, limit);
          const byId = new Map(local.map((row) => [row.id, row]));
          for (const row of Array.isArray(cloud) ? cloud : []) {
            if (!byId.has(row.id)) byId.set(row.id, { id: row.id, display_name: row.display_name, email: row.email });
          }
          return [...byId.values()].slice(0, Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50));
        },
      })
    : store;
  const management = createBotManagement({
    store: managementStore,
    filterCatalog: catalogVisibility.filterBots,
    authorization,
    encryption,
    blobStore,
    getCredentialVault: () => credentialVault,
    getOAuthConnections: async () => (await ensureModelCredentialBroker()).oauthConnections,
    eventStream,
    loadModelCatalog: async () => {
      if (typeof botHost?.getModelCatalog !== 'function') {
        throw Object.assign(new Error('Bot model catalog is unavailable'), {
          code: 'bot_model_catalog_unavailable',
          statusCode: 503,
        });
      }
      return botHost.getModelCatalog();
    },
    audit: botAudit,
    isGlobalAdmin: (principal) => principalPolicy?.isGlobalAdmin?.(principal) === true,
    resolveCapabilities: () => resolveCurrentCapabilities(),
    async preflightModel({ principal, bot, revision, contract }) {
      if (typeof botHost?.getModelCatalog !== 'function') {
        throw Object.assign(new Error('Bot model validation is unavailable'), {
          code: 'bot_model_unavailable',
          statusCode: 503,
        });
      }
      const broker = await ensureModelCredentialBroker();
      const catalog = await botHost.getModelCatalog();
      return broker.preflightRun({
        run: {
          id: revision.id,
          botId: bot.id,
          channelId: revision.id,
          revisionId: revision.id,
          ownerUserId: principal.id,
        },
        models: contract.models,
        catalog,
      });
    },
    preflightCapabilities: (input) => capabilityBindings.preflightRevision(input),
    preflightAgent: async (input) => {
      await startCredentialVault();
      if (!agentConnections) {
        throw Object.assign(new Error('Bot AG-UI connections are unavailable'), {
          code: 'bot_agent_connection_unavailable', statusCode: 503,
        });
      }
      return agentConnections.preflightRevision(input);
    },
    preflightComputer: async ({ contract }) => {
      const isolationTier = contract.computerPolicy?.isolationTier || 'standard';
      if (isolationTier === 'standard') {
        return Object.freeze({
          id: 'computer',
          label: 'Computer isolation',
          status: 'pass',
          detail: 'Standard container isolation is available.',
        });
      }
      if (typeof botHost?.probeComputerIsolation !== 'function') {
        throw Object.assign(new Error('Hardened runsc isolation cannot be verified on this host.'), {
          code: 'bot_runtime_runsc_unavailable', statusCode: 503,
        });
      }
      const probe = await botHost.probeComputerIsolation({ isolationTier });
      return Object.freeze({
        id: 'computer',
        label: 'Computer isolation',
        status: probe?.available === true && probe?.smokePassed === true ? 'pass' : 'fail',
        detail: probe?.available === true && probe?.smokePassed === true
          ? 'Docker declared runsc and an owned disposable smoke container completed.'
          : 'runsc is unavailable or failed its owned disposable smoke container; no downgrade is allowed.',
      });
    },
    beforeActivateComputer: ({ bot, revision }) => computerRuntimeManager.ensureBot({
      ...bot,
      lifecycle: 'active',
      active_revision_id: revision.id,
    }),
    onRuntimeInvalidated: () => {
      prewarmCache?.invalidateAll();
      void dispatcher?.invalidateAll();
      streamAccessLeases.invalidateAll();
    },
    afterDeactivateComputer: async ({ bot }) => {
      browserService.onBotDeactivated({ botId: bot.id });
      return computerRuntimeManager.stopBot(bot.id);
    },
  });
  const botSpecSigner = typeof encryption?.getKey === 'function'
    ? createBotSpecSigner({ dataDirectory, encryption })
    : null;
  const botSpecService = botSpecSigner
    ? createBotSpecService({
        store,
        authorization,
        management,
        encryption,
        signer: botSpecSigner,
        audit: botAudit,
        isGlobalAdmin: (principal) => principalPolicy?.isGlobalAdmin?.(principal) === true,
      })
    : null;

  const requireCredentialVault = () => {
    if (!credentialVault) {
      throw Object.assign(new Error('Bot credential vault is unavailable'), {
        code: 'bot_credential_vault_unavailable',
        statusCode: 503,
      });
    }
    return credentialVault;
  };
  const credentialRecovery = Object.freeze({
    exportForBot: (...args) => requireCredentialVault().exportForBot(...args),
    inspectRestoreForBot: (...args) => requireCredentialVault().inspectRestoreForBot(...args),
    restoreForBot: (...args) => requireCredentialVault().restoreForBot(...args),
    deleteForBot: (...args) => requireCredentialVault().deleteForBot(...args),
  });
  const requireEnvironmentSecretVault = () => {
    if (!environmentSecretVault) {
      throw Object.assign(new Error('Bot environment-secret vault is unavailable'), {
        code: 'bot_recovery_environment_secrets_unavailable',
        statusCode: 503,
      });
    }
    return environmentSecretVault;
  };
  const environmentSecretRecovery = Object.freeze({
    exportForBot: (...args) => requireEnvironmentSecretVault().exportForBot(...args),
    inspectRestoreForBot: (...args) => requireEnvironmentSecretVault().inspectRestoreForBot(...args),
    restoreForBot: (...args) => requireEnvironmentSecretVault().restoreForBot(...args),
    deleteBot: (...args) => requireEnvironmentSecretVault().deleteBot(...args),
  });
  const browserProfiles = botHost?.browserProfiles || null;
  const recoveryAdapter = typeof encryption?.getKey === 'function'
    ? createBotRecoveryAdapter({
        store,
        authorization,
        encryption,
        getCredentialVault: () => credentialVault,
        getEnvironmentSecretVault: () => environmentSecretVault,
        browserProfiles,
      })
    : null;
  const recoveryBundle = recoveryAdapter
    ? createBotRecoveryBundleRuntime({
        adapter: recoveryAdapter,
        encryption,
        credentialVault: credentialRecovery,
        environmentSecretVault: environmentSecretRecovery,
        browserProfiles,
        isGlobalAdmin: (principal) => principalPolicy?.isGlobalAdmin?.(principal) === true,
        audit: botAudit,
      })
    : null;
  const purgeAdapter = createBotPurgeAdapter({
    store,
    authorization,
    getCredentialVault: () => credentialVault,
    getEnvironmentSecrets: () => environmentSecrets,
    purgeIntegrations: async (botId) => {
      await startIntegrations();
      await telegramService?.purgeBot({ botId });
      await voiceService?.purgeBot(botId);
    },
    dockerProvider,
    getIndexer: () => indexerClient,
    getRuntimeStatus: typeof botHost?.getStatus === 'function'
      ? () => botHost.getStatus()
      : null,
    listIndexDocuments: async (botId) => {
      const [memoryDocuments, libraryDocuments] = await Promise.all([
        memoryRuntime?.listIndexDocuments() || [],
        libraryRuntime?.listIndexDocuments({ botId }) || [],
      ]);
      return [...memoryDocuments, ...libraryDocuments]
        .filter((document) => document.metadata?.botId === botId);
    },
  });
  const purgeRuntime = createBotPurgeRuntime({
    dataDirectory,
    authorization,
    adapter: purgeAdapter,
    audit: botAudit,
    auditRetention,
    retireBot: (principal, botId, expectedUpdatedAt) => management.transitionLifecycle(
      principal,
      botId,
      { lifecycle: 'retired', expectedUpdatedAt },
    ),
    isGlobalAdmin: (principal) => principalPolicy?.isGlobalAdmin?.(principal) === true,
  });

  const startCredentialVault = async () => {
    if (!store.available || typeof encryption?.getKey !== 'function') return;
    if (credentialVault) return credentialVault;
    credentialVaultStartPromise ||= Promise.all([
      createBotCredentialVault({
        dataDirectory,
        getBotEncryptionKey: encryption.getKey,
      }),
      createBotEnvironmentSecretVault({
        dataDirectory,
        getBotEncryptionKey: encryption.getKey,
      }),
    ]).then(([credentialResult, environmentResult]) => {
      credentialVault = credentialResult;
      environmentSecretVault = environmentResult;
      environmentSecrets ||= createBotEnvironmentSecrets({
        store,
        authorization,
        vault: environmentSecretVault,
        audit: botAudit,
        dataDirectory,
      });
      agentConnections ||= createBotAgentConnections({
        store,
        authorization,
        getCredentialVault: () => credentialVault,
        request: async (input) => {
          if (typeof botHost?.agentRequest !== 'function') {
            throw Object.assign(new Error('Bot AG-UI egress is unavailable'), {
              code: 'bot_agent_egress_unavailable',
              statusCode: 503,
            });
          }
          return botHost.agentRequest(input);
        },
        audit: botAudit,
      });
      return credentialResult;
    }).finally(() => {
      credentialVaultStartPromise = null;
    });
    return credentialVaultStartPromise;
  };

  const ensureModelCredentialBroker = async () => {
    await startCredentialVault();
    if (!credentialVault) {
      throw Object.assign(new Error('Bot credential vault is unavailable'), {
        code: 'bot_credential_vault_unavailable',
        statusCode: 503,
      });
    }
    modelCredentialBroker ||= createBotModelCredentialBroker({
      dataDirectory,
      credentialVault,
      store,
      oauthCoordinator,
    });
    return modelCredentialBroker;
  };

  // The catalog readiness projection. The local catalog transport owns the
  // single retry engine (starting an existing installation through the
  // Electron lifecycle queue); this runtime only reacts to its transitions.
  const startRetention = async () => {
    try {
      if (localCatalog) await localCatalog.ensureStarted();
      await store.assertSchemaVersion(PRODUCTION_BOTS_MIGRATION);
      await auditRetention.start();
      await onCatalogReady?.();
      schemaFailure = null;
      controlPlaneFailure = null;
    } catch (error) {
      schemaFailure = productionBotsMigrationFailurePayload(error);
      controlPlaneFailure = schemaFailure ? null : {
        code: typeof error?.code === 'string' ? error.code : 'bot_database_unavailable',
      };
      if (localCatalog) {
        localCatalog.scheduleStart();
      } else if (!retryTimer && transport) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void startRetention().then(() => {
            if (executionEnabled && started && !schemaFailure && !controlPlaneFailure) {
              return startExecution();
            }
            return undefined;
          });
        }, 60_000);
        retryTimer.unref?.();
      }
    }
  };

  // A catalog that becomes ready again resumes the existing services; it
  // never creates a second dispatcher, scheduler, integration worker or
  // retention job (every service is created once and only paused meanwhile).
  let catalogRecovery = null;
  const unsubscribeCatalog = localCatalog?.onChange((next, previous) => {
    botHostStatusCache.invalidate();
    if (next.state !== 'ready' || previous.state === 'ready' || !started || shutdownPromise) return;
    catalogRecovery ||= (async () => {
      await startRetention();
      if (schemaFailure || controlPlaneFailure) return;
      if (executionEnabled && !prewarmCache) await startExecution();
      await startIntegrations().catch(() => undefined);
      if (!maintenanceFence) {
        dispatcher?.resumeAdmissions?.();
        await routineRuntime?.tick?.().catch?.(() => undefined);
      }
    })().catch(() => undefined).finally(() => {
      catalogRecovery = null;
    });
  }) || null;

  const performStartExecution = async () => {
    if (!store.available || !dockerProvider.available || typeof encryption?.getKey !== 'function') return;
    try {
      await ensureModelCredentialBroker();
      if (typeof botHost?.indexerRequest !== 'function') {
        throw Object.assign(new Error('Bot retrieval index is unavailable'), {
          code: 'bot_indexer_unavailable',
          statusCode: 503,
        });
      }
      indexerClient ||= createBotIndexerClient({ request: botHost.indexerRequest });
      libraryRuntime ||= createBotLibraryRuntime({
        store,
        authorization,
        blobStore,
        scanner: createBotSourceScanner(),
        encryption,
        indexer: indexerClient,
        dockerProvider,
        computerRuntimeManager,
        audit: botAudit,
        loadMemoryIndexDocuments: () => memoryRuntime?.listIndexDocuments() || [],
      });
      artifactService ||= createBotArtifactService({
        store,
        authorization,
        blobStore,
        libraryRuntime,
        dataDirectory,
      });
      opencodeProvider ||= createBotOpenCodeProvider({
        dockerProvider,
        configCompiler,
        modelCredentialBroker,
        gatewayHost,
        artifactService,
        environmentSecrets,
        recordDiagnostic,
      });
      await opencodeProvider.start();
      await computerRuntimeManager.start();
      if (typeof botHost?.getModelCatalog !== 'function') {
        throw Object.assign(new Error('Bot model catalog is unavailable'), {
          code: 'bot_model_catalog_unavailable',
          statusCode: 503,
        });
      }
      prewarmCache ||= createBotPrewarmCache({
        compileRevision: (input) => configCompiler.compile(input),
        loadModelCatalog: botHost.getModelCatalog,
        checkHealth: async () => {
          const capability = await resolveCurrentCapabilities();
          if (!capability.available) {
            throw Object.assign(new Error('Bot runtime prewarm health check failed'), {
              code: capability.code || 'bots_unavailable',
              statusCode: 503,
            });
          }
          return capability;
        },
      });
      reasoningAdapterRegistry ||= createBotReasoningAdapterRegistry({
        adapters: [
          createOpenCodeReasoningAdapter({
            provider: opencodeProvider,
            loadModelCatalog: (options) => prewarmCache.getModelCatalog(options),
            prewarmCache,
          }),
          agentConnections.adapter,
        ],
      });
      contextAssembler ||= createBotContextAssembler({
        store,
        channels,
        retrieval: { search: (input) => libraryRuntime.search(input) },
        // Memory starts (and may be retried) after the assembler exists; until
        // it is up the assembler falls back to the newest facts.
        memoryRetrieval: {
          search: async (input) => (memoryRuntime ? memoryRuntime.searchForContext(input) : null),
        },
        capabilities: { runtimeCatalog: (input) => capabilityBindings.runtimeCatalog(input) },
      });
      await startMemoryRuntimeResiliently();
      routineDrafter ||= createBotRoutineDrafter({
        generateNoTools: async ({ principal, botId, prompt, schema, title, system }) => {
          await authorization.requireManager(principal, botId);
          const bot = await store.repositories.bots.get({ id: botId });
          if (!bot || bot.lifecycle !== 'active' || !bot.active_revision_id) {
            throw Object.assign(new Error('Bot lifecycle blocks routine drafting'), {
              code: bot?.lifecycle === 'retired' ? 'bot_retired' : 'bot_paused',
              statusCode: 409,
            });
          }
          const revision = await store.repositories.bot_revisions.get({
            id: bot.active_revision_id,
            bot_id: bot.id,
          });
          if (!revision || !revision.activated_at || revision.retired_at) {
            throw Object.assign(new Error('Bot active revision is unavailable'), {
              code: 'bot_revision_unavailable',
              statusCode: 409,
            });
          }
          const draftRunId = randomUUID();
          const draftChannelId = randomUUID();
          const selection = reasoningAdapterRegistry.forRevision(revision.contract);
          const binding = Object.freeze({
            ...selection.binding,
            botId: bot.id,
            revisionId: revision.id,
          });
          return runBotStructuredTask({
            adapter: selection.adapter,
            run: {
              id: draftRunId,
              botId: bot.id,
              channelId: draftChannelId,
              revisionId: revision.id,
              ownerUserId: principal.id,
              updatedAt: revision.updated_at || new Date().toISOString(),
            },
            contract: revision.contract,
            binding,
            prompt,
            schema,
            title,
            system,
          });
        },
      });
      routineRuntime ||= createBotRoutineRuntime({
        isAdmissionPaused: admissionPaused,
        authorizeManagerAccount: async (userId) => Boolean(await resolveAutonomousPrincipal(userId)),
        store,
        authorization,
        channels,
        drafter: routineDrafter,
        enqueueRoutineMessage: (input) => {
          if (!dispatcher) {
            throw Object.assign(new Error('Bot dispatcher is unavailable'), {
              code: 'bots_unavailable',
              statusCode: 503,
            });
          }
          return dispatcher.enqueueMessage(input);
        },
        audit: botAudit,
      });
      routineSettlementHandler = async (input) => {
        if (input?.run) await browserService.activity.endRun(input.run).catch(() => undefined);
        await routineRuntime?.onRunSettled(input);
        // Durable transport reconciliation also runs periodically after a restart.
        await telegramService?.notifyRoutineCompleted(input).catch(() => undefined);
      };
      runSweepGate ||= createBotRunSweepGate({
        isExecuting: (runId) => dispatcher?.isExecuting(runId) === true,
        logger: console,
      });
      const sweepGate = runSweepGate;
      dispatcher ||= trackBotDispatcherActivity(createBotRunDispatcher({
        isAdmissionPaused: admissionPaused,
        describeAdmissionPause,
        store,
        channels,
        contextAssembler,
        reasoningAdapters: reasoningAdapterRegistry.kinds.map((kind) => reasoningAdapterRegistry.get(kind)),
        executeGovernedToolIntent: actionGateway.handleGatewayOperation,
        eventStream,
        resolveLibrarySnapshot: (input) => libraryRuntime.snapshotForRun(input),
        hasPendingMemory: (channelId) => memoryRuntime.hasPendingForChannel(channelId),
        onRunCompleted: (input) => {
          sweepGate.noteActivity();
          return memoryRuntime?.enqueueCompletedRun(input);
        },
        onRunSettled: async (input) => {
          sweepGate.noteRunSettled(input?.run?.id);
          if (input?.run?.channel_id) await memoryRuntime.wakeChannel(input.run.channel_id).catch(() => undefined);
          return routineSettlementHandler?.(input);
        },
        streamAccessLeases,
        runtimePreflight: async ({ run } = {}) => {
          sweepGate.noteRunStarted(run?.id);
          const capability = await resolveBotCapabilities({
            hasSupabase: store.available,
            catalog: catalogState(),
            maintenance: maintenanceFence ? { kind: maintenanceFence.kind } : null,
            botHost,
            encryption,
            schemaFailure,
            controlPlaneFailure,
          });
          if (!capability.available) {
            prewarmCache?.invalidateAll();
            throw Object.assign(new Error('Bot runtime preflight failed'), {
              code: capability.code || 'bots_unavailable',
              statusCode: 503,
            });
          }
          return capability;
        },
        approvalService,
        reconcileExpiredApprovals: (computerScopeKey) => approvalService.expirePending({
          computerScopeKey,
        }),
        sharedFileService,
        recordDiagnostic,
      }), () => sweepGate.noteActivity());
      runRecovery ||= createBotRunRecovery({ store, dispatcher });
      await sharedFileService.recover();
      await routineRuntime.start();
      const expired = await approvalService.expirePending();
      for (const computerScopeKey of expired.scopeKeys) {
        queueMicrotask(() => void dispatcher?.drainScope(computerScopeKey));
      }
      if (!approvalExpiryJob) {
        approvalExpiryJob = createBotPeriodicJob({
          name: 'approval_expiry',
          intervalMs: 5_000,
          idleIntervalMs: 60_000,
          maxBackoffMs: 60_000,
          logger: console,
          run: async () => {
            if (!dispatcher || admissionPaused()) return { idle: true };
            const result = await approvalService.expirePending();
            for (const computerScopeKey of result.scopeKeys) {
              void dispatcher?.drainScope(computerScopeKey);
            }
            return { idle: result.scopeKeys.length === 0 };
          },
        });
        approvalExpiryJob.start({ immediate: false });
      }
      // Run recovery is autonomous work: it waits for maintenance, catalog
      // outages and an activation hold, then runs once admissions reopen.
      if (admissionPaused()) {
        runRecoveryDeferred = true;
      } else {
        runRecoveryDeferred = false;
        const recovered = await runRecovery.recover();
        for (const computerScopeKey of recovered.queuedScopeKeys || []) {
          queueMicrotask(() => void dispatcher?.drainScope(computerScopeKey));
        }
      }
      if (!runSweepJob) {
        runSweepJob = createBotPeriodicJob({
          name: 'run_sweep',
          intervalMs: 30_000,
          maxBackoffMs: 300_000,
          logger: console,
          run: async () => {
            if (!dispatcher || !runRecovery || !runSweepGate || admissionPaused()) return;
            // Resolves null while the runtime is idle; see createBotRunSweepGate.
            const sweep = await runSweepGate.sweep(() => runRecovery.sweep({
              isExecuting: (runId) => dispatcher?.isExecuting(runId) === true,
            }));
            if (!sweep) return;
            for (const computerScopeKey of sweep.queuedScopeKeys) {
              void dispatcher?.drainScope(computerScopeKey);
            }
          },
        });
        runSweepJob.start({ immediate: false });
      }
      executionFailure = null;
      botHostStatusCache.invalidate();
      prewarmCache?.invalidateAll();
      executionRetryAttempt = 0;
      if (executionRetryTimer) clearTimeout(executionRetryTimer);
      executionRetryTimer = null;
    } catch (error) {
      prewarmCache?.invalidateAll();
      executionFailure = {
        code: typeof error?.code === 'string' ? error.code : 'bot_runtime_execution_unavailable',
      };
      botHostStatusCache.invalidate();
      await routineRuntime?.shutdown().catch(() => undefined);
      await dispatcher?.shutdown().catch(() => undefined);
      clearMemoryStartRetry();
      await memoryRuntime?.shutdown().catch(() => undefined);
      await artifactService?.shutdown().catch(() => undefined);
      if (approvalExpiryJob) await approvalExpiryJob.stop();
      approvalExpiryJob = null;
      if (runSweepJob) await runSweepJob.stop();
      runSweepJob = null;
      runSweepGate = null;
      runRecovery = null;
      dispatcher = null;
      contextAssembler = null;
      routineRuntime = null;
      routineDrafter = null;
      routineSettlementHandler = null;
      scheduleExecutionRetry();
    }
  };

  const startExecution = async () => {
    if (executionStartPromise) return executionStartPromise;
    executionStartPromise = performStartExecution().finally(() => {
      executionStartPromise = null;
    });
    return executionStartPromise;
  };

  function scheduleExecutionRetry() {
    const delays = [1_000, 5_000, 15_000];
    if (!executionEnabled || !started || shutdownPromise || executionRetryTimer
      || executionRetryAttempt >= delays.length) return;
    const delay = delays[executionRetryAttempt];
    executionRetryAttempt += 1;
    executionRetryTimer = setTimeout(() => {
      executionRetryTimer = null;
      void resolveCurrentCapabilities().catch(() => undefined);
    }, delay);
    executionRetryTimer.unref?.();
  }

  async function resolveCurrentCapabilities({ refresh = false } = {}) {
    const input = {
      hasSupabase: store.available,
      catalog: catalogState(),
      maintenance: maintenanceFence ? { kind: maintenanceFence.kind } : null,
      botHost,
      encryption,
      schemaFailure,
      controlPlaneFailure,
      startupState,
      statusCache: botHostStatusCache,
      refreshStatus: refresh === true,
    };
    if (executionEnabled && started && executionFailure && !schemaFailure && !controlPlaneFailure) {
      // A recovery probe must see the live host, never a cached failure.
      const live = await resolveBotCapabilities({ ...input, refreshStatus: true });
      if (live.available) await startExecution();
    }
    return resolveBotCapabilities({ ...input, executionFailure });
  }

  const activeWorkBlockers = () => [
    ...(inflightWrites > 0 ? ['http_writes'] : []),
    ...(integrationStartPromise || executionStartPromise ? ['bot_startup'] : []),
    ...(routineRuntime?.getActiveWorkCount?.() ? ['bot_routines'] : []),
    ...(dispatcher?.getActiveWorkCount?.() ? ['bot_runs'] : []),
    ...(telegramService?.getActiveWorkCount?.() ? ['telegram'] : []),
    ...(memoryRuntime?.getPendingExtractionCount?.() ? ['memory_extraction'] : []),
  ];

  // Reopens autonomous work after maintenance or an owner resume: parked
  // dispatcher wakes, one routine pass and any run recovery deferred while
  // admissions were closed. Each service already exists exactly once.
  const resumeAutonomousWork = async () => {
    if (admissionPaused()) return;
    dispatcher?.resumeAdmissions?.();
    await routineRuntime?.tick?.().catch?.(() => undefined);
    if (runRecoveryDeferred && runRecovery && dispatcher) {
      runRecoveryDeferred = false;
      try {
        const recovered = await runRecovery.recover();
        for (const computerScopeKey of recovered.queuedScopeKeys || []) {
          void dispatcher?.drainScope(computerScopeKey);
        }
      } catch {
        runRecoveryDeferred = true;
      }
    }
  };

  // Services hold caches and timers bound to the database they started on.
  // After a replacement they are stopped and created again; a terminally shut
  // down object is never restarted.
  const teardownServices = async () => {
    backgroundStopped = true;
    await integrationStartPromise?.catch(() => undefined);
    await executionStartPromise?.catch(() => undefined);
    await telegramService?.stop().catch(() => undefined);
    await voiceService?.shutdown?.().catch?.(() => undefined);
    telegramService = null;
    voiceService = null;
    await routineRuntime?.shutdown().catch(() => undefined);
    await dispatcher?.shutdown().catch(() => undefined);
    clearMemoryStartRetry();
    await memoryRuntime?.shutdown().catch(() => undefined);
    if (approvalExpiryJob) await approvalExpiryJob.stop();
    approvalExpiryJob = null;
    if (runSweepJob) await runSweepJob.stop();
    runSweepJob = null;
    runSweepGate = null;
    runRecovery = null;
    dispatcher = null;
    contextAssembler = null;
    routineRuntime = null;
    routineDrafter = null;
    routineSettlementHandler = null;
    prewarmCache?.invalidateAll();
    prewarmCache = null;
    streamAccessLeases.invalidateAll();
    auditRetention.shutdown();
    ownerMappings.clear();
    mirroredAt.clear();
  };

  const rebuildServices = async () => {
    backgroundStopped = false;
    botHostStatusCache.invalidate();
    // The objects directory was swapped (or retired by Start Empty); the
    // adapter re-creates and re-checks it on next use.
    objectStoragePromise = null;
    // Host vaults and signing state were replaced with the catalog.
    await credentialVault?.reload?.().catch?.(() => undefined);
    await environmentSecretVault?.reload?.().catch?.(() => undefined);
    botSpecSigner?.reset?.();
    // Existing SSE subscribers hold snapshots of the old catalog; they
    // reconnect and receive a snapshot of the new one.
    eventStream.disconnectAll?.('catalog_replaced');
    await startRetention();
    if (schemaFailure || controlPlaneFailure) return;
    if (executionEnabled) await startExecution();
    await startIntegrations().catch(() => undefined);
  };

  // One reversible maintenance operation at a time (backup, migration,
  // import, restore, start empty). Admissions close first; admitted work
  // drains within a bound or the operation returns a retryable busy result
  // without aborting anything.
  const runMaintenance = async (kind, operation, {
    drainTimeoutMs = 30_000,
    replacesDatabase = false,
  } = {}) => {
    if (typeof operation !== 'function' || !/^[a-z_]{1,32}$/.test(kind)) {
      throw new TypeError('Bot maintenance operation is invalid');
    }
    if (maintenanceFence) {
      throw Object.assign(new Error('Another Bot maintenance operation is running'), {
        code: 'bots_maintenance_busy', statusCode: 409, retryable: true,
      });
    }
    maintenanceFence = Object.freeze({ kind, startedAt: new Date().toISOString() });
    botHostStatusCache.invalidate();
    let tornDown = false;
    let replaced = false;
    try {
      await routineRuntime?.checkpoint?.().catch?.(() => undefined);
      const deadline = Date.now() + drainTimeoutMs;
      for (let blockers = activeWorkBlockers(); blockers.length > 0; blockers = activeWorkBlockers()) {
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('Bots are busy; try again when current work finishes'), {
            code: 'bots_maintenance_busy', statusCode: 409, retryable: true, blockers,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (replacesDatabase) {
        localCatalog?.enterMaintenance(`bots_maintenance_${kind}`);
        await teardownServices();
        tornDown = true;
      }
      return await operation({
        markReplaced: () => { replaced = true; },
      });
    } finally {
      maintenanceFence = null;
      botHostStatusCache.invalidate();
      recordDiagnostic({ type: 'lifecycle', event: 'bot.maintenance.finished', payload: { kind, replaced } });
      if (tornDown) {
        await localCatalog?.leaveMaintenance().catch(() => undefined);
        await rebuildServices().catch(() => undefined);
      }
      await resumeAutonomousWork();
    }
  };

  const catalogMaintenance = localCatalog
    ? createBotCatalogMaintenance({
        maintenance: botHost?.catalog?.maintenance || null,
        runMaintenance,
        activationHold,
        encryption,
        isCatalogUsable: () => catalogReady() && !schemaFailure && !controlPlaneFailure,
        resumeAutonomousWork,
        isMaintenanceActive: () => maintenanceFence !== null,
        recordDiagnostic,
      })
    : null;
  const catalogStatus = () => {
    const catalog = catalogState();
    const hold = activationHold.get();
    return Object.freeze({
      state: catalog.state,
      code: catalog.code ?? null,
      schema: schemaFailure ? { code: schemaFailure.code, requiredMigration: schemaFailure.requiredMigration } : null,
      maintenance: maintenanceFence ? { kind: maintenanceFence.kind, startedAt: maintenanceFence.startedAt } : null,
      activationHold: hold ? { reason: hold.reason, createdAt: hold.createdAt } : null,
    });
  };
  const catalogImport = catalogMaintenance && botHost?.catalog?.maintenance && typeof readCloudSource === 'function'
    ? createBotCatalogImport({
        dataDirectory,
        encryption,
        host: botHost.catalog.maintenance,
        runMaintenance,
        activationHold,
        readCloudSource,
        resolveVerifiedSourceOwner: typeof resolveVerifiedSourceOwner === 'function'
          ? resolveVerifiedSourceOwner
          : async () => null,
        validateCandidate: (candidate, options) => catalogMaintenance.validateCandidate(candidate, options),
        recordDiagnostic,
      })
    : null;
  catalogImportRef.current = catalogImport;
  let cloudProbeAt = 0;
  if (localCatalog) {
    recoveryRouteRegistrars.push((routeApp) => registerBotCatalogRoutes(routeApp, {
      getStatus: async ({ owner }) => {
        // An empty local catalog must not read as deleted cloud Bots: the
        // owner sees whether hosted Bots still await import. A host that is
        // not connected to Supabase reports only that a source is saved.
        if (discoverCloudSource === true && owner && catalogImport && Date.now() - cloudProbeAt > 60 * 60 * 1000) {
          cloudProbeAt = Date.now();
          void catalogImport.probeCloud().catch(() => undefined);
        }
        return catalogStatus();
      },
      maintenance: catalogMaintenance,
      catalogImport,
    }));
  }

  const countRows = async (repository, filters) => {
    if (!repository) return 0;
    let count = 0;
    let cursor = null;
    do {
      const page = await repository.list({ filters, cursor, limit: 100, fields: ['id'] });
      count += page.items.length;
      cursor = page.nextCursor;
    } while (cursor && count < 10_000);
    return count;
  };

  const getQuitRiskStatus = async () => {
    try {
      const routineStatus = routineRuntime
        ? await routineRuntime.getStatus()
        : {
            activeRoutineCount: 0,
            pendingRoutineCount: 0,
            schedulerStatus: executionFailure ? 'unavailable' : 'idle',
            checkpointStatus: executionFailure ? 'unknown' : 'idle',
          };
      const activeStates = [
        'queued',
        'starting',
        'running',
        'waiting_approval',
        'waiting_control',
        'needs_reconciliation',
      ];
      const [activeRunCounts, pendingApprovalCount] = await Promise.all([
        Promise.all(activeStates.map((state) => countRows(
          store.repositories.bot_runs,
          { state },
        ))),
        countRows(store.repositories.bot_action_attempts, { state: 'pending_approval' }),
      ]);
      return Object.freeze({
        activeRunCount: activeRunCounts.reduce((sum, count) => sum + count, 0),
        pendingApprovalCount,
        activeRoutineCount: routineStatus.activeRoutineCount,
        pendingRoutineCount: routineStatus.pendingRoutineCount,
        schedulerStatus: routineStatus.schedulerStatus,
        checkpointStatus: routineStatus.checkpointStatus,
      });
    } catch {
      return Object.freeze({
        activeRunCount: 0,
        pendingApprovalCount: 0,
        activeRoutineCount: 0,
        pendingRoutineCount: 0,
        schedulerStatus: 'unknown',
        checkpointStatus: 'unknown',
      });
    }
  };

  return Object.freeze({
    enabled: store.available,
    store,
    authorization,
    blobStore,
    channels,
    eventStream,
    audit: botAudit,
    auditRetention,
    auditQuery,
    recoveryBundle,
    purgeRuntime,
    dockerProvider,
    configCompiler,
    gatewayHost,
    connectorRegistry,
    mcpHost,
    capabilityBindings,
    policyEngine,
    approvalService,
    browserService,
    evidenceService,
    actionGateway,
    management,
    botSpecService,
    get credentialVault() { return credentialVault; },
    get modelCredentialBroker() { return modelCredentialBroker; },
    get environmentSecrets() { return environmentSecrets; },
    get opencodeProvider() { return opencodeProvider; },
    get agentConnections() { return agentConnections; },
    get contextAssembler() { return contextAssembler; },
    get indexerClient() { return indexerClient; },
    get libraryRuntime() { return libraryRuntime; },
    get artifactService() { return artifactService; },
    get memoryRuntime() { return memoryRuntime; },
    computerResources,
    get routineDrafter() { return routineDrafter; },
    get routineRuntime() { return routineRuntime; },
    get dispatcher() { return dispatcher; },
    get prewarmCache() { return prewarmCache; },
    streamAccessLeases,
    get runRecovery() { return runRecovery; },
    getSchemaFailure: () => schemaFailure,
    getControlPlaneFailure: () => controlPlaneFailure,
    getExecutionFailure: () => executionFailure,
    getStartupState: () => startupState,
    getSweepDiagnostics: () => runSweepGate?.diagnostics() ?? INACTIVE_BOT_SWEEP_DIAGNOSTICS,
    // Called by the host after setup/repair/update, so it must bypass the status cache.
    reconcileExecution: () => resolveCurrentCapabilities({ refresh: true }),
    async prepareStartup({ ensureRuntime, onStatus = () => {} } = {}) {
      if (!store.available) {
        return Object.freeze({ state: 'skipped', reason: 'bots_unavailable' });
      }
      if (typeof ensureRuntime !== 'function') {
        return Object.freeze({ state: 'skipped', reason: 'runtime_owner_unavailable' });
      }
      try {
        await ensureRuntime();
        try { onStatus('Warming Bot services…'); } catch {}
        const capabilities = await resolveCurrentCapabilities({ refresh: true });
        if (!capabilities.available) {
          throw Object.assign(new Error('The private Bot runtime did not become ready'), {
            code: capabilities.code || 'bot_runtime_unavailable',
          });
        }
        if (!prewarmCache) await startExecution();
        if (!prewarmCache) {
          throw Object.assign(new Error('Bot execution services did not become ready'), {
            code: executionFailure?.code || 'bot_runtime_execution_unavailable',
          });
        }
        try { onStatus('Loading the Bot model catalog…'); } catch {}
        await prewarmCache.getModelCatalog();
        return Object.freeze({ state: 'ready', capabilities });
      } catch (error) {
        return botStartupFailure(error);
      }
    },
    setGatewayOperationHandler(handler) {
      if (handler !== null && typeof handler !== 'function') {
        throw new TypeError('Bots gateway operation handler must be a function or null');
      }
      gatewayOperationHandler = handler;
    },
    async start() {
      if (!store.available) {
        startupState = 'unavailable';
        return;
      }
      if (startPromise) return startPromise;
      if (started && startupState !== 'failed') return;
      started = true;
      startupState = 'starting';
      startPromise = (async () => {
        await startRetention();
        if (!schemaFailure && !controlPlaneFailure) {
          try {
            await startCredentialVault();
          } catch (error) {
            executionFailure = {
              code: typeof error?.code === 'string'
                ? error.code
                : 'bot_credential_vault_unavailable',
            };
            botHostStatusCache.invalidate();
          }
        }
        if (executionEnabled && !schemaFailure && !controlPlaneFailure) await startExecution();
        if (!schemaFailure && !controlPlaneFailure) {
          await startIntegrations().catch(() => {
            recordDiagnostic({ type: 'lifecycle', event: 'bot.integrations.unavailable', payload: { code: 'bot_integrations_unavailable' } });
          });
        }
        startupState = 'ready';
        catalogMaintenance?.start();
        await catalogImport?.initialize().catch(() => undefined);
      })().catch((error) => {
        startupState = 'failed';
        controlPlaneFailure ||= {
          code: typeof error?.code === 'string' ? error.code : 'bots_startup_failed',
        };
        throw error;
      }).finally(() => {
        startPromise = null;
      });
      return startPromise;
    },
    // Tunnel Bot links act for the workstation owner, so selection is checked
    // under the identity the owner holds for each Bot.
    async validateTunnelBotSelection(principal, botIds) {
      for (const botId of botIds) {
        const effective = ownerId
          ? Object.freeze({ ...localOwner.principal, id: ownerIdentityFor(botId) })
          : principal;
        await authorization.requireActiveMembership(effective, botId);
      }
    },
    registerRoutes(app) {
      registerBotRoutes(app, {
        store,
        management,
        blobStore,
        channels,
        memoryRuntime,
        computerResources,
        routineRuntime,
        libraryRuntime,
        environmentSecrets,
        artifactService,
        sharedFileService,
        dispatcher,
        eventStream,
        approvalService,
        browserService,
        evidenceService,
        actionGateway,
        capabilityBindings,
        agentConnections,
        botSpecService,
        recoveryBundle,
        purgeRuntime,
        auditQuery,
        botHost,
        encryption,
        getSchemaFailure: () => schemaFailure,
        getControlPlaneFailure: () => controlPlaneFailure,
        getExecutionFailure: () => executionFailure,
        getStartupState: () => startupState,
        resolveCapabilities: (options) => {
          // A requested refresh is the owner retrying: restart an unavailable
          // catalog now rather than at the end of its backoff.
          if (options?.refresh === true) localCatalog?.retryNow();
          return resolveCurrentCapabilities(options);
        },
        getCatalogState: () => catalogState(),
        trackWrite,
        identity: ownerId ? Object.freeze({
          defaultPrincipal: (principal) => (actsAsOwner(principal) && principal.id !== ownerId
            ? Object.freeze({ ...principal, id: ownerId })
            : principal),
          scopePrincipal: (principal, botId) => effectivePrincipal(principal, botId),
          needsBotLookup: (principal) => actsAsOwner(principal) && ownerMappings.size > 0,
          resolveResourceBotId: async (kind, id) => {
            const table = { channel: 'bot_channels', run: 'bot_runs', action: 'bot_action_attempts' }[kind];
            if (!table) return null;
            const row = await store.get(table, { id });
            return typeof row?.bot_id === 'string' ? row.bot_id : null;
          },
          forEachIdentity,
          withViewerIds,
          mirror: mirrorManagedIdentity,
        }) : null,
        getMaintenance: () => (maintenanceFence ? { kind: maintenanceFence.kind } : null),
        registerRecoveryRoutes: (routeApp) => recoveryRouteRegistrars.forEach((register) => register(routeApp)),
        getRuntimeServices: () => ({
          memoryRuntime,
          computerResources,
          routineRuntime,
          libraryRuntime,
          environmentSecrets,
          artifactService,
          sharedFileService,
          dispatcher,
          agentConnections,
        }),
        recordDiagnostic,
      });
      registerBotTelegramRoutes(app, { getService: () => telegramService });
      registerBotVoiceRoutes(app, { getService: () => voiceService });
    },
    getQuitRiskStatus,
    catalogMaintenance,
    getCatalogStatus: () => catalogStatus(),
    runMaintenance,
    getRestartBlockers: () => [
      ...(integrationStartPromise || executionStartPromise ? ['bot_startup'] : []),
      ...(routineRuntime?.getActiveWorkCount?.() ? ['bot_routines'] : []),
      ...(dispatcher?.getActiveWorkCount?.() ? ['bot_runs'] : []),
      ...(telegramService?.getActiveWorkCount?.() ? ['telegram'] : []),
      ...(memoryRuntime?.getPendingExtractionCount?.() ? ['memory_extraction'] : []),
    ],
    resumeAdmissions: async () => { dispatcher?.resumeAdmissions?.(); await routineRuntime?.tick(); },
    checkpointBotRuns: () => routineRuntime?.checkpoint()
      || Promise.resolve(Object.freeze({ status: 'idle' })),
    async stopDispatcher() {
      backgroundStopped = true;
      await integrationStartPromise?.catch(() => undefined);
      await telegramService?.stop();
      await voiceService?.shutdown();
      await routineRuntime?.shutdown();
      await dispatcher?.shutdown();
    },
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        await startPromise?.catch(() => undefined);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        if (executionRetryTimer) clearTimeout(executionRetryTimer);
        executionRetryTimer = null;
        if (approvalExpiryJob) await approvalExpiryJob.stop();
        approvalExpiryJob = null;
        if (runSweepJob) await runSweepJob.stop();
        runSweepJob = null;
        runSweepGate = null;
        catalogMaintenance?.stop();
        try {
          backgroundStopped = true;
          await integrationStartPromise?.catch(() => undefined);
          await telegramService?.stop();
          await voiceService?.shutdown();
          if (routineRuntime) await routineRuntime.shutdown();
          if (dispatcher) await dispatcher.shutdown();
          clearMemoryStartRetry();
          if (memoryRuntime) await memoryRuntime.shutdown();
          if (libraryRuntime) await libraryRuntime.shutdown();
          await browserService.shutdown();
          await computerRuntimeManager.shutdown();
          if (opencodeProvider) await opencodeProvider.shutdown();
          else await gatewayHost.shutdown();
          if (environmentSecrets) await environmentSecrets.shutdown();
          if (artifactService) await artifactService.shutdown();
          await mcpHost.shutdown();
        } finally {
          unsubscribeCatalog?.();
          localCatalog?.dispose();
          eventStream.shutdown();
          prewarmCache?.invalidateAll();
          streamAccessLeases.invalidateAll();
          auditRetention.shutdown();
          routineSettlementHandler = null;
          started = false;
        }
      })();
      return shutdownPromise;
    },
  });
}
