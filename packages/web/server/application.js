import { selectedRuntimeBundle, getRuntimeHome } from './lib/opencode/runtime-host/runtime-bundle-binding.js';
import { loadNativeRuntimeBundle, createNativeRuntimeOwner, createRuntimeBundleVerifier } from './lib/opencode/runtime-host/native-runtime-owner.js';
import { createRuntimeBundleLifecycle, createRuntimeBundleAdmissionGate, createRuntimeBundleWorkFence, registerRuntimeBundleLifecycleRoutes } from './lib/opencode/runtime-host/runtime-bundle-lifecycle.js';
import { createNativeAuthorization } from './lib/opencode/runtime-host/native-authorization.js';
import { writeOpenCodeRuntimeSelection } from './lib/opencode/runtime-selection.js';
import { createNativeRevertConversation } from './lib/opencode/session-revert-coordinator.js';
import { attachSupabaseConnectionBoundary, registerSupabaseConnectionRoutes } from './lib/multi-user/connection-routes.js';
import { createHarnessTaskContextHost } from './lib/opencode/harness-task-context.js';
import { createCompressionPolicy } from './lib/http-compression-policy.js';
import { createHarnessSkillDiscovery } from './lib/opencode/harness-skill-discovery.js';
import 'reflect-metadata';
import { beginSessionCreationTrace, isSessionCreateRequest } from './lib/opencode/session-creation.js';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import yaml from 'yaml';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { createMultiUserRuntime, getRequestPrincipal } from './lib/multi-user/index.js';
import { canUseBrowser, canReadSettingsPage } from './lib/multi-user/policy.js';
import { createBotModelCatalogLoader } from './lib/bots/model-catalog.js';
import { setBotOwnerCookie } from './lib/bots/local-owner.js';
import { createTunnelAccessControl as createTunnelAuth, registerTunnelAccessBoundary, hasTunnelBoundaryAuthorization } from './lib/tunnels/access-control.js';
import { registerLocalOwnerBootstrap } from './lib/multi-user/local-owner-bootstrap.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { normalizeManagedRemoteTunnelToken } from './lib/tunnels/managed-token.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import { registerRuntimeServiceRoutes } from './lib/runtime-service/routes.js';
import {
  getUnauthenticatedLanErrorMessage,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
} from './lib/security/bind-host.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  isValidManagedRemoteOriginPort,
  normalizeOptionalPath,
  normalizeManagedRemoteOriginPort,
  normalizeTunnelStartRequest,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './lib/tunnels/types.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import {
  createGlobalMessageStreamSseHandler,
  createGlobalUiEventBroadcaster,
  createGlobalMessageStreamHub,
  createMessageStreamWsRuntime,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS,
} from './lib/event-stream/index.js';
import { createBoundedTaskRunner } from './lib/event-stream/bounded-task-runner.js';
import { createCanonicalOpenCodeEventProcessor } from './lib/event-stream/canonical-ingestion.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { createOpenCodeLifecycleRuntime } from './lib/opencode/lifecycle.js';
import { createRuntimeRestartReconciler } from './lib/opencode/runtime-restart-reconcile.js';
import { createSessionExecutionHost } from './lib/opencode/session-execution-host.js';
import { hostStallClock, onHostStall } from '@openchamber/harness-runtime/lib/host-stall-clock.js';
import { executionArtifacts, executionReadinessMiddleware } from './lib/opencode/execution-artifacts.js';
import { createOpenAiOAuthCoordinator } from './lib/opencode/openai-oauth-coordinator.js';
import { createOpenAiOAuthBridge } from './lib/opencode/openai-oauth-bridge.js';
import { createConfigApplyCoordinator, createConfigChangeMarker } from '@openchamber/shared-runtime';
import { syncPackagedAgents } from './lib/opencode/packaged-agent-sync.js';
import { syncRuntimeAgentOverlays } from './lib/opencode/runtime-agent-overlays.js';
import { readAgentRuntimeSettings } from './lib/opencode/agent-runtime-settings.js';
import { createUserProfileProvisioningRuntime } from './lib/opencode/user-profile-provisioning.js';
import { retireLegacyCursorPlugin } from './lib/opencode/legacy-cursor-plugin.js';
import { readAuthFile } from './lib/opencode/auth.js';
import { discoverSkills } from './lib/opencode/skills.js';
import { createOpenCodeEnvRuntime } from './lib/opencode/env-runtime.js';
import { resolveOpenCodeEnvConfig } from './lib/opencode/env-config.js';
import { createHmrStateRuntime } from './lib/opencode/hmr-state-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
import { createOpenCodeClient } from './lib/opencode/opencode-client/index.js';
import { createOpenCodeAdmission } from './lib/opencode/v2/admission.js';
import { createOpenCodeAuthStateRuntime } from './lib/opencode/auth-state-runtime.js';
import { createProjectDirectoryRuntime } from './lib/opencode/project-directory-runtime.js';
import { createSettingsNormalizationRuntime } from './lib/opencode/settings-normalization-runtime.js';
import { createSettingsHelpers } from './lib/opencode/settings-helpers.js';
import { createThemeRuntime } from './lib/opencode/theme-runtime.js';
import { createFeatureRoutesRuntime } from './lib/opencode/feature-routes-runtime.js';
import { canReceiveProjectMetadataEvent } from './lib/scheduled-tasks/routes.js';
import { parseServeCliOptions } from './lib/opencode/cli-options.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/opencode/core-routes.js';
import { registerOpenChamberRoutes } from './lib/opencode/openchamber-routes.js';
import { createServerUtilsRuntime } from './lib/opencode/server-utils-runtime.js';
import { createStaticRoutesRuntime } from './lib/opencode/static-routes-runtime.js';
import { createSettingsRuntime } from './lib/opencode/settings-runtime.js';
import { createProjectIconStore } from './lib/opencode/project-icon-store.js';
import { createOpenCodeResolutionRuntime } from './lib/opencode/opencode-resolution-runtime.js';
import { createBootstrapRuntime } from './lib/opencode/bootstrap-runtime.js';
import { createSessionRuntime } from './lib/opencode/session-runtime.js';
import { createOpenCodeWatcherRuntime } from './lib/opencode/watcher.js';
import { createTurnTimingRuntime, registerTurnTimingRoutes } from './lib/opencode/turn-timing.js';
import { createNativeProviderTiming } from './lib/opencode/runtime-host/native-provider-timing.js';
import { createAgentRuntimeWarmup, registerAgentRuntimeWarmupRoute } from './lib/opencode/agent-runtime-warmup.js';
import { createProjectPrewarmRuntime } from './lib/opencode/project-prewarm-runtime.js';
import { createXaiToolCatalogRuntime } from './lib/opencode/xai-tool-catalog-runtime.js';
import { createStandardSessionTitleRuntime } from './lib/opencode/standard-session-title-runtime.js';
import { createHarnessPreflight, registerHarnessPreflightRoute } from './lib/opencode/harness-preflight.js';
import { readConfigCredentialScan } from './lib/opencode/config-credential-scan.js';
import { resolveDuplicateOutputPolicy } from './lib/opencode/harness-duplicate-qualification.js';
import { createHarnessRunFingerprintReader } from './lib/opencode/harness-run-fingerprint.js';
import { createDuplicateProviderRouteResolver } from './lib/opencode/duplicate-provider-route.js';
import { inspectClaudeRuntimeCompatibility } from './lib/opencode/claude-runtime-compatibility.js';
import { resolveApprovedSkills } from './lib/opencode/skill-policy.js';
import {
  getAgentConfig,
  getAgentSources,
  listConfigAgents,
  listStaleAgentModelOverrides,
  resolveLocalAgentBackupExecution,
} from './lib/opencode/agents.js';
import { listPackagedAgents } from './lib/opencode/packaged-agents.js';
import {
  findWorktreeRoot,
  getAncestors,
  parseMdFile,
  resolveSkillSearchDirectories,
  walkSkillMdFiles,
} from './lib/opencode/shared.js';
import { CURSOR_PROVIDER_ID, createCursorSdkRuntime } from '@openchamber/cursor-sdk-runtime';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createServerStartupRuntime } from './lib/opencode/server-startup-runtime.js';
import { createTunnelWiringRuntime } from './lib/opencode/tunnel-wiring-runtime.js';
import { createStartupPipelineRuntime } from './lib/opencode/startup-pipeline-runtime.js';
import { runCliEntryIfMain } from './lib/opencode/cli-entry-runtime.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createNotificationTemplateRuntime } from './lib/notifications/template-runtime.js';
import { createGracefulShutdownRuntime } from './lib/opencode/shutdown-runtime.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { classifyPreviewRequestScope, createPreviewProxyRuntime } from './lib/preview/proxy-runtime.js';
import { createLocalInstanceStatusRuntime } from './lib/preview/local-instances-runtime.js';
import { createProjectPreviewInstancesRuntime } from './lib/preview/project-instances-runtime.js';
import { createBrowserCdpDiscoveryRuntime } from './lib/browser-cdp/discovery-runtime.js';
import { createBrowserLeaseRuntime } from './lib/browser-cdp/lease-runtime.js';
import { createBrowserObservationRuntime } from './lib/browser-cdp/observation-runtime.js';
import { dynamicNoStoreMiddleware } from './lib/http-cache-policy.js';
import { createMeridianProviderResetProbe } from './lib/orchestration/provider-reset-probe.js';
import { createWebManagedOrchestrationRuntime } from './lib/orchestration/runtime.js';
import { resolveManagedAgentExecution } from './lib/multi-user/managed-agent-defaults.js';
import { registerManagedOrchestrationRoutes } from './lib/orchestration/routes.js';
import { createWebHarnessRuntime } from './lib/harness/runtime.js';
import { createSessionChangeHost } from '@openchamber/harness-runtime';
import { createSessionActivityGate } from './lib/opencode/session-activity-gate.js';
import { createSessionRetention, registerSessionRetentionRoutes } from './lib/opencode/session-retention.js';
import { createWebPrimaryRecoveryRuntime } from './lib/harness/provider-recovery.js';
import { createWebCommandDeadlineRuntime } from './lib/harness/command-deadline-runtime.js';
import { registerDiagnosticsRoutes } from './lib/diagnostics/routes.js';
import { registerMemoryDebugRoutes } from './lib/debug/memory-routes.js';
import { createWebEvidenceRuntime } from './lib/evidence/runtime.js';
import { registerEvidenceRoutes } from './lib/evidence/routes.js';
import { registerIndexingPolicy } from './lib/indexing-policy.js';
import { getPublicRuntimePort } from './lib/runtime-port-visibility.js';
import { configureWorktreeBootstrapRuntime } from './lib/git/service.js';
import { buildGitGenerationTimingRecord } from './lib/git/generation-diagnostics.js';
import { stripEventDiffContent } from './lib/opencode/diff-summary.js';
import {
  OPENCODE_DB_PRELAUNCH_TIME_BUDGET_MS,
  createOpenCodeDbCompactionScheduler,
  createOpenCodeDbMaintenance,
  normalizeOpenCodeDbMaintenanceSettings,
} from './lib/opencode/db-maintenance.js';
import { registerOpenCodeDbMaintenanceRoutes } from './lib/opencode/db-maintenance-routes.js';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundleWork = createRuntimeBundleWorkFence();
const verifySelectedRuntimeBundle = selectedRuntimeBundle ? createRuntimeBundleVerifier(selectedRuntimeBundle) : null;
if (verifySelectedRuntimeBundle) await verifySelectedRuntimeBundle();
const configuredDefaultConfigRoot = typeof process.env.DEVRYAN_DEFAULT_CONFIG_ROOT === 'string'
  ? process.env.DEVRYAN_DEFAULT_CONFIG_ROOT.trim()
  : '';
const defaultConfigRoot = configuredDefaultConfigRoot
  ? path.resolve(configuredDefaultConfigRoot)
  : path.join(__dirname, 'default-config');

for (const requiredRelativePath of [
  'opencode.json',
  path.join('agents', 'orchestrator.md'),
  path.join('plugins', 'openai-tool-schema-sanitizer.mjs'),
  path.join('user-profile', 'package.json'),
]) {
  const requiredPath = path.join(defaultConfigRoot, requiredRelativePath);
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`DevRyan default config is incomplete: ${requiredPath}`);
  }
}

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OpenChamberDesktopNotify] ';
const uiNotificationClients = new Set();
const uiNotificationWsClients = new Set();
const uiOpenChamberEventClients = new Set();
const HEALTH_CHECK_INTERVAL = 15000;
const SHUTDOWN_TIMEOUT = 10000;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_CODE_READY_GRACE_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const { collectHarnessSkillEntries } = createHarnessSkillDiscovery({
  fs, os, homeDirectory: getRuntimeHome(), yaml, discoverSkills, findWorktreeRoot, getAncestors,
  resolveSkillSearchDirectories, walkSkillMdFiles,
});

const { shouldSkipCompression } = createCompressionPolicy({
  shouldSkipApiCompression: () => shouldSkipApiCompression(),
});

const OPENCHAMBER_VERSION = (() => {
  try {
    const packagePath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
  }
  return 'unknown';
})();

const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const isEnvFlagDisabled = (value) => {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};

const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.OPENCHAMBER_COMPRESS_API)) return true;
  return process.env.OPENCHAMBER_RUNTIME === 'desktop';
};

const OPENCHAMBER_VERBOSE_REQUEST_LOGS = isEnvFlagEnabled(process.env.OPENCHAMBER_VERBOSE_REQUEST_LOGS);

const PLAN_MODE_EXPERIMENT_ENABLED =
  isEnvFlagEnabled(process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE)
  || isEnvFlagEnabled(process.env.OPENCODE_EXPERIMENTAL);

const fsPromises = fs.promises;

const settingsNormalizationRuntime = createSettingsNormalizationRuntime({
  os,
  homeDirectory: getRuntimeHome(),
  path,
  processLike: process,
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});

const normalizeDirectoryPath = (...args) => settingsNormalizationRuntime.normalizeDirectoryPath(...args);
const normalizePathForPersistence = (...args) => settingsNormalizationRuntime.normalizePathForPersistence(...args);
const normalizeSettingsPaths = (...args) => settingsNormalizationRuntime.normalizeSettingsPaths(...args);
const normalizeTunnelBootstrapTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs(...args);
const normalizeTunnelSessionTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelSessionTtlMs(...args);
const normalizeManagedRemoteTunnelHostname = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname(...args);
const normalizeManagedRemoteTunnelPresets = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets(...args);
const normalizeManagedRemoteTunnelPresetTokens = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens(...args);
const isUnsafeSkillRelativePath = (...args) => settingsNormalizationRuntime.isUnsafeSkillRelativePath(...args);
const sanitizeTypographySizesPartial = (...args) =>
  settingsNormalizationRuntime.sanitizeTypographySizesPartial(...args);
const normalizeStringArray = (...args) => settingsNormalizationRuntime.normalizeStringArray(...args);
const sanitizeModelRefs = (...args) => settingsNormalizationRuntime.sanitizeModelRefs(...args);
const sanitizeSkillCatalogs = (...args) => settingsNormalizationRuntime.sanitizeSkillCatalogs(...args);
const sanitizeHiddenSkills = (...args) => settingsNormalizationRuntime.sanitizeHiddenSkills(...args);
const sanitizeProjects = (...args) => settingsNormalizationRuntime.sanitizeProjects(...args);

const OPENCHAMBER_USER_CONFIG_ROOT = selectedRuntimeBundle?.descriptor.launch.webConfigDirectory ?? path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');
const OPENCHAMBER_PROJECTS_CONFIG_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'projects');

const MAX_THEME_JSON_BYTES = 512 * 1024;


const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: OPENCHAMBER_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});

const readCustomThemesFromDisk = (...args) => themeRuntime.readCustomThemesFromDisk(...args);

let notificationTemplateRuntime = null;

