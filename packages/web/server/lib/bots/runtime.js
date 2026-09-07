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
  resolvePrincipal = null,
  oauthCoordinator = null,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    throw new TypeError('Bots runtime requires an absolute data directory');
  }
  if (typeof audit !== 'function' || typeof recordDiagnostic !== 'function') {
    throw new TypeError('Bots runtime requires audit and diagnostic functions');
  }

  const store = createBotStore({ supabase });
  const auditRetention = createBotAuditRetention({
    store,
    platformAudit: audit,
    withAuditDeliveryBarrier,
  });
  const botAudit = (entry) => auditRetention.record(entry);
  const authorization = createBotAuthorization({
    store,
    audit: botAudit,
    principalPolicy,
  });
  const blobStore = createBotBlobStore({ store, authorization, encryption });
  const channels = createBotChannels({ store, authorization, encryption });
  const streamAccessLeases = createBotStreamAccessLeases({
    revalidate: (input) => channels.preflightMessage(input),
  });
  const eventStream = createBotEventStream({
    loadSnapshot: (principal) => channels.snapshotForPrincipal(principal),
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
  eventStream.addSnapshotSource('computer_activity', (principal) => browserService.activity.snapshotForPrincipal(principal));
  const evidenceService = createBotEvidenceService({
    store,
    blobStore,
    authorization,
    browserService,
  });
  const approvalService = createBotApprovalService({
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
  eventStream.addSnapshotSource('operations', async (principal) => ({
    ...(await approvalService.snapshotForPrincipal(principal)),
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
    store,
    authorization,
    channels,
    encryption,
    indexer: memoryIndexer,
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
    if (!store.available || typeof encryption?.getKey !== 'function' || typeof resolvePrincipal !== 'function') return;
    if (telegramService) return;
    integrationStartPromise ||= (async () => {
      voiceService ||= createBotVoiceService({ dataDirectory, encryption, authorization, resolvePrincipal });
      telegramService = await createBotTelegramService({
        supabase, store, authorization, channels, blobStore, encryption, dataDirectory,
        resolvePrincipal, getDispatcher: () => backgroundStopped ? null : dispatcher,
        speech: voiceService,
        isOwner: () => executionEnabled && started && !backgroundStopped && !shutdownPromise,
      });
      if (executionEnabled && !backgroundStopped && !shutdownPromise) telegramService.start();
    })().finally(() => { integrationStartPromise = null; });
    return integrationStartPromise;
  };
  const auditQuery = createBotAuditQuery({
    supabase,
    assertSchemaVersion: (expectedVersion) => store.assertSchemaVersion(expectedVersion),
  });
  const management = createBotManagement({
    store,
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

  const startRetention = async () => {
    try {
      await store.assertSchemaVersion(PRODUCTION_BOTS_MIGRATION);
      await auditRetention.start();
      schemaFailure = null;
      controlPlaneFailure = null;
    } catch (error) {
      schemaFailure = productionBotsMigrationFailurePayload(error);
      controlPlaneFailure = schemaFailure ? null : {
        code: typeof error?.code === 'string' ? error.code : 'bots_supabase_unavailable',
      };
      if (!retryTimer) {
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
        store,
        channels,
        contextAssembler,
        reasoningAdapters: reasoningAdapterRegistry.kinds.map((kind) => reasoningAdapterRegistry.get(kind)),
        executeGovernedToolIntent: actionGateway.handleGatewayOperation,
        eventStream,
        resolveLibrarySnapshot: (input) => libraryRuntime.snapshotForRun(input),
        onRunCompleted: (input) => {
          sweepGate.noteActivity();
          return memoryRuntime?.enqueueCompletedRun(input);
        },
        onRunSettled: (input) => {
          sweepGate.noteRunSettled(input?.run?.id);
          return routineSettlementHandler?.(input);
        },
        streamAccessLeases,
        runtimePreflight: async ({ run } = {}) => {
          sweepGate.noteRunStarted(run?.id);
          const capability = await resolveBotCapabilities({
            hasSupabase: store.available,
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
          maxBackoffMs: 60_000,
          logger: console,
          run: async () => {
            if (!dispatcher) return;
            const result = await approvalService.expirePending();
            for (const computerScopeKey of result.scopeKeys) {
              void dispatcher?.drainScope(computerScopeKey);
            }
          },
        });
        approvalExpiryJob.start({ immediate: false });
      }
      const recovered = await runRecovery.recover();
      for (const computerScopeKey of recovered.queuedScopeKeys || []) {
        queueMicrotask(() => void dispatcher?.drainScope(computerScopeKey));
      }
      if (!runSweepJob) {
        runSweepJob = createBotPeriodicJob({
          name: 'run_sweep',
          intervalMs: 30_000,
          maxBackoffMs: 300_000,
          logger: console,
          run: async () => {
            if (!dispatcher || !runRecovery || !runSweepGate) return;
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

  const countRows = async (repository, filters) => {
    if (!repository) return 0;
    let count = 0;
    let cursor = null;
    do {
      const page = await repository.list({ filters, cursor, limit: 100 });
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
        resolveCapabilities: (options) => resolveCurrentCapabilities(options),
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