const createTimeoutSignal = (...args) => notificationTemplateRuntime.createTimeoutSignal(...args);
const formatProjectLabel = (...args) => notificationTemplateRuntime.formatProjectLabel(...args);
const resolveNotificationTemplate = (...args) => notificationTemplateRuntime.resolveNotificationTemplate(...args);
const shouldApplyResolvedTemplateMessage = (...args) => notificationTemplateRuntime.shouldApplyResolvedTemplateMessage(...args);
const fetchFreeZenModels = (...args) => notificationTemplateRuntime.fetchFreeZenModels(...args);
const resolveZenModel = (...args) => notificationTemplateRuntime.resolveZenModel(...args);
const resolveZenModelNonBlocking = (...args) => notificationTemplateRuntime.resolveZenModelNonBlocking(...args);
const validateZenModelAtStartup = (...args) => notificationTemplateRuntime.validateZenModelAtStartup(...args);
const summarizeText = (...args) => notificationTemplateRuntime.summarizeText(...args);
const extractTextFromParts = (...args) => notificationTemplateRuntime.extractTextFromParts(...args);
const extractLastMessageText = (...args) => notificationTemplateRuntime.extractLastMessageText(...args);
const fetchSessionMessages = (...args) => notificationTemplateRuntime.fetchSessionMessages(...args);
const fetchLastAssistantMessageText = (...args) => notificationTemplateRuntime.fetchLastAssistantMessageText(...args);
const maybeCacheSessionInfoFromEvent = (...args) => notificationTemplateRuntime.maybeCacheSessionInfoFromEvent(...args);
const buildTemplateVariables = (...args) => notificationTemplateRuntime.buildTemplateVariables(...args);
const getCachedZenModels = (...args) => notificationTemplateRuntime.getCachedZenModels(...args);

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-named-tunnels.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION = 2;
const projectIconStore = createProjectIconStore({
  fsPromises,
  path,
  crypto,
  dataDirectory: OPENCHAMBER_DATA_DIR,
});
const harnessRuntime = createWebHarnessRuntime({
  dataDirectory: OPENCHAMBER_DATA_DIR,
  runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
  logger: console,
  knownSecrets: Object.entries(process.env)
    .filter(([key, value]) => (
      /(?:secret|token|password|api[_-]?key|authorization)/i.test(key)
      && typeof value === 'string'
      && value.length >= 6
    ))
    .map(([, value]) => value),
});
const configuredWorktreeBootstrapRuntime = configureWorktreeBootstrapRuntime({
  store: harnessRuntime.worktreeStore,
  onTransition: (receipt) => {
    harnessRuntime.record({
      type: 'worktree_transition',
      directory: receipt.directory,
      operationID: receipt.operationId,
      stage: receipt.stage,
      status: receipt.status,
      payload: receipt,
    });
  },
});
harnessRuntime.setWorktreeRuntime(configuredWorktreeBootstrapRuntime);

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelToken,
  normalizeManagedRemoteOriginPort,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  },
});

const readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelPreset = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelPreset(...args);

const settingsHelpers = createSettingsHelpers({
  normalizePathForPersistence,
  normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeHiddenSkills,
  sanitizeProjects,
});

const normalizePwaAppName = (...args) => settingsHelpers.normalizePwaAppName(...args);
const normalizePwaOrientation = (...args) => settingsHelpers.normalizePwaOrientation(...args);
const sanitizeSettingsUpdate = (...args) => settingsHelpers.sanitizeSettingsUpdate(...args);
const mergePersistedSettings = (...args) => settingsHelpers.mergePersistedSettings(...args);
const formatSettingsResponse = (...args) => settingsHelpers.formatSettingsResponse(...args);

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
});

const resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  normalizeStringArray,
  formatSettingsResponse,
  resolveDirectoryCandidate,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
  projectIconStore,
});

const readSettingsFromDiskMigrated = (...args) => settingsRuntime.readSettingsFromDiskMigrated(...args);
const readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const writeSettingsToDisk = (...args) => settingsRuntime.writeSettingsToDisk(...args);
const persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({
  readSettingsFromDiskMigrated,
});

const getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
});

const getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions = (...args) => pushRuntime.sendPushToAllUiSessions(...args);
const updateUiVisibility = (...args) => pushRuntime.updateUiVisibility(...args);
const isAnyUiVisible = (...args) => pushRuntime.isAnyUiVisible(...args);
const isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);


const isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);
let globalMessageStreamHub = null;
let multiUserRuntime = null;
let browserObservationRuntime = null;

const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => ENV_DESKTOP_NOTIFY,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});

const writeSseEvent = (...args) => notificationEmitterRuntime.writeSseEvent(...args);
const emitDesktopNotification = (...args) => notificationEmitterRuntime.emitDesktopNotification(...args);
const broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
  globalEventHub: {
    publishSyntheticEvent: (input) => globalMessageStreamHub?.publishSyntheticEvent?.(input) ?? null,
  },
});
const broadcastUiNotification = (...args) => notificationEmitterRuntime.broadcastUiNotification(...args);

const broadcastManagedProjectMetadataChanged = (projectId) => {
  if (typeof projectId !== 'string' || !projectId.trim()) return;
  for (const client of uiOpenChamberEventClients) {
    if (!canReceiveProjectMetadataEvent(client, projectId)) {
      continue;
    }
    try {
      writeSseEvent(client.response, {
        type: 'openchamber:project-metadata-changed',
        properties: { projectId },
      });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};

const broadcastManagedSessionOwnershipCommitted = (session) => {
  if (!session?.id) return;
  broadcastGlobalUiEvent({
    type: 'session.created',
    properties: { info: session },
  }, {
    directory: typeof session.directory === 'string' && session.directory.length > 0
      ? session.directory
      : 'global',
  });
};

const broadcastBrowserAgentLeasesChanged = (principalId, revision) => {
  if (typeof principalId !== 'string' || !principalId) return;
  for (const client of uiOpenChamberEventClients) {
    if (client?.principalId !== principalId) continue;
    try {
      writeSseEvent(client.response, {
        type: 'openchamber:browser-agent-leases-changed',
        properties: { revision },
      });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};

const sessionRuntime = createSessionRuntime({
  writeSseEvent,
  getNotificationClients: () => uiNotificationClients,
  broadcastEvent: broadcastGlobalUiEvent,
});

let evidenceRuntime = null;
const turnTimingRuntime = createTurnTimingRuntime({
  onTurnEvent: (event) => {
    harnessRuntime.recordLifecycleEvent(event);
    evidenceRuntime?.processLifecycleEvent(event);
  },
  // Turn timing persists in the diagnostic journal (and Export Diagnostics).
  onTurnMark: (entry) => harnessRuntime.recordTurnTiming(entry),
  onTurnSettled: (entry) => harnessRuntime.recordTurnTiming(entry),
});
// Native provider request marks and the primary step's request identity.
const nativeProviderTiming = createNativeProviderTiming({ onMark: (input) => turnTimingRuntime.recordSessionMark(input) });

// Activity projection is observational; a slow Supabase must not accumulate
// unbounded in-flight projections (one per tool event).
const activityProjection = createBoundedTaskRunner({ concurrency: 64, maxQueued: 2_000,
  onError: (error) => console.warn('[MultiUser] Failed to project OpenCode activity:', error?.message || error),
  onDrop: (dropped) => {
    if (dropped === 1 || dropped % 1_000 === 0) console.warn(`[MultiUser] Activity projection backlog full; ${dropped} events dropped`);
  } });
const pendingSessionOwnership = new Set();
const pendingSessionCleanup = new Set();
let failedSessionCleanup = false;
const projectMultiUserActivity = (payload) => {
  // Session creation records local root ownership when Supabase is off. It is
  // rare and never dropped with the observational backlog.
  if (payload?.type === 'session.created') {
    const pending = Promise.resolve().then(() => multiUserRuntime?.recordOpenCodeActivity?.(payload))
      .catch((error) => console.warn('[MultiUser] Failed to record session creation:', error?.message || error))
      .finally(() => pendingSessionOwnership.delete(pending));
    pendingSessionOwnership.add(pending);
    return;
  }
  activityProjection.run(() => multiUserRuntime?.recordOpenCodeActivity?.(payload));
};

const emitSyntheticOpenCodeEvent = (payload, options = {}) => {
  managedOrchestrationRuntime?.processOpenCodeEvent?.(payload, options.directory ?? null);
  maybeCacheSessionInfoFromEvent(payload);
  sessionRuntime.processOpenCodeSsePayload(payload);
  turnTimingRuntime.processOpenCodeEvent(payload);
  harnessRuntime.recordOpenCodeEvent(payload, options.directory ?? null);
  projectMultiUserActivity(payload);
  void evidenceRuntime?.processOpenCodeEvent(payload);
  broadcastGlobalUiEvent(payload, options);
};

const resolveCursorSdkAgentModelSelection = async (agent, resolveModelSelection) => {
  const model = agent?.model && typeof agent.model === 'object' && !Array.isArray(agent.model)
    ? agent.model
    : null;
  const providerID = typeof model?.providerID === 'string' ? model.providerID.trim() : '';
  const modelID = typeof model?.modelID === 'string' ? model.modelID.trim() : '';
  if (providerID !== CURSOR_PROVIDER_ID || !modelID || typeof resolveModelSelection !== 'function') {
    return 'inherit';
  }

  const variant = typeof agent?.variant === 'string' && agent.variant.trim()
    ? agent.variant.trim()
    : undefined;
  try {
    return await resolveModelSelection({ modelID, variant });
  } catch (error) {
    console.warn('[CursorSDK] failed to resolve agent model selection:', error);
    return { id: modelID };
  }
};

const resolveCursorSdkAgentDefinitions = async ({ directory, resolveModelSelection } = {}) => {
  const definitions = {};
  for (const agent of listConfigAgents(directory)) {
    const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
    const prompt = typeof agent?.prompt === 'string' ? agent.prompt.trim() : '';
    if (!name || !prompt || name.toLowerCase() === 'council') continue;
    definitions[name] = {
      description: typeof agent.description === 'string' && agent.description.trim()
        ? agent.description.trim()
        : `${name} DevRyan agent`,
      prompt,
      model: await resolveCursorSdkAgentModelSelection(agent, resolveModelSelection),
    };
  }
  return definitions;
};

const nativeBundle = await loadNativeRuntimeBundle({binding:selectedRuntimeBundle,verify:verifySelectedRuntimeBundle,
 launcher:executionArtifacts(path.dirname(selectedRuntimeBundle.descriptor.launch.artifactManifestPath)).launcher,
 getRegisteredProjects:async()=>sanitizeProjects((await readSettingsFromDisk())?.projects) ?? []});
const executionReadiness={state:'active',diagnostic:null,companion:{version:'2.0.20'},
 environment:{DEVRYAN_EXECUTION_BOUNDARY:'1',DEVRYAN_OPENCODE_ARTIFACT:nativeBundle.artifacts.controller,
 DEVRYAN_EXECUTION_LAUNCHER:nativeBundle.artifacts.launcher},assertReady(){}};
const capturedExecutionEnvironment = executionReadiness.environment;
if (nativeBundle) {
  const launch = nativeBundle.descriptor.launch;
  writeOpenCodeRuntimeSelection({ version: 1, writtenAt: Date.now(), ownerPid: process.pid,
    runtime: { generation: 2, kind: 'host', binary: launch.controllerBinary, channel: 'opencode' },
    opencode: { dataDirectory: launch.global.data, databasePath: launch.opencodeDatabasePath,
      configDirectory: launch.opencodeConfigDirectory, databaseSource: 'OPENCODE_DB' } });
}
const capturedExecutions = capturedExecutionEnvironment.DEVRYAN_EXECUTION_BOUNDARY === '1'
  && (!process.env.OPENCODE_HOST || process.env.DEVRYAN_EXECUTION_BOUNDARY === '1');

const sessionActivityGate = createSessionActivityGate();
const cursorSdkRuntime = createCursorSdkRuntime({
  ...(nativeBundle?{ownedPrompt:input=>nativeRuntime.ownedCursorPrompt(input),resolveApiKey:input=>nativeRuntime.resolveCursorApiKey(input),
    ownedReadOnly:(input,action)=>nativeRuntime.withCursorReadOnly(input,action),nativeWarming:false}:{}),
  // A degraded host runs plain OpenCode, so Cursor runs unconfined as in
  // external mode; a required-but-unavailable runtime still fails closed.
  ...(['active', 'required_unavailable'].includes(executionReadiness.state) ? { executionAdapter: { reserveActivity: ({ sessionID }) => sessionActivityGate.enter([sessionID]), start: (input) => sessionExecutionHost.startCursor(input),
    startReadOnly: input => nativeBundle?nativeRuntime.withCursorReadOnlyExecution(()=>sessionExecutionHost.startReadOnly(input)):sessionExecutionHost.startReadOnly(input),
    beforePrompt: (input) => sessionExecutionHost.beforeCursorPrompt(input) },
  onPersistRecord: (input) => sessionExecutionHost.persistCursorRecord(input) } : {}),
  storageDir: path.join(OPENCHAMBER_DATA_DIR, 'cursor-sdk-sessions'),
  readAuth: readAuthFile,
  env: process.env,
  emitEvent: emitSyntheticOpenCodeEvent,
  onSessionChangeExecution: (input) => sessionChangeHost.acceptExecution(input),
  onUsageObservation: ({ sessionID, messageID, userMessageID, directory, observation }) => harnessRuntime.record({
    type: 'lifecycle', sessionID, directory,
    payload: { event: 'cursor.usage', sessionID, messageID, userMessageID, observation },
  }),
  onTitleUsageObservation: ({ sessionID, directory, observation }) => harnessRuntime.record({
    type: 'lifecycle', sessionID: sessionID || undefined, directory,
    payload: { event: 'cursor.title.usage', sessionID, observation },
  }),
  recordTimingMark: (input) => turnTimingRuntime.recordClientMark(input),
  logger: console,
  resolveAgentPrompt: async ({ agent, directory }) => {
    const result = getAgentConfig(agent, directory);
    return typeof result?.config?.prompt === 'string' ? result.config.prompt : '';
  },
  resolveAgentDefinitions: resolveCursorSdkAgentDefinitions,
});

const cursorPromptRuntime={...cursorSdkRuntime,handlePromptAsync:input=>nativeBundle?nativeRuntime.cursorPrompt(input):cursorSdkRuntime.handlePromptAsync(input)};
const getActiveSessionCount = () => {
  const snapshot = sessionRuntime.getSessionActivitySnapshot();
  return Object.values(snapshot).filter((entry) => entry.type !== 'idle').length;
};

const getUpstreamStallTimeoutMs = () => (
  getActiveSessionCount() > 1
    ? UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS
    : DEFAULT_UPSTREAM_STALL_TIMEOUT_MS
);

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
});
evidenceRuntime = createWebEvidenceRuntime({
  evidenceDirectory: harnessRuntime.paths.evidenceDir,
  projectConfigRuntime,
  getSessionActivity: (sessionID) => sessionRuntime.getSessionActivitySnapshot()[sessionID] ?? null,
  journal: harnessRuntime.journal,
  runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
  logger: console,
});
harnessRuntime.setEvidenceRuntime(evidenceRuntime);

// HMR-persistent state via globalThis
// These values survive Vite HMR reloads to prevent zombie OpenCode processes
const hmrStateRuntime = createHmrStateRuntime({
  globalThisLike: globalThis,
  os,
  processLike: process,
  stateKey: '__openchamberHmrState',
});
const hmrState = hmrStateRuntime.getOrCreateHmrState();
hmrStateRuntime.ensureUserProvidedOpenCodePassword(hmrState);

// Non-HMR state (safe to reset on reload)
let healthCheckInterval = null;
let server = null;
let expressApp = null;
let currentRestartPromise = null;
let isRestartingOpenCode = false;
let openCodeApiPrefix = '';
let openCodeApiPrefixDetected = true;
let openCodeApiDetectionTimer = null;
let lastOpenCodeError = null;
let openCodeProfileNotices = [];
let lastOpenCodeLaunchDiagnostics = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
// Desktop shells set this via startWebUiServer options to surface OpenCode
// boot progress on the native startup splash.
let onOpenCodeStartupStatus = null;
let observeCommandDeadline = () => false;
let exitOnShutdown = true;
let uiAuthController = null;
let activeTunnelController = null;
let globalWatcherStartPromise = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';
let terminalRuntime = null;
let messageStreamRuntime = null;
let managedOrchestrationRuntime = null;
let nativeRuntime = null;
let browserLeaseRuntime = null;
let managedBrowserEnvironmentProvider = null;
let botEncryptionKeyProvider = null;
let botEncryptionKeyInstaller = null;
let botRuntimeStatusProvider = null;
let botRuntimeControlProvider = null;
let botRuntimeIndexerProvider = null;
let botAgentRequestProvider = null;
let botBrowserProfilesProvider = null;
let botCatalogProvider = null;
let projectPrewarmRuntime = null;
const userProvidedOpenCodePassword = hmrStateRuntime.getUserProvidedOpenCodePassword(hmrState);
const initialOpenCodeAuthState = hmrStateRuntime.resolveOpenCodeAuthFromState({
  hmrState,
  userProvidedOpenCodePassword,
});
let openCodeAuthPassword = initialOpenCodeAuthState.openCodeAuthPassword;
let openCodeAuthSource = initialOpenCodeAuthState.openCodeAuthSource;

// Sync helper - call after modifying any HMR state variable
const syncToHmrState = () => {
  hmrStateRuntime.syncStateFromRuntime(hmrState, {
    openCodeProcess,
    openCodePort,
    openCodeVersion,
    openCodeGeneration,
    openCodeEpoch,
    openCodePaths,
    openCodeBaseUrl,
    isShuttingDown,
    signalsAttached,
    openCodeWorkingDirectory,
    openCodeAuthPassword,
    openCodeAuthSource,
  });
};

// Sync helper - call to restore state from HMR (e.g., on module reload)
const syncFromHmrState = () => {
  const restored = hmrStateRuntime.restoreRuntimeFromState({
    hmrState,
    userProvidedOpenCodePassword,
  });
  openCodeProcess = restored.openCodeProcess;
  openCodePort = restored.openCodePort;
  openCodeVersion = restored.openCodeVersion;
  openCodeGeneration = restored.openCodeGeneration === 2 ? 2 : null;
  openCodeEpoch = restored.openCodeEpoch;
  openCodePaths = restored.openCodePaths;
  openCodeBaseUrl = restored.openCodeBaseUrl;
  isShuttingDown = restored.isShuttingDown;
  signalsAttached = restored.signalsAttached;
  openCodeWorkingDirectory = restored.openCodeWorkingDirectory;
  openCodeAuthPassword = restored.openCodeAuthPassword;
  openCodeAuthSource = restored.openCodeAuthSource;
};

// Module-level variables that shadow HMR state
// These are synced to/from hmrState to survive HMR reloads
let openCodeProcess = hmrState.openCodeProcess;
let openCodePort = hmrState.openCodePort;
let openCodeVersion = hmrState.openCodeVersion ?? null;
let openCodeGeneration = 2;
let openCodeEpoch = hmrState.openCodeEpoch ?? 0;
let openCodePaths = hmrState.openCodePaths ?? {};
let openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;
const invalidateOpenCodeRuntime = () => {
  openCodeEpoch += 1;
};

const {
  configuredOpenCodePort: ENV_CONFIGURED_OPENCODE_PORT,
  configuredOpenCodeHost: ENV_CONFIGURED_OPENCODE_HOST,
  effectivePort: ENV_EFFECTIVE_PORT,
  configuredOpenCodeHostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
} = resolveOpenCodeEnvConfig({
  env: process.env,
  logger: console,
});

const ENV_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START === 'true' ||
                                    process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true';
const ENV_DESKTOP_NOTIFY = (() => {
  if (process.env.OPENCHAMBER_DESKTOP_NOTIFY === 'true') {
    return true;
  }

  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  const argv0 = typeof process.argv?.[0] === 'string' ? process.argv[0] : '';
  const argv1 = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return /openchamber-server/i.test(argv0) || /openchamber-server/i.test(argv1);
})();
const ENV_CONFIGURED_OPENCODE_WSL_DISTRO =
  typeof process.env.OPENCODE_WSL_DISTRO === 'string' && process.env.OPENCODE_WSL_DISTRO.trim().length > 0
    ? process.env.OPENCODE_WSL_DISTRO.trim()
    : (
      typeof process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO === 'string' &&
      process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO.trim().length > 0
        ? process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO.trim()
        : null
    );

const openCodeAuthStateRuntime = createOpenCodeAuthStateRuntime({
  crypto,
  process,
  getAuthPassword: () => openCodeAuthPassword,
  setAuthPassword: (value) => {
    openCodeAuthPassword = value;
  },
  getAuthSource: () => openCodeAuthSource,
  setAuthSource: (value) => {
    openCodeAuthSource = value;
  },
  getUserProvidedPassword: () => userProvidedOpenCodePassword,
  syncToHmrState,
});

const getOpenCodeAuthHeaders = (...args) => nativeBundle ? nativeRuntime?.getAuthHeaders() ?? {} : openCodeAuthStateRuntime.getOpenCodeAuthHeaders(...args);
const isOpenCodeConnectionSecure = (...args) => openCodeAuthStateRuntime.isOpenCodeConnectionSecure(...args);
const ensureLocalOpenCodeServerPassword = (...args) => openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword(...args);

const openCodeNetworkState = {};
Object.defineProperties(openCodeNetworkState, {
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeVersion: { get: () => openCodeVersion, set: (value) => { openCodeVersion = value; } },
  openCodeGeneration: { get: () => openCodeGeneration, set: (value) => { openCodeGeneration = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => {
    if (value !== openCodeBaseUrl) invalidateOpenCodeRuntime();
    openCodeBaseUrl = value;
  } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
});

const openCodeNetworkRuntime = createOpenCodeNetworkRuntime({
  state: openCodeNetworkState,
  getOpenCodeAuthHeaders,
});

const waitForReady = (...args) => openCodeNetworkRuntime.waitForReady(...args);
const normalizeApiPrefix = (...args) => openCodeNetworkRuntime.normalizeApiPrefix(...args);
const setDetectedOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix(...args);
const buildOpenCodeUrl = (...args) => openCodeNetworkRuntime.buildOpenCodeUrl(...args);
const getOpenCodeRuntime = () => ({
  generation: openCodeGeneration,
  epoch: openCodeEpoch,
  baseUrl: openCodePort ? (openCodeBaseUrl ?? `http://localhost:${openCodePort}`) : '',
  version: openCodeVersion,
  paths: openCodePaths,
});
const openCodeClientDeps = {
  getRuntime: getOpenCodeRuntime,
  getAuthHeaders: getOpenCodeAuthHeaders,
  projector: () => globalMessageStreamHub?.getProjector() ?? null,
  recordDiagnostic: (payload) => harnessRuntime.record({ type: 'lifecycle', event: 'opencode_client', payload }),
  ...(nativeBundle ? {
    withNativeWebOperation: (spec, action) => nativeRuntime.nativeOwner.withWebOperation(spec, action),
    removeNativeSession: (sessionID, options) => nativeRuntime.removeSession(sessionID, options),
  } : {}),
};
const openCodeClient = createOpenCodeClient({ ...openCodeClientDeps, getAdmission: () => openCodeAdmission });
const openCodeAdmission = createOpenCodeAdmission(openCodeClientDeps, { client: openCodeClient,
  ...(nativeBundle ? { nativeOwner: {
    requestHeaders: () => nativeRuntime.nativeOwner.requestHeaders(),
    withAcceptedOperation: (input, action) => nativeRuntime.nativeOwner.withAcceptedOperation(input, action),
    withCommandSelection: (input, action) => nativeRuntime.nativeOwner.withCommandSelection(input, action),
    checkQueuedPromptAdmission:(...args)=>nativeRuntime.nativeOwner.checkQueuedPromptAdmission(...args),
    stageQueuedPromptAdmission:(...args)=>nativeRuntime.nativeOwner.stageQueuedPromptAdmission(...args),
    assertQueuedPromptReconciled:(...args)=>nativeRuntime.nativeOwner.assertQueuedPromptReconciled(...args),
    queuedPromptWasRejected:(...args)=>nativeRuntime.nativeOwner.queuedPromptWasRejected(...args),
    updateAcceptedOperation: input => nativeRuntime.nativeOwner.updateAcceptedOperation(input),
  } } : {}),
  requiresEffectiveSelection: () => primaryRecoveryRuntime.requiresNativePromptSelection(),
  beforePromptDispatch: (receipt, context) => primaryRecoveryRuntime.admitNativePrompt(receipt, context),
  onPromptDispatchFailure: (receipt) => primaryRecoveryRuntime.markNativePromptUncertain(receipt),
  ...(nativeBundle?{externalPromptDispatch:(receipt,request)=>nativeRuntime.dispatchExternalPrompt(receipt,request)}:{}),
});
const xaiToolCatalogRuntime = createXaiToolCatalogRuntime({
  openCodeClient,
  fetchImpl: fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  logger: console,
});
// Keep recently-used directories' Grok tool catalogs fresh so xAI prompts
// never hit the in-request cold-start wait after the 15-min cache TTL.
xaiToolCatalogRuntime.startPeriodicRefresh();
const ensureOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.ensureOpenCodeApiPrefix(...args);
const scheduleOpenCodeApiDetection = (...args) => openCodeNetworkRuntime.scheduleOpenCodeApiDetection(...args);

const collectAuthoritativeActiveSessions = async () => {
  if (!openCodePort) {
    return [];
  }

  const settings = await readSettingsFromDiskMigrated();
  const directories = new Set();
  const addDirectory = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const normalized = normalizeDirectoryPath(value);
    if (normalized) directories.add(normalized);
  };

  addDirectory(openCodeWorkingDirectory);
  addDirectory(settings?.lastDirectory);
  for (const project of sanitizeProjects(settings?.projects)) {
    addDirectory(project?.path);
  }

  if (directories.size === 0) {
    addDirectory(process.cwd());
  }

  const activeSessionsById = new Map();
  await Promise.all([...directories].map(async (directory) => {
    const statuses = await openCodeClient.sessions.status({ directory }, { timeoutMs: 5000 });
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      throw new Error('OpenCode session status returned an invalid payload');
    }
    for (const [sessionId, status] of Object.entries(statuses)) {
      if (status && typeof status === 'object' && status.type && status.type !== 'idle') {
        activeSessionsById.set(sessionId, { sessionId, directory });
      }
    }
  }));

  return [...activeSessionsById.values()];
};

const getAuthoritativeActiveSessionCount = async () => {
  const activeSessions = await collectAuthoritativeActiveSessions();
  return Math.max(getActiveSessionCount(), activeSessions.length);
};

const abortActiveSessionsForConfigRestart = async () => {
  const sessions = await collectAuthoritativeActiveSessions();
  await Promise.allSettled(sessions.map(async ({ sessionId, directory }) => {
    await openCodeClient.sessions.abort(sessionId, { directory, timeoutMs: 5000 });
  }));
};

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OPENCHAMBER_API_PREFIX || ''
);

  if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

let cachedLoginShellEnvSnapshot;
let resolvedOpencodeBinary = null;
let resolvedOpencodeBinarySource = null;
let resolvedNodeBinary = null;
let resolvedBunBinary = null;
let resolvedGitBinary = null;
let useWslForOpencode = false;
let resolvedWslBinary = null;
let resolvedWslOpencodePath = null;
let resolvedWslDistro = null;

const openCodeEnvState = {};
Object.defineProperties(openCodeEnvState, {
  cachedLoginShellEnvSnapshot: { get: () => cachedLoginShellEnvSnapshot, set: (value) => { cachedLoginShellEnvSnapshot = value; } },
  resolvedOpencodeBinary: { get: () => resolvedOpencodeBinary, set: (value) => { resolvedOpencodeBinary = value; } },
  resolvedOpencodeBinarySource: { get: () => resolvedOpencodeBinarySource, set: (value) => { resolvedOpencodeBinarySource = value; } },
  resolvedNodeBinary: { get: () => resolvedNodeBinary, set: (value) => { resolvedNodeBinary = value; } },
  resolvedBunBinary: { get: () => resolvedBunBinary, set: (value) => { resolvedBunBinary = value; } },
  resolvedGitBinary: { get: () => resolvedGitBinary, set: (value) => { resolvedGitBinary = value; } },
  useWslForOpencode: { get: () => useWslForOpencode, set: (value) => { useWslForOpencode = value; } },
  resolvedWslBinary: { get: () => resolvedWslBinary, set: (value) => { resolvedWslBinary = value; } },
  resolvedWslOpencodePath: { get: () => resolvedWslOpencodePath, set: (value) => { resolvedWslOpencodePath = value; } },
  resolvedWslDistro: { get: () => resolvedWslDistro, set: (value) => { resolvedWslDistro = value; } },
});

const openCodeEnvRuntime = createOpenCodeEnvRuntime({
  homeDirectory: getRuntimeHome(),
  state: openCodeEnvState,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated,
  ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
});

const applyLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.getLoginShellEnvSnapshot(...args);
const isExecutable = (...args) => openCodeEnvRuntime.isExecutable(...args);
const searchPathFor = (...args) => openCodeEnvRuntime.searchPathFor(...args);
const resolveGitBinaryForSpawn = (...args) => openCodeEnvRuntime.resolveGitBinaryForSpawn(...args);
const openCodeResolutionRuntime=createOpenCodeResolutionRuntime({getNativeBundle:()=>nativeBundle,
 getDetectedOpenCodeVersion:()=>openCodePort?openCodeVersion:null});
const getOpenCodeResolutionSnapshot=(...args)=>openCodeResolutionRuntime.getOpenCodeResolutionSnapshot(...args);

applyLoginShellEnvSnapshot();

notificationTemplateRuntime = createNotificationTemplateRuntime({
  openCodeClient,
  readSettingsFromDisk,
  persistSettings,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
});

const standardSessionTitleRuntime = createStandardSessionTitleRuntime({
  openCodeClient,
  generateHelperText: request => nativeRuntime.generateHelperText(request),
  renameGeneratedTitle: request => nativeRuntime.renameGeneratedTitle(request),
  cursorRuntime: cursorSdkRuntime,
  fetchImpl: fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  outboxFilePath: path.join(OPENCHAMBER_DATA_DIR, 'session-title-outbox.json'),
  onTitleGenerated: ({ session, title, directory }) => {
    emitSyntheticOpenCodeEvent({
      type: 'session.updated',
      properties: {
        sessionID: session.id,
        info: {
          ...session,
          title,
        },
      },
    }, { directory });
  },
  recordDiagnostic: (entry) => harnessRuntime.record(entry),
  logger: console,
});

const notificationTriggerRuntime = createNotificationTriggerRuntime({
  openCodeClient,
  readSettingsFromDisk,
  prepareNotificationLastMessage,
  summarizeText,
  resolveZenModel,
  buildTemplateVariables,
  extractLastMessageText,
  fetchSessionMessages,
  fetchLastAssistantMessageText,
  resolveNotificationTemplate,
  shouldApplyResolvedTemplateMessage,
  emitDesktopNotification,
  broadcastUiNotification,
  sendPushToAllUiSessions,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchSessionInfo: (...args) => notificationTemplateRuntime.fetchSessionInfo(...args),
  forgetSessionCaches: (sessionId) => notificationTemplateRuntime?.forgetSessionCaches?.(sessionId),
});

const maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);
const setAutoAcceptSession = (...args) => notificationTriggerRuntime.setAutoAcceptSession(...args);

globalMessageStreamHub = createGlobalMessageStreamHub({
  openCodeClient,
  getOpenCodeRuntime,
  recordDiagnostic: openCodeClientDeps.recordDiagnostic,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
  // Applied before replay buffering and fan-out: WS clients only ever need the
  // per-file diff counts, never the multi-MB patch bodies OpenCode attaches to
  // `message.updated` / `session.updated`.
  transformEventPayload: stripEventDiffContent,
});

const processCanonicalOpenCodeEvent = createCanonicalOpenCodeEventProcessor({
  cacheSessionInfo: maybeCacheSessionInfoFromEvent,
  sendPush: maybeSendPushForTrigger,
  processSessionState: (payload) => sessionRuntime.processOpenCodeSsePayload(payload),
  processTurnTiming: (payload) => turnTimingRuntime.processOpenCodeEvent(payload),
  recordJournalEvent: (payload, directory) => harnessRuntime.recordOpenCodeEvent(payload, directory),
  recordMultiUserActivity: projectMultiUserActivity,
  processEvidence: (payload) => evidenceRuntime?.processOpenCodeEvent(payload),
  processBrowserLease: (payload) => browserLeaseRuntime?.processOpenCodeEvent(payload),
  processManagedOrchestration: (payload, directory) => managedOrchestrationRuntime?.processOpenCodeEvent?.(payload, directory),
  processSessionTitle: (payload) => standardSessionTitleRuntime.processOpenCodeEvent(payload),
  processCommandDeadline: (payload) => observeCommandDeadline(payload),
  onSessionDeleted: (deletedSessionId) => {
    sessionRuntime.clearSessionActivity(deletedSessionId);
    const cleanup = cursorSdkRuntime.deleteSessionState(deletedSessionId);
    pendingSessionCleanup.add(cleanup);
    cleanup.then(() => pendingSessionCleanup.delete(cleanup), (error) => {
      failedSessionCleanup = true;
      pendingSessionCleanup.delete(cleanup);
      console.warn('[CursorSDK] Failed to clean up deleted session state:', error);
    });
  },
});

const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  openCodeClient,
  waitForOpenCodePort: (...args) => waitForOpenCodePort(...args),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  parseSseDataPayload: (...args) => parseSseDataPayload(...args),
  globalEventHub: globalMessageStreamHub,
  onPayload: processCanonicalOpenCodeEvent,
});


const serverUtilsRuntime = createServerUtilsRuntime({
  homeDirectory: getRuntimeHome(),
  openCodeClient,
  getOpenCodeRuntime,
  globalMessageStreamHub,
  getNativeRuntimeOwner: () => nativeRuntime,
  resolveRequestDirectory: (req) => resolveProjectDirectory(req),
  messageStreamEventFilter: (principal, entry) => multiUserRuntime?.filterEventForPrincipal(principal, entry),
  registerMessageStreamConnection: (principal, onRevoke) => multiUserRuntime?.registerConnection(principal, onRevoke),
  getSessionRevertCoordinator: () => capturedExecutions ? sessionExecutionHost.coordinator : undefined,
  // Without the coordinator, the legacy revert path must first prove the
  // conversation has no ledger-owned history.
  getLegacyRevertGuard: () => capturedExecutions ? undefined : (input) => sessionExecutionHost.assertLegacyRevertAllowed(input),
  recordDiagnostic: (entry) => harnessRuntime.record(entry),
  fs,
  os,
  path,
  process,
  openCodeReadyGraceMs: OPEN_CODE_READY_GRACE_MS,
  longRequestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
  getRuntime: () => ({
    openCodePort,
    openCodeBaseUrl,
    openCodeVersion,
    openCodeNotReadySince,
    isOpenCodeReady,
    isRestartingOpenCode,
  }),
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  ensureOpenCodeApiPrefix,
  turnTimingRuntime,
  getUiNotificationClients: () => uiNotificationClients,
  getOpenCodePort: () => openCodePort,
  setOpenCodePortState: (value) => {
    if (value !== openCodePort) invalidateOpenCodeRuntime();
    openCodePort = value;
  },
  syncToHmrState,
  markOpenCodeNotReady: () => {
    isOpenCodeReady = false;
  },
  setOpenCodeNotReadySince: (value) => {
    openCodeNotReadySince = value;
  },
  clearLastOpenCodeError: () => {
    lastOpenCodeError = null;
  },
  getLoginShellPath: () => {
    const snapshot = getLoginShellEnvSnapshot();
    if (!snapshot || typeof snapshot.PATH !== 'string' || snapshot.PATH.length === 0) {
      return null;
    }
    return snapshot.PATH;
  },
});

const setOpenCodePort = (...args) => serverUtilsRuntime.setOpenCodePort(...args);
const waitForOpenCodePort = (...args) => serverUtilsRuntime.waitForOpenCodePort(...args);
const buildAugmentedPath = (...args) => serverUtilsRuntime.buildAugmentedPath(...args);
const buildManagedOpenCodePath = (...args) => serverUtilsRuntime.buildManagedOpenCodePath(...args);
const parseSseDataPayload = (...args) => serverUtilsRuntime.parseSseDataPayload(...args);
const staticRoutesRuntime = createStaticRoutesRuntime({
  openCodeClient,
  fs,
  path,
  process,
  __dirname,
  express,
  resolveProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  normalizePwaAppName,
  normalizePwaOrientation,
});
const featureRoutesRuntime = createFeatureRoutesRuntime({
  clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
});
const bootstrapRuntime = createBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerOpenChamberRoutes,
  express,
});
const tunnelWiringRuntime = createTunnelWiringRuntime({
  crypto,
  URL,
  tunnelProviderRegistry,
  tunnelAuthController,
  readSettingsFromDiskMigrated,
  readManagedRemoteTunnelConfigFromDisk,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteOriginPort,
  isValidManagedRemoteOriginPort,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  isSupportedTunnelMode,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelPreset,
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
  setRuntimeManagedRemoteTunnelHostname: (value) => {
    runtimeManagedRemoteTunnelHostname = value;
  },
  getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
  setRuntimeManagedRemoteTunnelToken: (value) => {
    runtimeManagedRemoteTunnelToken = value;
  },
  getRuntimeReady: () => Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
  getManagedAccountLoginAvailable: () => Boolean(uiAuthController?.multiUser),
});
const startupPipelineRuntime = createStartupPipelineRuntime({
  createTerminalRuntime,
  createGlobalMessageStreamSseHandler,
  createMessageStreamWsRuntime,
  createServerStartupRuntime,
});

const openCodeLifecycleState = {};
Object.defineProperties(openCodeLifecycleState, {
  openCodePaths: { get: () => openCodePaths, set: (value) => {
    if (JSON.stringify(value) !== JSON.stringify(openCodePaths)) invalidateOpenCodeRuntime();
    openCodePaths = value;
  } },
  appliedAgentRuntimeSettings: { get: () => hmrState.appliedAgentRuntimeSettings ?? null, set: (value) => { hmrState.appliedAgentRuntimeSettings = value; } },
  openCodeProcess: { get: () => openCodeProcess, set: (value) => {
    if (value !== openCodeProcess) invalidateOpenCodeRuntime();
    openCodeProcess = value;
  } },
  openCodeGeneration: { get: () => openCodeGeneration, set: (value) => { openCodeGeneration = value; } },
  openCodeVersion: { get: () => openCodeVersion, set: (value) => { openCodeVersion = value; } },
  openCodePort: { get: () => openCodePort, set: (value) => {
    if (value !== openCodePort) invalidateOpenCodeRuntime();
    openCodePort = value;
  } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => {
    if (value !== openCodeBaseUrl) invalidateOpenCodeRuntime();
    openCodeBaseUrl = value;
  } },
  openCodeWorkingDirectory: { get: () => openCodeWorkingDirectory, set: (value) => { openCodeWorkingDirectory = value; } },
  currentRestartPromise: { get: () => currentRestartPromise, set: (value) => { currentRestartPromise = value; } },
  isRestartingOpenCode: { get: () => isRestartingOpenCode, set: (value) => {
    if (value && !isRestartingOpenCode) invalidateOpenCodeRuntime();
    isRestartingOpenCode = value;
  } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
  lastOpenCodeError: { get: () => lastOpenCodeError, set: (value) => { lastOpenCodeError = value; } },
  openCodeProfileNotices: { get: () => openCodeProfileNotices, set: (value) => { openCodeProfileNotices = value; } },
  lastOpenCodeLaunchDiagnostics: { get: () => lastOpenCodeLaunchDiagnostics, set: (value) => { lastOpenCodeLaunchDiagnostics = value; } },
  isOpenCodeReady: { get: () => isOpenCodeReady, set: (value) => { isOpenCodeReady = value; } },
  openCodeNotReadySince: { get: () => openCodeNotReadySince, set: (value) => { openCodeNotReadySince = value; } },
  isExternalOpenCode: { get: () => isExternalOpenCode, set: (value) => { isExternalOpenCode = value; } },
  isShuttingDown: { get: () => isShuttingDown, set: (value) => { isShuttingDown = value; } },
  healthCheckInterval: { get: () => healthCheckInterval, set: (value) => { healthCheckInterval = value; } },
  expressApp: { get: () => expressApp, set: (value) => { expressApp = value; } },
  useWslForOpencode: { get: () => useWslForOpencode, set: (value) => { useWslForOpencode = value; } },
  resolvedWslBinary: { get: () => resolvedWslBinary, set: (value) => { resolvedWslBinary = value; } },
  resolvedWslOpencodePath: { get: () => resolvedWslOpencodePath, set: (value) => { resolvedWslOpencodePath = value; } },
  resolvedWslDistro: { get: () => resolvedWslDistro, set: (value) => { resolvedWslDistro = value; } },
});

const openAiOAuthCoordinator = createOpenAiOAuthCoordinator({
  stateFile: path.join(OPENCHAMBER_DATA_DIR, 'runtime', 'openai-oauth-state.json'),
  recordDiagnostic: (entry) => harnessRuntime.record(entry),
});
const openAiOAuthBridge = createOpenAiOAuthBridge({ coordinator: openAiOAuthCoordinator });

const openCodeDbMaintenance = createOpenCodeDbMaintenance({
  dataDir: OPENCHAMBER_DATA_DIR,
  journal: (entry) => harnessRuntime.record(entry),
});
const openCodeDbCompactionScheduler = createOpenCodeDbCompactionScheduler();
const readOpenCodeDbMaintenanceSettings = async () => normalizeOpenCodeDbMaintenanceSettings(
  (await readSettingsFromDisk())?.opencodeDbMaintenance,
);
// Runs in the only window where OpenCode's database is not open by the
// runtime: right before a managed spawn while no managed child exists. The
// automatic pass is delete-only and time-bounded; Settings → Storage "Compact"
// schedules a single forced VACUUM pass and restarts OpenCode to reach here.
const runOpenCodeDbMaintenanceBeforeSpawn = async ({ reason } = {}) => {
  const forced = openCodeDbCompactionScheduler.consumeForced();
  const settings = await readOpenCodeDbMaintenanceSettings();
  if (!forced && !settings.enabled) return;
  await openCodeDbMaintenance.run({
    idleHours: settings.idleHours,
    keepSeqPerAggregate: settings.keepSeqPerAggregate,
    vacuum: forced ? 'force' : 'never',
    timeBudgetMs: forced ? null : OPENCODE_DB_PRELAUNCH_TIME_BUDGET_MS,
    reason: forced ? 'compact' : (typeof reason === 'string' && reason ? reason : 'startup'),
  });
};

const userProfileProvisioning = createUserProfileProvisioningRuntime({
  configDirectory: selectedRuntimeBundle?.descriptor.launch.opencodeConfigDirectory, homedir: getRuntimeHome,
  configRoot: defaultConfigRoot,
  profileRoot: path.join(defaultConfigRoot, 'user-profile'),
});
// Sessions that died with a crashed OpenCode never receive idle from its
// replacement; settle only those the restarted runtime reports idle.
const runtimeRestartReconciler = createRuntimeRestartReconciler({
  listActiveSessions: () => sessionRuntime.listActiveSessions(),
  resolveSessionDirectory: async (sessionId) => {
    const info = await notificationTemplateRuntime.fetchSessionInfo(sessionId);
    return typeof info?.directory === 'string' ? info.directory : null;
  },
  readRuntimeStatuses: async (directory) => {
    const statuses = await openCodeClient.sessions.status({ directory }, { timeoutMs: 5000 });
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      throw new Error('OpenCode session status returned an invalid payload');
    }
    return statuses;
  },
  // Cursor sessions run inside this server and survive an OpenCode restart.
  isSessionLiveElsewhere: (sessionId) => ['busy', 'retry'].includes(cursorSdkRuntime.getSessionStatus?.()?.[sessionId]?.type),
  settleSession: ({ sessionId, directory }) => {
    turnTimingRuntime.recordRuntimeInterrupted({ sessionID: sessionId });
    emitSyntheticOpenCodeEvent({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } }, { directory });
  },
  recordDiagnostic: (summary) => harnessRuntime.record({ type: 'lifecycle', event: 'opencode_restart_reconciled', payload: summary }),
});

const openCodeLifecycleRuntime = createOpenCodeLifecycleRuntime({
  getManagedOAuthEnvironment: () => openAiOAuthBridge.environment(),
  state: openCodeLifecycleState,
  env: {
    ENV_CONFIGURED_OPENCODE_PORT,
    ENV_CONFIGURED_OPENCODE_HOST,
    ENV_EFFECTIVE_PORT,
    ENV_CONFIGURED_OPENCODE_HOSTNAME,
    ENV_SKIP_OPENCODE_START,
  },
  syncToHmrState,
  syncFromHmrState,
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  waitForReady,
  normalizeApiPrefix,
  ensureLocalOpenCodeServerPassword,
  setOpenCodePort,
  setDetectedOpenCodeApiPrefix,
  setupProxy: (...args) => setupProxy(...args),
  ensureOpenCodeApiPrefix,
  buildAugmentedPath,
  buildManagedOpenCodePath,
  getManagedOpenCodeShellEnvSnapshot: getLoginShellEnvSnapshot,
  getNativeRuntime: () => nativeRuntime,
  getRuntimeBundle: () => selectedRuntimeBundle ? { descriptor: selectedRuntimeBundle.descriptor, verify: verifySelectedRuntimeBundle } : null,
  getActiveSessionCount,
  syncPackagedAgents: (options) => syncPackagedAgents({
    ...options,
    packagedAgentDirectory: path.join(defaultConfigRoot, 'agents'),
  }),
  syncRuntimeAgentOverlays: (options) => syncRuntimeAgentOverlays({
    ...options,
    dataDirectory: OPENCHAMBER_DATA_DIR,
    packagedAgentDirectory: path.join(defaultConfigRoot, 'agents'),
    packagedPluginDirectory: path.join(defaultConfigRoot, 'plugins'),
  }),
  readSettingsFromDisk,
  readAgentRuntimeSettings,
  sanitizeProjects,
  sanitizeHiddenSkills,
  discoverSkills,
  getManagedOrchestrationEnvironment: async () => {
    if (!managedOrchestrationRuntime) {
      throw new Error('Managed orchestration runtime was not prepared before OpenCode startup');
    }
    return { ...await managedOrchestrationRuntime.prepareBridge(),
      ...capturedExecutionEnvironment };
  },
  getManagedBrowserEnvironment: async () => (
    typeof managedBrowserEnvironmentProvider === 'function'
      ? await managedBrowserEnvironmentProvider()
      : {}
  ),
  pauseManagedBrowserLeases: async (reason) => (
    browserLeaseRuntime && typeof browserLeaseRuntime.pauseForReset === 'function'
      ? await browserLeaseRuntime.pauseForReset(reason)
      : null
  ),
  resumeManagedBrowserLeases: async (handle) => (
    browserLeaseRuntime && typeof browserLeaseRuntime.resumeAfterReset === 'function'
      ? await browserLeaseRuntime.resumeAfterReset(handle)
      : false
  ),
  onOpenCodeRestarted: ({ restartStartedAt } = {}) => {
    // Reads session states before the activity reset below clears phases.
    void bundleWork.run(() => runtimeRestartReconciler.reconcile({ restartStartedAt })).catch((error) => {
      console.warn(`[OpenCode] Restart reconciliation failed: ${error?.message || error}`);
    });
    sessionRuntime.resetAllSessionActivityToIdle();
    if (!bundleWork.isHeld()) void projectPrewarmRuntime?.run('opencode-restart');
  },
  onManagedProcessExit: ({ pid, code, signal, uptimeMs, expected, stderrTail }) => {
    harnessRuntime.record({ type: 'lifecycle', event: 'opencode_process_exit',
      payload: { pid, code, signal, uptimeMs, expected, stderrTail } });
    if (!expected) {
      console.error(`[OpenCode] Managed server exited unexpectedly (pid ${pid}, ${signal ? `signal ${signal}` : `code ${code}`}, uptime ${uptimeMs}ms)`,
        harnessRuntime.sanitizer?.sanitizeText?.(stderrTail) ?? '');
    }
  },
  onStartupStatus: (text) => onOpenCodeStartupStatus?.(text),
  beforeManagedSpawn: runOpenCodeDbMaintenanceBeforeSpawn,
  assertExecutionReady: executionReadiness.assertReady,
});

const restartOpenCode = (...args) => bundleWork.run(() => openCodeLifecycleRuntime.restartOpenCode(...args));
const ensureNativeDirectory=async directory=>{
  const locations=await nativeBundle.prepareLocations();
  if(!locations.some(location=>location.directory===directory))throw Object.assign(new Error('native_project_directory_unregistered'),{code:'native_project_directory_unregistered',statusCode:403});
  if(nativeRuntime?.isReady()&&nativeRuntime.getConfigurationSnapshot()?.locations.some(location=>location.directory===directory))return;
  if(await getAuthoritativeActiveSessionCount()>0)throw Object.assign(new Error('Native project preparation requires idle sessions'),{code:'config_runtime_busy',statusCode:409});
  await restartOpenCode();
  if(!nativeRuntime?.isReady()||!nativeRuntime.getConfigurationSnapshot()?.locations.some(location=>location.directory===directory))throw Object.assign(new Error('native_runtime_not_ready'),{code:'native_runtime_not_ready',statusCode:503});
};
const getAgentRuntimeApplicationState = () => openCodeLifecycleRuntime.getAgentRuntimeApplicationState();
const waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const waitForAgentPresence = (...args) => openCodeLifecycleRuntime.waitForAgentPresence(...args);
const commandDeadlineRuntime = createWebCommandDeadlineRuntime({
  openCodeClient,
  store: harnessRuntime.commandDeadlineStore,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl: fetch,
  publishEvent: emitSyntheticOpenCodeEvent,
  restartOpenCode,
  isExternalOpenCode: () => (
    isExternalOpenCode || ENV_SKIP_OPENCODE_START || Boolean(ENV_CONFIGURED_OPENCODE_HOST)
  ),
  recordIncident: (incident) => harnessRuntime.record({
    type: 'lifecycle',
    event: incident.type,
    sessionID: incident.sessionID,
    directory: incident.directory,
    messageID: incident.messageID,
    callID: incident.callID,
    payload: incident,
  }),
  sanitizeError: (error) => harnessRuntime.sanitizer.sanitizeText(error),
});
harnessRuntime.setCommandDeadlineRuntime(commandDeadlineRuntime);
const primaryRecoveryRuntime = createWebPrimaryRecoveryRuntime({
  openCodeClient,
  ...(nativeBundle?{isNativeFallbackError:error=>nativeBundle.reviewedConfiguration?.isReviewedSlimFailoverError(error)===true,
    dispatchNativeRecovery:(record,prompt)=>nativeRuntime.dispatchNativeRecovery(record,prompt)}:{}),
  dataDirectory: OPENCHAMBER_DATA_DIR,
  executionOutcomes: (input) => sessionExecutionHost.runtime.executionOutcomes(input),
  buildOpenCodeUrl: (pathname) => buildOpenCodeUrl(pathname, ''),
  getOpenCodeAuthHeaders,
  isManaged: () => !(isExternalOpenCode || ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST),
  getManagedRuntime: () => managedOrchestrationRuntime,
  getMultiUserRuntime: () => multiUserRuntime,
  publishEvent: emitSyntheticOpenCodeEvent,
  recordIncident: (incident) => harnessRuntime.record({ type: 'lifecycle', event: incident.event,
    sessionID: incident.sessionID, messageID: incident.messageID, payload: incident }),
  resolveProviderRequest: (input) => nativeProviderTiming.resolve(input),
});
harnessRuntime.setPrimaryRecoveryRuntime(primaryRecoveryRuntime);
// Any accepted abort settles the running turn as aborted in the journal. Only an
// explicit user Stop (or an unattributed client) also stops a managed child's
// executor from continuing or recovering it; automatic UI aborts do not.
const OPERATOR_STOP_SOURCES = new Set(['stop_button', 'double_escape', 'status_row', 'session_removal', 'unknown']);
harnessRuntime.setControlObserver(({ action, sessionID, source, res }) => {
  if (action !== 'abort') return;
  turnTimingRuntime.recordAbortRequested({ sessionID });
  const operatorStop = OPERATOR_STOP_SOURCES.has(source)
    ? managedOrchestrationRuntime?.recordOperatorAbort?.({ sessionId: sessionID, requestedAt: Date.now() }) ?? null
    : null;
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    turnTimingRuntime.withdrawAbortRequest({ sessionID });
    if (operatorStop) managedOrchestrationRuntime?.withdrawOperatorAbort?.(operatorStop);
  });
});
const harnessFingerprintReader = createHarnessRunFingerprintReader({
  openCodeClient,
  getDuplicateProviderRoute: createDuplicateProviderRouteResolver({ openAiUsesOAuth: () => openAiOAuthCoordinator.usesOAuth() }),
  getRuntimeBinary: () => useWslForOpencode || executionReadiness.state === 'required_unavailable' ? null : capturedExecutions
    ? capturedExecutionEnvironment.DEVRYAN_OPENCODE_ARTIFACT : resolvedOpencodeBinary,
  isManaged: () => !(isExternalOpenCode || ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST),
  buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl: fetch,
  getAgentSource: (agent, directory) => getAgentSources(agent, directory).md,
  recordDiagnostic: (entry) => harnessRuntime.record(entry),
});
const harnessTaskContext = createHarnessTaskContextHost({
  openCodeClient,
  dataDirectory: OPENCHAMBER_DATA_DIR, buildOpenCodeUrl, getOpenCodeAuthHeaders,
  readPrimaryRecord: (sessionID) => primaryRecoveryRuntime.readRecord(sessionID),
  getManagedRuntime: () => managedOrchestrationRuntime,
  sanitizeText: (text) => harnessRuntime.sanitizer.sanitizeContextText(text),
  recordDiagnostic: (entry) => harnessRuntime.record(entry),
  compactionAnchorEnabled: process.env.DEVRYAN_COMPACTION_ANCHOR !== '0',
  // Multi-user plan references resolve only between sessions of one owner.
  sessionOwnerKey: async (sessionID) => (multiUserRuntime?.enabled
    ? (await multiUserRuntime.resolveSessionOwnerKey?.({ rootSessionId: sessionID })) ?? null : 'local'),
  isManaged: () => Boolean(multiUserRuntime?.enabled),
  resolveOwnedPlanContext: (input) => multiUserRuntime?.resolveSessionPlanContext?.(input),
  getRegisteredProjects: async () => sanitizeProjects((await readSettingsFromDiskMigrated())?.projects) ?? [],
  publishEvent: emitSyntheticOpenCodeEvent,
});
harnessRuntime.setTaskContextRuntime(harnessTaskContext);
const sessionChangeHost = createSessionChangeHost({
  openCodeClient,
  restoreOwned: input => sessionExecutionHost.coordinator.restoreFiles(input),
  dataDirectory: OPENCHAMBER_DATA_DIR,
  onDiagnostic: (event) => {
    harnessRuntime.record({ type: 'log', event: 'session_changes_capture', sessionID: event.sessionID, payload: event });
    if (event.code === 'exact_tool_receipt' && event.phase === 'receipt' && event.hasChanges) {
      return primaryRecoveryRuntime.observeProgress({ sessionID: event.sessionID, messageID: event.messageID,
        kind: 'artifact-changed', identity: event.callID });
    }
  },
  publishEvent: emitSyntheticOpenCodeEvent,
  buildOpenCodeUrl: (pathname) => buildOpenCodeUrl(pathname, ''),
  getOpenCodeAuthHeaders,
  reconcileExecutionReceipts: (input) => cursorSdkRuntime.reconcileSessionChanges(input),
});
harnessRuntime.setSessionChangeHost(sessionChangeHost);
const sessionExecutionHost = createSessionExecutionHost({ assertExecutionReady: executionReadiness.assertReady, dataDirectory: OPENCHAMBER_DATA_DIR, activityGate: sessionActivityGate,
  openCodeClient,
  getLauncher: () => nativeBundle?.artifacts.launcher ?? executionArtifacts().launcher, buildOpenCodeUrl, getOpenCodeAuthHeaders,
  ...(nativeBundle ? { nativeExecution: {
    conversation: createNativeRevertConversation({ openCodeClient, clientDeps: openCodeClientDeps,
      isReady: () => isOpenCodeReady, admissionOwner: {
        withRevertOperation: (input, action) => nativeRuntime.nativeOwner.withRevertOperation(input, action),
        releaseTransactionHolds: input => nativeRuntime.nativeOwner.releaseTransactionHolds(input),
        recoverTransactionHolds: input => nativeRuntime.nativeOwner.recoverTransactionHolds(input),
      } }),
    isReady: () => nativeRuntime?.isExecutionReady() === true, getWriterConfig: directory => nativeRuntime.configurationForDirectory(directory),
    locations: nativeBundle.locations, get helperRoots(){return nativeBundle.locations.map(location=>location.directory);},
    workerCommand: nativeBundle.artifacts.writer, workerArgs: [], workerEnvironment: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
    reviewedAst: nativeBundle.artifacts.reviewedAst,
    reviewedAstOrigin: (() => { const origin = nativeBundle.artifacts.manifest.inputs.reviewedPlugins.find(row => row.id === 'devryan.slim');
      return origin ? { kind: 'plugin', ...origin } : undefined; })(),
    reviewedBrowserOrigin: (() => { const origin = nativeBundle.artifacts.manifest.inputs.reviewedPlugins.find(row => row.id === 'devryan.browser');
      return origin ? { kind: 'plugin', ...origin } : undefined; })(),
    reviewedDocumentOrigin: (() => { const origin = nativeBundle.artifacts.manifest.inputs.reviewedPlugins.find(row => row.id === 'devryan.document-reader');
      return origin ? { kind: 'plugin', ...origin } : undefined; })(),
    reviewedImagegenOrigin:(()=>{const origin=nativeBundle.artifacts.manifest.inputs.reviewedPlugins.find(row=>row.id==='opencode-gpt-imagegen');
      return origin?{kind:'plugin',...origin}:undefined;})(),
    getReviewedBrowser: () => nativeRuntime.getReviewedBrowser(),
    captureContextAssets: input => nativeRuntime.captureContextAssets(input),
    browserOperation: (invocation, event, context) => nativeRuntime.browserOperation(invocation, event, context),
    imageGeneration:(invocation,args,context)=>nativeRuntime.imageGeneration(invocation,args,context),
    cursor:{persist:input=>nativeRuntime.persistCursorRecord(input),withExecution:(input,action)=>nativeRuntime.withCursorExecution(input,action)},
    workerBrowsers: false, recheckPermit: input => nativeRuntime.nativeOwner.recheckExecution(input),
    stopSessions: input => nativeRuntime.stopSessions(input),
  } } : {}),
  recordReceipt: (input) => sessionChangeHost.recordReceipt(input),
  // Uncaptured change evidence lets Revert adopt conversations that ran while
  // the companion was unavailable (compare-and-swap, never overwriting).
  legacyChanges: { history: (input) => sessionChangeHost.legacyHistory(input), blob: (input) => sessionChangeHost.legacyBlob(input) },
  stopCursor: (input) => cursorSdkRuntime.abortAndWait(input.sessionID),
  // QA baselines set this to 0 so every dispatch's phase summary is journaled.
  admissionSummaryMinMs: /^\d{1,6}$/.test(process.env.DEVRYAN_EXECUTION_SUMMARY_MIN_MS ?? '')
    ? Number(process.env.DEVRYAN_EXECUTION_SUMMARY_MIN_MS) : undefined,
  onDiagnostic: (event) => harnessRuntime.recordSessionExecution(event),
  onLockTiming: (timing) => turnTimingRuntime.recordLedgerLock({ sessionId: timing.sessionID, operation: timing.operation,
    waitMs: timing.waitMs, holdMs: timing.holdMs, failed: timing.failed }),
});
observeCommandDeadline = (payload) => commandDeadlineRuntime.observe(payload);
if (selectedRuntimeBundle && (ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST)) {
  throw new Error('Selected runtime bundles require their owned controller');
}
if (nativeBundle) {
  nativeRuntime = createNativeRuntimeOwner({ bundle: nativeBundle, openCodeClient, admission: openCodeAdmission,
    getRequestPrincipal,
    clientDependencies: openCodeClientDeps,
    getManagedBrowserEnvironment: async () => managedBrowserEnvironmentProvider?.(),
    getBrowserLeaseRuntime: () => browserLeaseRuntime,
    getWebBaseURL: () => { const address=server?.address();if(!address||typeof address==='string')throw new Error('native_interview_web_owner_required');return `http://127.0.0.1:${address.port}`; },
    emitIntegrationEvent: event => broadcastGlobalUiEvent({type:'openchamber:integration',properties:{...event,eventID:crypto.randomUUID()}},{directory:event.directory}),
    cursorRuntime:cursorSdkRuntime,
    providerEnvironment:{},
    executionHost: sessionExecutionHost, primaryRuntime: primaryRecoveryRuntime, taskContext: harnessTaskContext,
    captureCommandPromptAdmission: async ({ sessionID, directory }) => {
      const principal = getRequestPrincipal();
      if (!principal || !['managed', 'local-admin'].includes(principal.scope)
        || (principal.scope === 'managed' && !/^[a-f0-9]{64}$/.test(principal.sessionTokenHash ?? ''))) {
        throw new Error('native_command_principal_required');
      }
      const owner = principal.scope === 'managed' ? principal.sessionTokenHash : null;
      const assertReceipt = receipt => {
        if (receipt.sessionID !== sessionID || receipt.directory !== directory) throw new Error('native_command_receipt_mismatch');
      };
      return {
        admit: (receipt, authorizeWrite) => { assertReceipt(receipt); return primaryRecoveryRuntime.admitNativePrompt(receipt, { owner, sessionID, authorizeWrite }); },
        uncertain: receipt => { assertReceipt(receipt); return primaryRecoveryRuntime.markNativePromptUncertain(receipt); },
      };
    },
    withCredentialMutationQueue: action => openAiOAuthCoordinator.withAuthMutation(action),
    recordDiagnostic: entry => harnessRuntime.record(entry),
    // Turn timing (observer only): bridge RPCs and native provider marks.
    onBridgeTiming: timing => turnTimingRuntime.recordBridgeCall({ sessionId: timing.sessionID, method: timing.method,
      durationMs: timing.durationMs, statusCode: timing.statusCode, reused: timing.reused }),
    onNativeObservation: observation => nativeProviderTiming.observe(observation),
    onProviderTiming: timing => nativeProviderTiming.response(timing),
    getManagedRuntime: () => managedOrchestrationRuntime,
    authorization: createNativeAuthorization({ locations: nativeBundle.locations, manifest: nativeBundle.artifacts.manifest,
      getRequestPrincipal, getMultiUserRuntime: () => multiUserRuntime,
      captureLocalAuthorization: principal => tunnelAuthController.captureAuthorization(principal)
        ?? uiAuthController?.captureAuthorization?.(principal) }),
    onBound: child => {
      openCodeLifecycleState.openCodeProcess = child;
      openCodeLifecycleState.openCodeBaseUrl = child.url;
      openCodeLifecycleState.openCodePort = child.port;
      openCodeLifecycleState.openCodePaths = nativeBundle.descriptor.launch.global;
      openCodeWorkingDirectory = nativeBundle.locations[0].directory;
      syncToHmrState();
    },
    onExit: () => { isOpenCodeReady = false; syncToHmrState(); },
  });
  harnessRuntime.setNativeSessionIdleObserver(input => nativeRuntime.continueSessionTodos(input));
}
// A stalled event loop explains slow calls and late deadlines that nothing
// else in the journal would: record every stall of 2 s or more.
onHostStall((stall) => {
  if (stall.ms < 2_000) return;
  try { harnessRuntime.record({ type: 'lifecycle', event: 'host_stall', sessionID: null, payload: { ms: stall.ms, from: stall.from, to: stall.to } }); }
  catch { /* Observer only. */ }
});
const canForceConfigRestart = (principal) => (
  principal?.scope === 'local-admin' || principal?.role === 'admin'
);
const getCurrentCanForceConfigRestart = () => {
  const principal = getRequestPrincipal();
  if (principal) return canForceConfigRestart(principal);
  return multiUserRuntime?.enabled !== true;
};
const configApplyCoordinator = createConfigApplyCoordinator({
  getRuntimeMode: () => (
    isExternalOpenCode || ENV_SKIP_OPENCODE_START ? 'external' : 'managed'
  ),
  getActiveSessionCount,
  getAuthoritativeActiveSessionCount,
  applyChanges: (input) => bundleWork.run(() => openCodeLifecycleRuntime.applyOpenCodeConfigChanges(input)),
});
const markConfigChange = createConfigChangeMarker({
  coordinator: configApplyCoordinator,
  getCanForceRestart: getCurrentCanForceConfigRestart,
});
const auditForceConfigRestart = async (principal, { revision, activeSessionCount }) => {
  if (!multiUserRuntime?.enabled || typeof multiUserRuntime.audit !== 'function') return;
  await multiUserRuntime.audit(principal, 'config.force_restart_requested', {
    metadata: { revision, activeSessionCount },
  });
};
const startHealthMonitoring = () => openCodeLifecycleRuntime.startHealthMonitoring(HEALTH_CHECK_INTERVAL);
const triggerHealthCheck = () => openCodeLifecycleRuntime.triggerHealthCheck();
const scheduledTasksRuntime = createScheduledTasksRuntime({
  openCodeClient,
  projectConfigRuntime,
  listProjects: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []);
  },
  listManagedProjectIDs: () => multiUserRuntime?.listScheduledTaskProjectIDs?.() || [],
  resolveScheduledTaskAccess: (input) => (
    multiUserRuntime?.resolveScheduledTaskAccess?.(input) || Promise.resolve({ state: 'runnable' })
  ),
  emitProjectMetadataChanged: broadcastManagedProjectMetadataChanged,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  resolveTaskExecutionContext: (input) => multiUserRuntime.resolveScheduledTaskExecution?.(input),
  recordTaskSessionOwnership: (input) => multiUserRuntime.recordScheduledTaskSessionOwnership?.(input),
  emitTaskRunEvent: (event) => {
    for (const client of uiOpenChamberEventClients) {
      const response = client?.response ?? client;
      if (client?.principalId && !client.isAdmin && event.ownerUserId !== client.principalId) {
        continue;
      }
      try {
        writeSseEvent(response, {
          type: 'openchamber:scheduled-task-ran',
          properties: {
            projectId: event.projectID,
            taskId: event.taskID,
            ranAt: event.ranAt,
            status: event.status,
            ...(event.sessionID ? { sessionId: event.sessionID } : {}),
          },
        });
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
  },
  logger: console,
});

const ensureGlobalWatcherStarted = async () => {
  if (globalWatcherStartPromise) {
    return globalWatcherStartPromise;
  }

  globalWatcherStartPromise = openCodeWatcherRuntime.start().catch((error) => {
    globalWatcherStartPromise = null;
    throw error;
  });

  return globalWatcherStartPromise;
};
const bootstrapOpenCodeAtStartup = (...args) => bundleWork.run(async () => {
  await openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup(...args);
  if (isOpenCodeReady && openCodePort) await sessionExecutionHost.recover();
  if (
    managedOrchestrationRuntime
    && isOpenCodeReady
    && openCodePort
    && !(isExternalOpenCode || ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST)
  ) {
    try {
      await managedOrchestrationRuntime.initialize();
    } catch (error) {
      console.warn('[ManagedOrchestration] Failed to initialize after OpenCode startup:', error?.message || error);
    }
  }
  scheduleOpenCodeApiDetection();
  if (openCodeLifecycleState.openCodeProcess && !openCodeLifecycleState.isExternalOpenCode) {
    startHealthMonitoring();
  }
  void ensureGlobalWatcherStarted().catch((error) => {
    console.warn(`Global event watcher startup failed: ${error?.message || error}`);
  });
  void standardSessionTitleRuntime.cleanupStaleHelpers().catch((error) => {
    console.warn(`[SessionTitle] Startup helper cleanup failed: ${error?.message || error}`);
  });
  if (!bundleWork.isHeld()) void projectPrewarmRuntime?.run('startup');
});

const fetchAgentsSnapshot = (...args) => serverUtilsRuntime.fetchAgentsSnapshot(...args);
const fetchProvidersSnapshot = (...args) => serverUtilsRuntime.fetchProvidersSnapshot(...args);
const fetchBotModelCatalog = createBotModelCatalogLoader({
  fetchImpl: fetch,
  buildUrl: () => buildOpenCodeUrl('/config/providers', ''),
  getAuthHeaders: getOpenCodeAuthHeaders,
});
const setupProxy = (...args) => serverUtilsRuntime.setupProxy(...args);
const gracefulShutdownRuntime = createGracefulShutdownRuntime({
  process,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT,
  getExitOnShutdown: () => exitOnShutdown,
  getIsShuttingDown: () => isShuttingDown,
  setIsShuttingDown: (value) => {
    isShuttingDown = value;
  },
  syncToHmrState,
  openCodeWatcherRuntime,
  globalMessageStreamHub,
  sessionRuntime,
  getHealthCheckInterval: () => healthCheckInterval,
  clearHealthCheckInterval: (value) => clearInterval(value),
  getTerminalRuntime: () => terminalRuntime,
  setTerminalRuntime: (value) => {
    terminalRuntime = value;
  },
  getMessageStreamRuntime: () => messageStreamRuntime,
  setMessageStreamRuntime: (value) => {
    messageStreamRuntime = value;
  },
  getBotsRuntime: () => multiUserRuntime?.botsRuntime,
  getManagedOrchestrationRuntime: () => managedOrchestrationRuntime,
  getBrowserLeaseRuntime: () => browserLeaseRuntime,
  getCursorSdkRuntime: () => cursorSdkRuntime,
  getSessionExecutionHost: () => sessionExecutionHost,
  closeNativeRuntime: nativeBundle ? () => nativeRuntime.close() : undefined,
  getSessionTitleRuntime: () => standardSessionTitleRuntime,
  shouldSkipOpenCodeStop: () => ENV_SKIP_OPENCODE_START || isExternalOpenCode,
  getOpenCodePort: () => openCodePort,
  getOpenCodeProcess: () => openCodeProcess,
  setOpenCodeProcess: (value) => {
    openCodeProcess = value;
  },
  getServer: () => server,
  getUiAuthController: () => uiAuthController,
  setUiAuthController: (value) => {
    uiAuthController = value;
  },
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  tunnelAuthController,
  scheduledTasksRuntime,
  getHarnessRuntime: () => harnessRuntime,
});

const gracefulShutdown = (...args) => gracefulShutdownRuntime.gracefulShutdown(...args);

async function main(options = {}) {
  const bundleAdmission = createRuntimeBundleAdmissionGate();
  let agentRuntimeWarmup;
  const requestHostRestart = typeof options.onRestartHost === 'function' ? options.onRestartHost
    : process.env.DEVRYAN_SUPERVISED_RESTART === '1'
      ? async () => { await gracefulShutdown({ exitProcess: false }); process.exit(1); } : undefined;
  const runtimeBundleLifecycle = createRuntimeBundleLifecycle({ binding: selectedRuntimeBundle,
    retainCheckpoint: options.retainRuntimeBundleCheckpoint,
    getController: () => nativeRuntime.checkpointController(),
    closeAdmission: async () => {
      bundleAdmission.close();
      await options.onRuntimeBundleCheckpoint?.();
      configApplyCoordinator.dispose();
      await bundleWork.holdForCheckpoint();
      if (currentRestartPromise) await currentRestartPromise;
      await deferredOpenCodeStartupPromise;
      isOpenCodeReady = false;
      harnessRuntime.beginDrain();
      await nativeRuntime.closeAdmissionForCheckpoint();
    },
    assertAdmissionClosed: async () => { bundleAdmission.assertClosed(); await nativeRuntime.assertCheckpointAdmissionClosed(); },
    stopProducers: async () => {
      openCodeWatcherRuntime.stop();
      sessionRuntime.dispose();
      if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
      let scheduledFailure;
      try { scheduledTasksRuntime.holdForCheckpoint(); } catch (error) { scheduledFailure = error; }
      const prewarmDrain = projectPrewarmRuntime?.holdForCheckpoint();
      const warmupDrain = agentRuntimeWarmup?.holdForCheckpoint();
      const notificationDrain = notificationTriggerRuntime.holdForCheckpoint();
      const titleDrain = standardSessionTitleRuntime.dispose();
      const browserObservationDrain = browserObservationRuntime?.holdForCheckpoint();
      const browserLeaseDrain = browserLeaseRuntime?.holdForCheckpoint();
      await Promise.all([prewarmDrain, warmupDrain, notificationDrain, titleDrain, browserObservationDrain, browserLeaseDrain]);
      await multiUserRuntime?.botsRuntime?.checkpointBotRuns?.();
      await multiUserRuntime?.botsRuntime?.shutdown?.();
      await cursorSdkRuntime.dispose();
      await terminalRuntime?.shutdown(); terminalRuntime = null;
      await messageStreamRuntime?.close(); messageStreamRuntime = null;
      globalMessageStreamHub.stop();
      await managedOrchestrationRuntime?.shutdown();
      await openAiOAuthBridge.close();
      await tunnelService.stop();
      tunnelAuthController.suspendActiveTunnel?.();
      if (scheduledFailure) throw scheduledFailure;
      // Producers finish their admitted reads/migrations before their stores
      // close entrypoints. Holding these stores earlier breaks their tails.
      await settingsRuntime.holdForCheckpoint();
      await managedTunnelConfigRuntime.holdForCheckpoint();
    },
    beforeControllerStop: () => nativeRuntime.drainCredentialOwners(),
    executionHost: sessionExecutionHost,
    afterExit: () => nativeRuntime.close(),
    drainStores: async () => {
      await cursorSdkRuntime.dispose();
      if (scheduledTasksRuntime.getStatus().runningScheduledTasksCount) {
        throw Object.assign(new Error('bundle_scheduled_tasks_unsettled'), { code: 'bundle_scheduled_tasks_unsettled', status: 503 });
      }
      await Promise.all([...pendingSessionOwnership]);
      await Promise.all([...pendingSessionCleanup]);
      if (failedSessionCleanup) throw Object.assign(new Error('bundle_session_cleanup_unsettled'), { code: 'bundle_session_cleanup_unsettled' });
      const projection = activityProjection.stats();
      if (projection.active || projection.queued) throw Object.assign(new Error('bundle_activity_projection_unsettled'), { code: 'bundle_activity_projection_unsettled', status: 503 });
      await multiUserRuntime?.authController?.dispose();
      await harnessRuntime.drain();
      bundleAdmission.assertClosed();
    },
    requestRecomposition: requestHostRestart,
  });
  const deferOpenCodeStartup = options.deferOpenCodeStartup === true;
  let deferredOpenCodeStartupComplete = !deferOpenCodeStartup;
  let deferredOpenCodeStartupPromise = null;
  const resumeDeferredOpenCodeStartup = () => {
    if (deferredOpenCodeStartupComplete) return Promise.resolve({ state: 'ready' });
    if (deferredOpenCodeStartupPromise) return deferredOpenCodeStartupPromise;
    deferredOpenCodeStartupPromise = bootstrapOpenCodeAtStartup()
      .then(() => {
        deferredOpenCodeStartupComplete = true;
        return { state: 'ready' };
      })
      .finally(() => {
        deferredOpenCodeStartupPromise = null;
      });
    return deferredOpenCodeStartupPromise;
  };
  managedBrowserEnvironmentProvider = typeof options.getManagedBrowserEnvironment === 'function'
    ? options.getManagedBrowserEnvironment
    : null;
  botEncryptionKeyProvider = typeof options.getBotEncryptionKey === 'function'
    ? options.getBotEncryptionKey
    : null;
  botEncryptionKeyInstaller = typeof options.replaceBotEncryptionKey === 'function'
    ? options.replaceBotEncryptionKey
    : null;
  botRuntimeStatusProvider = typeof options.getBotRuntimeStatus === 'function'
    ? options.getBotRuntimeStatus
    : null;
  botRuntimeControlProvider = [
    options.ensureBotReasoningRuntime,
    options.ensureBotComputerRuntime,
    options.inspectBotRuntimeResource,
    options.stopBotRuntimeResource,
    options.resetBotRuntimeResource,
  ].every((callback) => typeof callback === 'function')
    ? Object.freeze({
        ensureReasoning: options.ensureBotReasoningRuntime,
      ensureComputer: options.ensureBotComputerRuntime,
      probeComputerIsolation: typeof options.probeBotComputerIsolation === 'function'
        ? options.probeBotComputerIsolation
        : null,
        inspect: options.inspectBotRuntimeResource,
        stop: options.stopBotRuntimeResource,
      reset: options.resetBotRuntimeResource,
      writeWorkspace: typeof options.writeBotWorkspaceFile === 'function'
        ? options.writeBotWorkspaceFile
        : null,
      importSharedFile: typeof options.importBotSharedFile === 'function'
        ? options.importBotSharedFile
        : null,
      listWorkspace: typeof options.listBotWorkspaceFiles === 'function'
        ? options.listBotWorkspaceFiles
        : null,
      listFilesystem: typeof options.listBotContainerFiles === 'function'
        ? options.listBotContainerFiles
        : null,
      exportWorkspaceImage: typeof options.exportBotWorkspaceImage === 'function'
        ? options.exportBotWorkspaceImage
        : null,
      })
    : null;
  botRuntimeIndexerProvider = typeof options.requestBotIndexer === 'function'
    ? options.requestBotIndexer
    : null;
  // The local Bot catalog is owned by the Electron runtime manager. Only a
  // loopback URL and short-lived service token cross this in-process boundary.
  const catalogMaintenance = options.botCatalogMaintenance;
  botCatalogProvider = typeof options.getBotCatalogContext === 'function'
    && typeof options.ensureBotCatalog === 'function'
    ? Object.freeze({
        getContext: options.getBotCatalogContext,
        ensure: options.ensureBotCatalog,
        maintenance: catalogMaintenance && typeof catalogMaintenance === 'object'
          ? Object.freeze({ ...catalogMaintenance })
          : null,
      })
    : null;
  botAgentRequestProvider = typeof options.requestBotAgentEndpoint === 'function'
    ? options.requestBotAgentEndpoint
    : null;
  botBrowserProfilesProvider = [
    options.exportBotBrowserProfiles,
    options.inspectBotBrowserProfiles,
    options.restoreBotBrowserProfiles,
    options.deleteBotBrowserProfiles,
  ].every((callback) => typeof callback === 'function')
    ? Object.freeze({
        exportForBot: options.exportBotBrowserProfiles,
        inspectRestoreForBot: options.inspectBotBrowserProfiles,
        restoreForBot: options.restoreBotBrowserProfiles,
        deleteForBot: options.deleteBotBrowserProfiles,
      })
    : null;
  const harnessInitialization = harnessRuntime.initialize();
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
  const effectiveBindHost = host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');
  const configuredUiPassword = typeof options.uiPassword === 'string'
    ? options.uiPassword
    : (typeof process.env.OPENCHAMBER_UI_PASSWORD === 'string' ? process.env.OPENCHAMBER_UI_PASSWORD : null);
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !(typeof configuredUiPassword === 'string' && configuredUiPassword.trim().length > 0)
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  const tryCfTunnel = options.tryCfTunnel === true;
  const shouldUseCanonicalTunnelConfig = typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string';
  let startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
        originPort: options.tunnelOriginPort,
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
        }
      : null);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : null;
  if (typeof options.exitOnShutdown === 'boolean') {
    exitOnShutdown = options.exitOnShutdown;
  }
  if (typeof options.onDesktopNotification === 'function') {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  if (typeof options.onOpenCodeStartupStatus === 'function') {
    onOpenCodeStartupStatus = options.onOpenCodeStartupStatus;
  }
  notificationTriggerRuntime.setGetIsWindowFocused(
    typeof options.getIsWindowFocused === 'function' ? options.getIsWindowFocused : null
  );

  console.log(`Starting OpenChamber on port ${port === 0 ? 'auto' : port}`);

  const startupStartedAt = Date.now();
  const reportStartupPhase = (phase, text) => {
    onOpenCodeStartupStatus?.(text);
    console.log(`[startup] phase=${phase} elapsedMs=${Date.now() - startupStartedAt}`);
  };
  reportStartupPhase('services', 'Starting local services…');
  const sayTTSCapabilityPromise = detectSayTtsCapability(process);

  // Startup model validation is best-effort and runs in background.
  void validateZenModelAtStartup();

  const app = express();
  app.use(bundleAdmission.middleware);
  const serverStartedAt = new Date().toISOString();
  const runtimeInstanceId = crypto.randomUUID();
  app.set('trust proxy', true);
  registerIndexingPolicy(app);
  app.use(dynamicNoStoreMiddleware);
  app.use(compression({
    filter: (req, res) => {
      if (shouldSkipCompression(req, res)) return false;
      return compression.filter(req, res);
    },
    threshold: 1024,
  }));
  expressApp = app;
  server = http.createServer(app);

  reportStartupPhase('identity', 'Loading local access policy…');
  const multiUserRuntimePromise = createMultiUserRuntime({
    oauthCoordinator: openAiOAuthCoordinator,
    dataDirectory: OPENCHAMBER_DATA_DIR,
    fetchImpl: fetch,
    logger: console,
    readManagedTunnelConfig: readManagedRemoteTunnelConfigFromDisk,
    onManagedProjectMetadataChanged: broadcastManagedProjectMetadataChanged,
    onManagedSessionOwnershipCommitted: broadcastManagedSessionOwnershipCommitted,
    onScheduledTaskAccessChanged: async (input) => {
      if (input?.revoked === true) {
        await scheduledTasksRuntime.removeTasksForRevokedAccess(input);
        return;
      }
      if (typeof input?.projectID === 'string' && input.projectID.trim()) {
        await scheduledTasksRuntime.syncProject(input.projectID.trim());
        return;
      }
      await scheduledTasksRuntime.refreshStatus();
    },
    botHost: {
      owner: botRuntimeStatusProvider ? 'electron' : 'unsupported',
      getStatus: botRuntimeStatusProvider,
      ensureReasoning: botRuntimeControlProvider?.ensureReasoning,
      ensureComputer: botRuntimeControlProvider?.ensureComputer,
      probeComputerIsolation: botRuntimeControlProvider?.probeComputerIsolation,
      inspect: botRuntimeControlProvider?.inspect,
      stop: botRuntimeControlProvider?.stop,
      reset: botRuntimeControlProvider?.reset,
      writeWorkspace: botRuntimeControlProvider?.writeWorkspace,
      importSharedFile: botRuntimeControlProvider?.importSharedFile,
      listWorkspace: botRuntimeControlProvider?.listWorkspace,
      listFilesystem: botRuntimeControlProvider?.listFilesystem,
      exportWorkspaceImage: botRuntimeControlProvider?.exportWorkspaceImage,
      browserProfiles: botBrowserProfilesProvider,
      indexerRequest: botRuntimeIndexerProvider,
      agentRequest: botAgentRequestProvider,
      getModelCatalog: fetchBotModelCatalog,
      catalog: botCatalogProvider,
    },
    encryption: {
      getKey: botEncryptionKeyProvider,
      installKey: botEncryptionKeyInstaller,
    },
    recordDiagnostic: (entry) => harnessRuntime.record(entry),
    botsExecutionEnabled: options.productionBotsExecutionDisabled !== true,
  });
  const [nextMultiUserRuntime, sayTTSCapability] = await Promise.all([
    multiUserRuntimePromise,
    sayTTSCapabilityPromise,
  ]);
  multiUserRuntime = nextMultiUserRuntime;
  await tunnelAuthController.initialize({
    connection: multiUserRuntime.connection,
    passwordProtected: typeof configuredUiPassword === 'string' && configuredUiPassword.trim().length > 0,
    validateBots: (principal, botIds) => multiUserRuntime.botsRuntime.validateTunnelBotSelection(principal, botIds),
  });
  if (!startupTunnelRequest) {
    const resumeProfile = tunnelAuthController.getResumeProfile();
    if (resumeProfile) {
      const savedProfiles = await readManagedRemoteTunnelConfigFromDisk();
      const saved = savedProfiles.tunnels.find((profile) => profile.hostname === resumeProfile.hostname);
      if (saved) startupTunnelRequest = normalizeTunnelStartRequest({ provider: TUNNEL_PROVIDER_CLOUDFLARE,
        mode: TUNNEL_MODE_MANAGED_REMOTE, hostname: saved.hostname, token: saved.token, originPort: saved.originPort });
    }
  }
  registerLocalOwnerBootstrap(app, { dataDirectory: OPENCHAMBER_DATA_DIR, connection: multiUserRuntime.connection });
  registerTunnelAccessBoundary(app, server, { controller: tunnelAuthController, connection: multiUserRuntime.connection, runtimeInstanceId,
    getRuntimeReady: () => isOpenCodeReady,
    authenticateOwner: async (req, res) => {
      const owner = multiUserRuntime.connection.authenticateLocalOwner(req);
      if (owner) return owner;
      const principal = await multiUserRuntime.resolvePrincipal?.(req, res);
      if (principal?.role !== 'admin' || principal.scope !== 'managed' || principal.offlineGrace) return null;
      await multiUserRuntime.connection.rememberOwner(principal, res);
      return multiUserRuntime.connection.ownerPrincipal();
    },
  });
  const getConnectionActiveRequests = attachSupabaseConnectionBoundary(app, server, multiUserRuntime.connection, {
    allowRemoteRequest: hasTunnelBoundaryAuthorization,
  });
  if (multiUserRuntime.enabled) {
    console.log('Supabase multi-user identity and policy enforcement enabled');
  }
  pushRuntime.setSessionVisibilityFilter((tokenHash, sessionId) => (
    multiUserRuntime.canSessionTokenHashAccess(tokenHash, sessionId)
  ));

  browserLeaseRuntime = createBrowserLeaseRuntime({
    openCodeClient,
    getDiscoveryToken: typeof options.getBrowserCdpDiscoveryToken === 'function'
      ? options.getBrowserCdpDiscoveryToken
      : null,
    createBrowserLease: typeof options.createBrowserLease === 'function'
      ? options.createBrowserLease
      : null,
    touchBrowserLease: typeof options.touchBrowserLease === 'function'
      ? options.touchBrowserLease
      : null,
    releaseBrowserLease: typeof options.releaseBrowserLease === 'function'
      ? options.releaseBrowserLease
      : null,
    getBrowserLeaseAvailability: [
      options.getBrowserLeaseAvailability,
      options.getBrowserCdpBridgeStatus,
    ].find((candidate) => typeof candidate === 'function') ?? null,
    resolveBrowserLeaseContext: multiUserRuntime.resolveBrowserLeaseContext,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onObservationChanged: (event) => browserObservationRuntime?.handleLeaseChanged(event),
  });
  browserObservationRuntime = createBrowserObservationRuntime({
    getLeaseRecords: () => browserLeaseRuntime.getSnapshot(),
    ownsSession: (principal, sessionId) => multiUserRuntime.ownsSession?.(principal, sessionId) ?? false,
    getHostLeaseMetadata: typeof options.getBrowserLeaseObservationSnapshot === 'function'
      ? options.getBrowserLeaseObservationSnapshot
      : null,
    openHostLeaseStream: typeof options.openBrowserLeaseObservationStream === 'function'
      ? options.openBrowserLeaseObservationStream
      : null,
    onPrincipalChanged: broadcastBrowserAgentLeasesChanged,
    audit: (principal, action, context) => multiUserRuntime.audit?.(principal, action, context) ?? Promise.resolve(null),
  });
  const browserCdpDiscoveryRuntime = createBrowserCdpDiscoveryRuntime({
    getBridgeStatus: typeof options.getBrowserCdpBridgeStatus === 'function'
      ? options.getBrowserCdpBridgeStatus
      : null,
    getDiscoveryToken: typeof options.getBrowserCdpDiscoveryToken === 'function'
      ? options.getBrowserCdpDiscoveryToken
      : null,
  });

  const uiPassword = typeof options.uiPassword === 'string' ? options.uiPassword : null;
  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    process,
    openchamberVersion: OPENCHAMBER_VERSION,
    runtimeName: process.env.OPENCHAMBER_RUNTIME || 'web',
    serverStartedAt,
    runtimeInstanceId,
    gracefulShutdown,
    getNativeRuntimeOwner: () => nativeRuntime,
    getHealthSnapshot: () => {
      return {
        openCodePort,
        openCodeGeneration,
        openCodeRuntimeIdentity: `${runtimeInstanceId}:${openCodeEpoch}`,
        openCodeVersion: openCodePort ? openCodeVersion : null,
        openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
        openCodeSecureConnection: isOpenCodeConnectionSecure(),
        openCodeAuthSource: openCodeAuthSource || null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: true,
        isOpenCodeReady,
        lastOpenCodeError,
        openCodeProfileNotices,
        openCodeProbe: openCodeLifecycleState.openCodeProbe ?? null,
        lastOpenCodeLaunchDiagnostics,
        executionRuntime: { state: executionReadiness.state, code: executionReadiness.diagnostic?.code ?? null },
        opencodeBinaryResolved: nativeBundle.artifacts.controller,
        opencodeBinarySource: 'verified-native-bundle',
        opencodeLaunchBinary: nativeBundle.artifacts.controller,
        opencodeLaunchArgs: [],
        opencodeLaunchWrapperType: null,
        opencodeViaWsl: false,
        opencodeWslBinary: resolvedWslBinary || null,
        opencodeWslPath: resolvedWslOpencodePath || null,
        opencodeWslDistro: resolvedWslDistro || null,
        nodeBinaryResolved: resolvedNodeBinary || null,
        bunBinaryResolved: resolvedBunBinary || null,
        desktopNotifyEnabled: ENV_DESKTOP_NOTIFY,
        planModeExperimentalEnabled: PLAN_MODE_EXPERIMENT_ENABLED,
        multiUserControlPlane: multiUserRuntime.getControlPlaneStatus?.() ?? {
          state: multiUserRuntime.enabled ? 'unknown' : 'disabled',
          lastErrorCode: null,
          lastSuccessAt: null,
        },
      };
    },
    verboseRequestLogs: OPENCHAMBER_VERBOSE_REQUEST_LOGS,
    uiPassword,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    normalizeTunnelSessionTtlMs,
    getRuntimeReady: () => Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
    resolveZenModel,
    sayTTSCapability,
    ensurePushInitialized,
    ensureGlobalWatcherStarted,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    writeSettingsToDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    updateUiVisibility,
    isUiVisible,
    getUiNotificationClients: () => uiNotificationClients,
    writeSseEvent,
    sessionRuntime,
    setPushInitialized,
    fs,
    os,
    path,
    server,
    __dirname,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL,
    fetchFreeZenModels,
    getCachedZenModels,
    setAutoAcceptSession,
    multiUserRuntime,
    registerPrivateCapabilityRoutes: (privateApp) => {
      browserCdpDiscoveryRuntime.attach(privateApp);
      browserLeaseRuntime.attach(privateApp);
      if (options.runtimeServiceController) {
        registerRuntimeServiceRoutes(privateApp, {
          controller: options.runtimeServiceController,
          onLocalOwnerBootstrap: async (res) => {
            if (!multiUserRuntime.connection.enabled) {
              await multiUserRuntime.connection.bootstrapLocalOwner();
              multiUserRuntime.connection.setOwnerCookie(res, await multiUserRuntime.connection.issueLocalOwnerSession());
            }
            // The Bot owner session is issued in every Supabase state.
            setBotOwnerCookie(res, await multiUserRuntime.botOwner?.issueSession?.());
          },
          server,
          onDesktopHostLease: options.onDesktopHostLease,
          onDesktopHostRelease: options.onDesktopHostRelease,
          botRuntimeControl: options.runtimeServiceBotRuntimeControl,
          onDisableRuntimeService: options.onDisableRuntimeService,
          onPrepareRuntimeServiceUpdate: options.onPrepareRuntimeServiceUpdate,
        });
      }
      registerSupabaseConnectionRoutes(privateApp, {
        runtime: multiUserRuntime,
        preserveLocalContext: async (principal) => {
          const settings = await readSettingsFromDiskMigrated();
          const projects = [...sanitizeProjects(settings.projects)];
          for (const entry of principal.assignments || []) {
            if (!entry.repositoryPath || projects.some((project) => project.path === entry.repositoryPath)) continue;
            projects.push({ id: entry.projectId, label: entry.label, path: entry.repositoryPath });
          }
          const personal = principal.settingsOverrides || {};
          const preserved = { ...settings, projects };
          for (const key of ['themeId', 'agentModelSelections', 'favoriteModels', 'hiddenModels', 'notificationTemplates']) {
            if (Object.hasOwn(personal, key)) preserved[key] = personal[key];
          }
          await writeSettingsToDisk(preserved);
        },
      });
    },
  });
  registerRuntimeBundleLifecycleRoutes(app, { lifecycle: runtimeBundleLifecycle,
    isAdministrator: () => canForceConfigRestart(getRequestPrincipal()) });
  uiAuthController = bootstrapResult.uiAuthController;
  // Must precede managed session routes, which intercept the generic proxy.
  app.get('/api/diagnostics/execution-runtime', (_req, res) => res.json({ state: executionReadiness.state, diagnostic: executionReadiness.diagnostic }));
  app.use(executionReadinessMiddleware(executionReadiness));
  app.use('/api/openchamber/interviews', async (req,res,next) => {
    if(!nativeRuntime)return next();
    const relative=req.url;req.url=req.originalUrl;
    try{if(!await nativeRuntime.handleInterviewRequest(req,res))next();}
    catch(error){if(!res.headersSent)res.status(error.statusCode??error.status??503).json({error:{code:typeof error.code==='string'?error.code:'native_interview_failed'}});else res.destroy();}
    finally{req.url=relative;}
  });
  app.use('/api/session', (req, res, next) => {
    if (isSessionCreateRequest(req)) {
      const trace = beginSessionCreationTrace(req, (entry) => harnessRuntime.record(entry));
      res.once('finish', () => trace.mark('response_finished'));
      res.once('close', () => { if (!res.writableFinished) trace.mark('client_disconnected'); });
    }
    next();
  });
  multiUserRuntime.registerRoutes(app, {
    openCodeClient,
    isSessionCreationRestarting: () => isRestartingOpenCode || !isOpenCodeReady || multiUserRuntime.connection?.status().restartPending,
    recordCreationTiming: (entry) => harnessRuntime.record(entry),
    readSettingsFromDiskMigrated,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    listConfigAgents,
    getConfigApplyMutationResponse: (principal) => {
      const applyStatus = configApplyCoordinator.getStatus({
        canForceRestart: canForceConfigRestart(principal),
      });
      return {
        requiresApply: applyStatus.pending,
        applyRevision: applyStatus.revision,
        applyScopes: applyStatus.scopes,
        applyStatus,
        requiresReload: false,
      };
    },
  });
  browserObservationRuntime.registerRoutes(app);
  app.use('/api/openchamber/session/:sessionID/changes', express.json({ limit: '16kb' }), async (req, res, next) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      const result = await sessionChangeHost.handleRequest(req.method, req.originalUrl, req.body, { signal: controller.signal });
      if (!result) return next();
      if (!res.destroyed) res.status(result.status).json(result.body);
    } finally { res.off('close', disconnected); }
  });
  // Controls are journaled before primary recovery: it answers a primary
  // session's abort locally, so a later journal hook would never see it.
  app.use('/api/session/:sessionID',
    express.json({ limit: '50mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    harnessRuntime.controlJournalMiddleware,
    primaryRecoveryRuntime.middleware);
  app.use(
    '/api/session/:sessionID/prompt_async',
    express.json({ limit: '50mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    harnessRuntime.promptAdmissionMiddleware(turnTimingRuntime),
  );
  registerDiagnosticsRoutes(app, {
    runtime: harnessRuntime,
    getEvidenceRecords: (scope) => evidenceRuntime.getRecords(scope),
    getCommandDeadlineRecoveryStatus: commandDeadlineRuntime.getStatus,
  });
  registerMemoryDebugRoutes(app, {
    getAppMetrics: typeof options.getAppMetrics === 'function' ? options.getAppMetrics : null,
  });
  registerEvidenceRoutes(app, { runtime: evidenceRuntime });
  registerOpenCodeDbMaintenanceRoutes(app, {
    maintenance: openCodeDbMaintenance,
    scheduler: openCodeDbCompactionScheduler,
    restartOpenCode: () => restartOpenCode(),
    isManagedRuntime: () => !(isExternalOpenCode || ENV_SKIP_OPENCODE_START || Boolean(ENV_CONFIGURED_OPENCODE_HOST)),
    readMaintenanceSettings: readOpenCodeDbMaintenanceSettings,
  });
  await harnessInitialization;

  const providerResetProbe = createMeridianProviderResetProbe({
    openCodeClient,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: fetch,
    isExternalOpenCode: () => (
      isExternalOpenCode || ENV_SKIP_OPENCODE_START || Boolean(ENV_CONFIGURED_OPENCODE_HOST)
    ),
  });
  const resolveManagedAgentExecutionForOwner = (params) => {
    if (typeof multiUserRuntime.resolveSessionAgentExecution === 'function') {
      return multiUserRuntime.resolveSessionAgentExecution(params);
    }
    const execution = resolveManagedAgentExecution({
      agents: listConfigAgents(params.directory), agentName: params.agent, settingsOverrides: {},
    });
    if (!execution) {
      throw Object.assign(new Error('Managed agent has no executable model'), {
        code: 'managed_agent_model_unavailable', statusCode: 409,
      });
    }
    return execution;
  };
  managedOrchestrationRuntime = createWebManagedOrchestrationRuntime({
    openCodeClient,
    onRequiredCheckReceipt: ({ task, receipt }) => {
      harnessRuntime.record({ type: 'lifecycle', event: 'required_check_observed', sessionID: task.rootSessionId,
        payload: { taskId: task.taskId, messageID: receipt.messageId, callID: receipt.callId, name: receipt.name, status: receipt.status, exitCode: receipt.exitCode, contentHash: receipt.contentHash } });
      if (receipt.status !== 'not-observed') {
        void primaryRecoveryRuntime.observeProgress({ sessionID: task.rootSessionId, taskCreatedAt: task.createdAt,
          kind: 'required-check', identity: `${task.taskId}:${receipt.name}:${receipt.callId}:${receipt.status}` });
      }
    },
    onBarrierChange: (state) => harnessRuntime.record({ type: 'lifecycle', event: 'managed_workspace_barrier',
      sessionID: state.rootSessionId, at: state.at, payload: { state: state.state, count: state.taskCount } }),
    onFirstAssistantActivity: (activity) => {
      harnessRuntime.record({
        type: 'lifecycle', event: 'managed_task.first_assistant_activity',
        sessionID: activity.childSessionId, assistantMessageID: activity.messageId,
        payload: activity,
      });
    },
    dataDirectory: OPENCHAMBER_DATA_DIR,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    cursorSdkRuntime:cursorPromptRuntime,
    // Spawn time of the managed OpenCode now serving; null for an external runtime.
    readRuntimeStartedAt: () => (
      isExternalOpenCode || ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST
        ? null : openCodeProcess?.startedAt ?? null
    ),
    registerExecutionChild: nativeBundle ? input => sessionExecutionHost.nativeManagedChild(input)
      : capturedExecutions ? (input) => sessionExecutionHost.plugin({ ...input, action: 'child' }) : undefined,
    nativeTaskDispatch: nativeBundle ? (input, action) => nativeRuntime.nativeOwner.withManagedTaskDispatch(input, action) : undefined,
    publishEvent: emitSyntheticOpenCodeEvent,
    isManagedOpenCode: () => !(
      isExternalOpenCode
      || ENV_SKIP_OPENCODE_START
      || ENV_CONFIGURED_OPENCODE_HOST
    ),
    getWorkAdmissionBlock: () => multiUserRuntime.connection?.status().restartPending
      ? { code: 'supabase_change_pending', error: 'DevRyan is waiting to restart' }
      : harnessRuntime.getPromptAdmissionBlock(),
    resolveAgentExecution: resolveManagedAgentExecutionForOwner,
    // Auto-resume hooks: managed sessions key breakers per owning user and use
    // the host-managed backup model; local sessions fall back to the packaged
    // agent config. Meridian answers when an Anthropic limit lifts.
    resolveOwnerKey: async (params) => (
      (await multiUserRuntime?.resolveSessionOwnerKey?.(params)) ?? 'local'
    ),
    resolveBackupExecution: async (params) => (
      (await multiUserRuntime?.resolveSessionAgentBackupExecution?.(params))
      ?? resolveLocalAgentBackupExecution({ directory: params.directory, agent: params.agent })
    ),
    resolveProviderReset: (params) => providerResetProbe.resolveProviderReset(params),
    harnessPolicies: { duplicateOutputs: resolveDuplicateOutputPolicy(process.env) },
    auxiliaryRpcHandlers: {
      primary_recovery: (params) => primaryRecoveryRuntime.plugin(params),
      harness_duplicate_qualification: (params) => harnessFingerprintReader.qualifyDuplicates(params),
      harness_run: (params) => harnessFingerprintReader.capture(params),
      harness_context_observation: (params) => harnessFingerprintReader.observeContext(params),
      harness_context: (params) => harnessTaskContext.handleRpc(params),
      harness_plan: (params) => harnessTaskContext.handlePlanRpc(params),
      session_changes: (params) => sessionChangeHost.plugin(params),
      session_execution: (params) => sessionExecutionHost.plugin(params),
      resolve_agent_execution: resolveManagedAgentExecutionForOwner,
    },
    authorizePrivateRpc: (request) => harnessTaskContext.authorizePrivateRpc(request),
    logger: console,
  });
  const retention = createSessionRetention({
    openCodeClient, getNativeRuntime:()=>nativeRuntime,
    gate: sessionActivityGate, readSettings: readSettingsFromDiskMigrated,
    buildOpenCodeUrl, getOpenCodeAuthHeaders,
    getControlToken: async () => (await managedOrchestrationRuntime.prepareBridge()).DEVRYAN_ORCHESTRATION_TOKEN,
    getDirectory: () => openCodeWorkingDirectory,
    isExclusive: () => capturedExecutions && sessionExecutionHost.retentionReady && isOpenCodeReady && !isRestartingOpenCode
      && !multiUserRuntime.enabled && !(isExternalOpenCode || ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST),
    protectedSessions: async () => {
      const snapshot = await managedOrchestrationRuntime.getSnapshot();
      if (!snapshot.available || snapshot.recoveryWarning) throw Object.assign(new Error('managed_ownership_unknown'), { code: 'managed_ownership_unknown' });
      return snapshot.tasks.flatMap((task) => [task.rootSessionId, task.childSessionId]).filter(Boolean);
    },
    checkLedger: async ({ directory, sessions }) => {
      if ((await sessionExecutionHost.runtime.activeLeases({ directory, sessions })).length
        || (await sessionExecutionHost.runtime.pendingTransactions({ directory })).length)
        throw Object.assign(new Error('captured_execution_active'), { code: 'captured_execution_active' });
      for (const sessionID of sessions) {
        const recovery = await primaryRecoveryRuntime.readRecord(sessionID);
        if (recovery && !['completed', 'cancelled', 'superseded'].includes(recovery.state))
          throw Object.assign(new Error('recovery_owned_session'), { code: 'recovery_owned_session' });
      }
    },
  });
  registerSessionRetentionRoutes(app, { retention, gate: sessionActivityGate });
  registerManagedOrchestrationRoutes(app, {
    runtime: managedOrchestrationRuntime,
    express,
  });

  const tunnelRuntimeContext = tunnelWiringRuntime.initialize(app, port, {
    runtimeInstanceId,
    fetchImpl: fetch,
  });
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;

  registerTurnTimingRoutes(app, turnTimingRuntime, {
    authorize: async (req, sessionId) => {
      const principal = req.principal ?? getRequestPrincipal();
      if (!principal || !canReadSettingsPage(principal, 'about')) return false;
      return !sessionId || await multiUserRuntime.ownsSession?.(principal, sessionId) === true;
    },
    onAcceptedMark: (input) => {
      const isToolInputStall = input?.mark === 'renderer_tool_input_stall_confirmed';
      const isInferenceStall = input?.mark === 'renderer_provider_inference_stall_confirmed';
      const isLongRunningTool = input?.mark === 'renderer_long_running_tool_confirmed';
      if (!isToolInputStall && !isInferenceStall && !isLongRunningTool) return;
      const rawStalledForMs = input?.metadata?.stalledForMs;
      const stalledForMs = typeof rawStalledForMs === 'number'
        && Number.isFinite(rawStalledForMs)
        && rawStalledForMs >= 0
        ? Math.trunc(rawStalledForMs)
        : null;
      const rawElapsedMs = input?.metadata?.elapsedMs;
      const elapsedMs = typeof rawElapsedMs === 'number'
        && Number.isFinite(rawElapsedMs)
        && rawElapsedMs >= 0
        ? Math.trunc(rawElapsedMs)
        : null;
      harnessRuntime.record({
        type: 'lifecycle',
        event: isLongRunningTool
          ? 'long_running_tool_confirmed'
          : isInferenceStall
            ? 'provider_inference_stall_confirmed'
            : 'provider_tool_input_stall_confirmed',
        sessionID: typeof input.sessionId === 'string' ? input.sessionId : null,
        directory: typeof input.directory === 'string' ? input.directory : null,
        assistantMessageID: typeof input.assistantMessageId === 'string'
          ? input.assistantMessageId
          : null,
        payload: {
          source: 'renderer_active_session_watchdog',
          ...(!isLongRunningTool && stalledForMs !== null ? { stalledForMs } : {}),
          ...(elapsedMs === null ? {} : { elapsedMs }),
          ...(isLongRunningTool && typeof input?.metadata?.tool === 'string'
            ? { tool: input.metadata.tool }
            : {}),
        },
      });
    },
  });
  agentRuntimeWarmup = createAgentRuntimeWarmup({
    openCodeClient,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: fetch,
    discoverSkills,
    readSkillFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
    cursorPrewarm: () => cursorSdkRuntime.prewarm(),
    getHiddenSkills: async () => {
      const settings = await readSettingsFromDisk();
      return sanitizeHiddenSkills(settings?.hiddenSkills);
    },
    resolveApprovedSkills,
    warmXaiToolCatalog: ({ directory, signal }) => xaiToolCatalogRuntime.refreshDirectory({ directory, signal }),
    ...(capturedExecutions ? { warmLedger: ({ directory }) => sessionExecutionHost.warmLedger({ directory }) } : {}),
  });
  projectPrewarmRuntime = createProjectPrewarmRuntime({
    warm: (warmupOptions) => agentRuntimeWarmup.warm(warmupOptions),
    listProjectDirectories: async () => {
      const settings = await readSettingsFromDiskMigrated();
      const projects = sanitizeProjects(settings?.projects || []) || [];
      const activeProject = projects.find((project) => project.id === settings?.activeProjectId);
      const candidates = [
        settings?.lastDirectory,
        activeProject?.path,
        ...projects.map((project) => project.path),
      ];
      const directories = [];
      const seen = new Set();

      for (const candidate of candidates) {
        const normalized = normalizeDirectoryPath(candidate);
        if (typeof normalized !== 'string' || !normalized.trim()) continue;

        const directory = path.resolve(normalized.trim());
        if (seen.has(directory)) continue;

        try {
          const stats = await fsPromises.stat(directory);
          if (!stats.isDirectory()) continue;
        } catch {
          continue;
        }

        seen.add(directory);
        directories.push(directory);
      }

      return directories;
    },
    waitForOpenCodeReady,
    shouldAbort: () => isShuttingDown,
    logger: console,
  });
  registerAgentRuntimeWarmupRoute(app, agentRuntimeWarmup);
  registerHarnessPreflightRoute(app, createHarnessPreflight({
    openCodeClient,
    getAgents: ({ directory } = {}) => listConfigAgents(directory).map((agent) => ({
      ...agent,
      frontmatter: agent,
      path: getAgentSources(agent.name, directory).md.path,
    })),
    getSkills: ({ directory } = {}) => collectHarnessSkillEntries(directory),
    getHiddenSkills: async () => {
      const settings = await readSettingsFromDisk();
      return sanitizeHiddenSkills(settings?.hiddenSkills);
    },
    getStaleOverrides: ({ directory } = {}) => (directory ? listStaleAgentModelOverrides(directory) : []),
    getConfigCredentialScan: ({ directory } = {}) => readConfigCredentialScan({ directory }),
    getLatestWarmup: () => agentRuntimeWarmup.getLatestResult(),
    getRunFingerprint: (context) => harnessFingerprintReader.read(context),
    getRuntimeMode: () => (isExternalOpenCode || ENV_SKIP_OPENCODE_START ? 'external' : 'managed'),
    getPackagedAgents: () => listPackagedAgents(),
    readSkillBody: (skill) => parseMdFile(skill.path).body,
    getClaudeRuntime: () => inspectClaudeRuntimeCompatibility(),
    recordDiagnostic: (entry) => harnessRuntime.record(entry),
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: fetch,
  }));

  await featureRoutesRuntime.registerRoutes(app, {
    openCodeClient,
    getNativeRuntimeOwner: () => nativeRuntime,
    isProviderAdministrator: () => canForceConfigRestart(getRequestPrincipal()),
    crypto,
    getLoginShellEnvSnapshot,
    fs,
    os,
    path,
    fsPromises,
    spawn,
    resolveGitBinaryForSpawn,
    createFsSearchRuntime: createFsSearchRuntimeFactory,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    projectIconStore,
    openchamberUserConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    validateDirectoryPath,
    readCustomThemesFromDisk,
    markConfigChange,
    configApplyCoordinator,
    canForceConfigRestart,
    retireLegacyCursorPlugin: () => retireLegacyCursorPlugin({
      configDirectory: userProfileProvisioning.configDirectory,
      userConfirmed: true,
    }),
    abortActiveSessionsForConfigRestart,
    auditForceConfigRestart,
    getOpenCodeResolutionSnapshot,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    sanitizeSkillCatalogs,
    sanitizeHiddenSkills,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    cursorSdkRuntime:cursorPromptRuntime,
    standardSessionTitleRuntime,
    getOpenCodePort: () => openCodePort,
    getOpenCodeWorkingDirectory: () => openCodeWorkingDirectory,
    ensureNativeDirectory,
    setOpenCodeWorkingDirectory: (directory) => {
      openCodeWorkingDirectory = directory;
      syncToHmrState();
    },
    restartOpenCode,
    waitForOpenCodeReady,
    isExternalOpenCode: () => isExternalOpenCode || ENV_SKIP_OPENCODE_START,
    getAgentRuntimeApplicationState,
    getPackagedAgentPrompts: () => openCodeLifecycleRuntime.getPackagedAgentPrompts(),
    restorePackagedAgentPrompt: (input) => openCodeLifecycleRuntime.restorePackagedAgentPrompt(input),
    buildAugmentedPath,
    projectConfigRuntime,
    scheduledTasksRuntime,
    getOpenChamberEventClients: () => uiOpenChamberEventClients,
    writeSseEvent,
    emitSyntheticOpenCodeEvent,
    resolveZenModel,
    xaiToolCatalogRuntime,
    resolveZenModelNonBlocking,
    generateHelperText: request => nativeRuntime.generateHelperText(request),
    cursorTextRuntime: cursorSdkRuntime,
    recordCommitTiming: (req, payload) => harnessRuntime.record(buildGitGenerationTimingRecord(req, payload)),
    resolveManagedProject: multiUserRuntime.resolveManagedProject?.bind(multiUserRuntime),
    ownsSession: multiUserRuntime.ownsSession?.bind(multiUserRuntime),
    resolveOwnedSessionPlanContext: multiUserRuntime.resolveCurrentOwnedSessionPlanContext?.bind(multiUserRuntime),
    readCanonicalPlanIdentity: (input) => harnessTaskContext.readCanonicalPlanIdentity(input),
    recordPlanDiagnostic: (entry) => harnessRuntime.record(entry),
  });

  const localInstanceStatusRuntime = createLocalInstanceStatusRuntime({ net, URL });
  const projectPreviewInstancesRuntime = createProjectPreviewInstancesRuntime({
    crypto,
    fs,
    path,
    getTerminalRuntime: () => terminalRuntime,
    resolveManagedProjectForDirectory: multiUserRuntime.resolveManagedProjectForDirectory?.bind(multiUserRuntime),
    probeUrl: async (url) => {
      const [result] = await localInstanceStatusRuntime.checkUrls([url]);
      return result;
    },
  });
  const previewProxyRuntime = createPreviewProxyRuntime({
    crypto,
    URL,
    createProxyMiddleware,
    responseInterceptor,
  });
  projectPreviewInstancesRuntime.setGrantRemovalHandler(({ id }) => {
    previewProxyRuntime.revokeGrantTargets(id);
  });
  projectPreviewInstancesRuntime.attach(app, {
    express,
    uiAuthController,
    isRequestOriginAllowed,
    canUseBrowser,
  });
  previewProxyRuntime.attach(app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    classifyRequestScope: (req) => tunnelAuthController.classifyRequestScope(req),
    previewInstancesRuntime: projectPreviewInstancesRuntime,
    canUseBrowser,
  });

  localInstanceStatusRuntime.attach(app, {
    express,
    uiAuthController,
    isRequestOriginAllowed,
    classifyRequestScope: (req) => classifyPreviewRequestScope(
      req,
      tunnelAuthController.classifyRequestScope(req),
    ),
    canUseBrowser,
  });
  server.once('close', () => {
    void openAiOAuthBridge.close().catch(() => undefined);
    browserObservationRuntime?.closeAll();
    projectPreviewInstancesRuntime.shutdown();
    previewProxyRuntime.shutdown();
    xaiToolCatalogRuntime.dispose();
  });

  reportStartupPhase('listener', 'Opening DevRyan…');
  const startupPipelineResult = await startupPipelineRuntime.run({
    openCodeClient,
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    globalEventHub: globalMessageStreamHub,
    messageStreamWsClients: uiNotificationWsClients,
    registerRetentionConnection: (req) => sessionActivityGate.connect(req),
    upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
    terminalHeartbeatIntervalMs: TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    terminalRebindWindowMs: TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    terminalMaxRebindsPerWindow: TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
    setupProxy,
    scheduleOpenCodeApiDetection,
    bootstrapOpenCodeAtStartup: deferOpenCodeStartup
      ? async () => undefined
      : bootstrapOpenCodeAtStartup,
    getRuntimeReady: () => Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
    triggerHealthCheck,
    staticRoutesRuntime,
    process,
    crypto,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDiskMigrated,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached: () => signalsAttached,
    setSignalsAttached: (value) => {
      signalsAttached = value;
    },
    syncToHmrState,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    host,
    port,
    startupTunnelRequest,
    onTunnelReady,
    tunnelRuntimeContext,
    attachSignals,
    multiUserRuntime,
    onTerminalSessionClosed: (event) => {
      projectPreviewInstancesRuntime.handleTerminalSessionClosed(event);
      if (event.reason === 'owner-revoked') {
        previewProxyRuntime.revokeOwnerTargets(event.ownerUserId);
      }
    },
  });
  terminalRuntime = startupPipelineResult.terminalRuntime;
  messageStreamRuntime = startupPipelineResult.messageStreamRuntime;

  try {
    await scheduledTasksRuntime.start();
  } catch (error) {
    console.warn('[ScheduledTasks] Failed to start runtime:', error?.message || error);
  }

  multiUserRuntime.connection?.configureDriver({
    pauseAdmissions: () => scheduledTasksRuntime.stop(),
    resumeAdmissions: async () => {
      await scheduledTasksRuntime.start();
      await multiUserRuntime.botsRuntime?.resumeAdmissions?.();
    },
    getBlockers: async () => {
      const blockers = [...(multiUserRuntime.botsRuntime?.getRestartBlockers?.() || [])];
      try { if (await getAuthoritativeActiveSessionCount()) blockers.push('active_chats'); }
      catch { blockers.push('chat_status_unavailable'); }
      if (getConnectionActiveRequests()) blockers.push('active_requests');
      const orchestration = managedOrchestrationRuntime?.getDiagnostics()?.scheduler;
      if (orchestration?.activeLaunchCount || orchestration?.activeHandoffCount || orchestration?.pendingAcknowledgementCount) blockers.push('managed_tasks');
      if (scheduledTasksRuntime.getStatus().runningScheduledTasksCount) blockers.push('scheduled_tasks');
      return blockers;
    },
    prepare: async () => { await multiUserRuntime.botsRuntime?.checkpointBotRuns?.(); },
    restart: typeof options.onRestartHost === 'function' ? options.onRestartHost
      : process.env.DEVRYAN_SUPERVISED_RESTART === '1'
        ? async () => { await gracefulShutdown({ exitProcess: false }); process.exit(1); } : undefined,
  });

  reportStartupPhase('ready', 'DevRyan is ready.');

  return {
    runtimeBundle: runtimeBundleLifecycle,
    issueLocalOwnerSession: async () => {
      if (multiUserRuntime.connection.enabled) return null;
      await multiUserRuntime.connection.bootstrapLocalOwner();
      return multiUserRuntime.connection.issueLocalOwnerSession();
    },
    // In-process only: the native shell installs the workstation owner's
    // Bot-scoped session into its own renderer.
    issueBotOwnerSession: async () => multiUserRuntime?.botOwner?.issueSession?.() ?? null,
    expressApp: app,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getOpenCodePort: () => getPublicRuntimePort(openCodePort, {
      startupSkipped: ENV_SKIP_OPENCODE_START,
      externallyManaged: isExternalOpenCode,
    }),
    getManagedOrchestrationDiagnostics: () => managedOrchestrationRuntime?.getDiagnostics() ?? null,
    getSessionChangeReadDiagnostics: () => sessionChangeHost.getReadDiagnostics(),
    getHostStallDiagnostics: () => hostStallClock().snapshot(),
    getBrowserLeaseDiagnostics: () => ({
      activeLeases: browserLeaseRuntime?.getSnapshot().length ?? 0,
    }),
    prepareBotRuntime: () => multiUserRuntime?.botsRuntime?.prepareStartup?.({
      ensureRuntime: typeof options.ensureBotRuntimeReady === 'function'
        ? options.ensureBotRuntimeReady
        : null,
      onStatus: (text) => onOpenCodeStartupStatus?.(text),
    }) ?? Promise.resolve({ state: 'skipped', reason: 'bots_unavailable' }),
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: async () => {
      const scheduledTasks = await scheduledTasksRuntime.refreshStatus();
      return {
        tunnel: {
          active: Boolean(tunnelService.getPublicUrl()),
        },
        scheduledTasks,
        scheduledTasksVerified: scheduledTasks.verified !== false,
        bots: await multiUserRuntime?.botsRuntime?.getQuitRiskStatus?.(),
      };
    },
    checkpointBotRuns: () => multiUserRuntime?.botsRuntime?.checkpointBotRuns?.(),
    stopBotDispatcher: () => multiUserRuntime?.botsRuntime?.stopDispatcher?.(),
    resumeDeferredOpenCodeStartup,
    isOpenCodeStartupDeferred: () => !deferredOpenCodeStartupComplete,
    isReady: () => isOpenCodeReady,
    restartOpenCode: () => restartOpenCode(),
    stop: (shutdownOptions = {}) =>
      gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false })
  };
}

export function runWebCliEntry(currentFilename) {
runCliEntryIfMain({
  process,
  currentFilename,
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => {
    exitOnShutdown = value;
  },
  startServer: main,
});
}


export {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
};
