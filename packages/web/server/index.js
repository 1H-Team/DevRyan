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
import { canUseBrowser } from './lib/multi-user/policy.js';
import { createBotModelCatalogLoader } from './lib/bots/model-catalog.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
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
import { createCanonicalOpenCodeEventProcessor } from './lib/event-stream/canonical-ingestion.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { createOpenCodeLifecycleRuntime } from './lib/opencode/lifecycle.js';
import { createOpenAiOAuthCoordinator } from './lib/opencode/openai-oauth-coordinator.js';
import { createOpenAiOAuthBridge, registerManagedOAuthMutationGate } from './lib/opencode/openai-oauth-bridge.js';
import { resolveContextModeCapability } from './lib/opencode/context-mode-hotfix.js';
import { createConfigApplyCoordinator, createConfigChangeMarker } from '@openchamber/shared-runtime';
import { syncPackagedAgents } from './lib/opencode/packaged-agent-sync.js';
import { syncRuntimeAgentOverlays } from './lib/opencode/runtime-agent-overlays.js';
import { createUserProfileProvisioningRuntime } from './lib/opencode/user-profile-provisioning.js';
import { readAuthFile } from './lib/opencode/auth.js';
import { discoverSkills } from './lib/opencode/skills.js';
import { createOpenCodeEnvRuntime } from './lib/opencode/env-runtime.js';
import { resolveOpenCodeEnvConfig } from './lib/opencode/env-config.js';
import { createHmrStateRuntime } from './lib/opencode/hmr-state-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
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
import { createOpenCodeUpdateRuntime } from './lib/opencode/opencode-update-runtime.js';
import { createBootstrapRuntime } from './lib/opencode/bootstrap-runtime.js';
import { createSessionRuntime } from './lib/opencode/session-runtime.js';
import { createOpenCodeWatcherRuntime } from './lib/opencode/watcher.js';
import { createTurnTimingRuntime, registerTurnTimingRoutes } from './lib/opencode/turn-timing.js';
import { createAgentRuntimeWarmup, registerAgentRuntimeWarmupRoute } from './lib/opencode/agent-runtime-warmup.js';
import { createProjectPrewarmRuntime } from './lib/opencode/project-prewarm-runtime.js';
import { createXaiToolCatalogRuntime } from './lib/opencode/xai-tool-catalog-runtime.js';
import { createStandardSessionTitleRuntime } from './lib/opencode/standard-session-title-runtime.js';
import { createHarnessPreflight, registerHarnessPreflightRoute } from './lib/opencode/harness-preflight.js';
import { inspectClaudeRuntimeCompatibility } from './lib/opencode/claude-runtime-compatibility.js';
import { resolveApprovedSkills } from './lib/opencode/skill-policy.js';
import { getAgentConfig, getAgentSources, listConfigAgents, listStaleAgentModelOverrides } from './lib/opencode/agents.js';
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
import { createWebManagedOrchestrationRuntime } from './lib/orchestration/runtime.js';
import { registerManagedOrchestrationRoutes } from './lib/orchestration/routes.js';
import { createWebHarnessRuntime } from './lib/harness/runtime.js';
import { createWebPrimaryRecoveryRuntime } from './lib/harness/provider-recovery.js';
import { createWebCommandDeadlineRuntime } from './lib/harness/command-deadline-runtime.js';
import { registerDiagnosticsRoutes } from './lib/diagnostics/routes.js';
import { registerMemoryDebugRoutes } from './lib/debug/memory-routes.js';
import { createWebEvidenceRuntime } from './lib/evidence/runtime.js';
import { registerEvidenceRoutes } from './lib/evidence/routes.js';
import { registerIndexingPolicy } from './lib/indexing-policy.js';
import { getPublicRuntimePort } from './lib/runtime-port-visibility.js';
import { configureWorktreeBootstrapRuntime } from './lib/git/service.js';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import webPush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
function parseSkillFrontmatterForHarness(skillMdPath) {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
      return {
        name: '',
        path: skillMdPath,
        parseOk: false,
        error: 'Missing YAML frontmatter',
      };
    }
    const frontmatter = yaml.parse(match[1]) || {};
    const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
    return {
      name,
      path: skillMdPath,
      parseOk: Boolean(name),
      ...(name ? {} : { error: 'Missing skill name in frontmatter' }),
    };
  } catch (error) {
    return {
      name: '',
      path: skillMdPath,
      parseOk: false,
      error: error.message || 'Failed to parse skill frontmatter',
    };
  }
}

function collectHarnessSkillEntries(directory) {
  const byPath = new Map();
  for (const skill of discoverSkills(directory)) {
    if (!skill?.path) continue;
    byPath.set(path.resolve(skill.path), {
      ...skill,
      parseOk: true,
    });
  }

  const roots = [
    path.join(os.homedir(), '.agents', 'skills'),
  ];

  if (directory) {
    const worktreeRoot = findWorktreeRoot(directory) || path.resolve(directory);
    for (const ancestor of getAncestors(directory, worktreeRoot)) {
      roots.push(path.join(ancestor, '.agents', 'skills'));
    }
  }

  for (const dir of resolveSkillSearchDirectories(directory)) {
    roots.push(path.join(dir, 'skill'));
    roots.push(path.join(dir, 'skills'));
  }

  for (const root of roots) {
    for (const skillMdPath of walkSkillMdFiles(root)) {
      const resolved = path.resolve(skillMdPath);
      if (byPath.has(resolved)) continue;
      byPath.set(resolved, parseSkillFrontmatterForHarness(skillMdPath));
    }
  }

  return [...byPath.values()];
}

function headerIncludesEventStream(value) {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'));
  }

  return false;
}

/**
 * SSE endpoint paths that must never be compressed by the compression middleware.
 *
 * The compression middleware filter runs before route handlers, so
 * `res.getHeader('Content-Type')` is still undefined at that point.
 * This means the Accept-header check alone is not sufficient for
 * non-standard clients (e.g. curl, fetch) that omit Accept.
 * Path-based exclusion acts as a deterministic fallback.
 */
const SSE_PATH_PREFIXES = [
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/openchamber/events',
];

function shouldSkipCompression(req, res) {
  if (headerIncludesEventStream(req.headers.accept)) {
    return true;
  }

  const pathname = req.path || req.url || '';
  if (
    pathname.startsWith('/api/browser/agent-leases/')
    && pathname.endsWith('/stream')
  ) {
    return true;
  }
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) {
    return true;
  }

  if (pathname.startsWith('/api/terminal/') && pathname.endsWith('/stream')) {
    return true;
  }
  for (const prefix of SSE_PATH_PREFIXES) {
    if (pathname === prefix) {
      return true;
    }
  }

  return headerIncludesEventStream(res.getHeader('Content-Type'));
}

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

const OPENCHAMBER_USER_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
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
  webPush,
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
});

const emitSyntheticOpenCodeEvent = (payload, options = {}) => {
  maybeCacheSessionInfoFromEvent(payload);
  sessionRuntime.processOpenCodeSsePayload(payload);
  turnTimingRuntime.processOpenCodeEvent(payload);
  harnessRuntime.recordOpenCodeEvent(payload, options.directory ?? null);
  void multiUserRuntime?.recordOpenCodeActivity?.(payload).catch((error) => {
    console.warn('[MultiUser] Failed to project OpenCode activity:', error?.message || error);
  });
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

const cursorSdkRuntime = createCursorSdkRuntime({
  storageDir: path.join(OPENCHAMBER_DATA_DIR, 'cursor-sdk-sessions'),
  readAuth: readAuthFile,
  env: process.env,
  emitEvent: emitSyntheticOpenCodeEvent,
  recordTimingMark: (input) => turnTimingRuntime.recordClientMark(input),
  logger: console,
  resolveAgentPrompt: async ({ agent, directory }) => {
    const result = getAgentConfig(agent, directory);
    return typeof result?.config?.prompt === 'string' ? result.config.prompt : '';
  },
  resolveAgentDefinitions: resolveCursorSdkAgentDefinitions,
});

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
let lastOpenCodeLaunchDiagnostics = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
let observeContextModeToolFailure = () => false;
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
let browserLeaseRuntime = null;
let managedBrowserEnvironmentProvider = null;
let botEncryptionKeyProvider = null;
let botEncryptionKeyInstaller = null;
let botRuntimeStatusProvider = null;
let botRuntimeControlProvider = null;
let botRuntimeIndexerProvider = null;
let botAgentRequestProvider = null;
let botBrowserProfilesProvider = null;
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
let openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;

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

const getOpenCodeAuthHeaders = (...args) => openCodeAuthStateRuntime.getOpenCodeAuthHeaders(...args);
const isOpenCodeConnectionSecure = (...args) => openCodeAuthStateRuntime.isOpenCodeConnectionSecure(...args);
const ensureLocalOpenCodeServerPassword = (...args) => openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword(...args);

const openCodeNetworkState = {};
Object.defineProperties(openCodeNetworkState, {
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeVersion: { get: () => openCodeVersion, set: (value) => { openCodeVersion = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => { openCodeBaseUrl = value; } },
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
const xaiToolCatalogRuntime = createXaiToolCatalogRuntime({
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
    const statusUrl = new URL(buildOpenCodeUrl('/session/status'));
    statusUrl.searchParams.set('directory', directory);
    const response = await fetch(statusUrl, {
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode session status responded with ${response.status}`);
    }
    const statuses = await response.json();
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
    const target = new URL(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/abort`));
    target.searchParams.set('directory', directory);
    await fetch(target, {
      method: 'POST',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(5000),
    });
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
  state: openCodeEnvState,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated,
  ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
});

const applyLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.getLoginShellEnvSnapshot(...args);
const ensureOpencodeCliEnv = (...args) => openCodeEnvRuntime.ensureOpencodeCliEnv(...args);
const applyOpencodeBinaryFromSettings = (...args) => openCodeEnvRuntime.applyOpencodeBinaryFromSettings(...args);
const resolveOpencodeCliPath = (...args) => openCodeEnvRuntime.resolveOpencodeCliPath(...args);
const isExecutable = (...args) => openCodeEnvRuntime.isExecutable(...args);
const searchPathFor = (...args) => openCodeEnvRuntime.searchPathFor(...args);
const resolveGitBinaryForSpawn = (...args) => openCodeEnvRuntime.resolveGitBinaryForSpawn(...args);
const resolveWslExecutablePath = (...args) => openCodeEnvRuntime.resolveWslExecutablePath(...args);
const buildWslExecArgs = (...args) => openCodeEnvRuntime.buildWslExecArgs(...args);
const resolveManagedOpenCodeLaunchSpec = (...args) => openCodeEnvRuntime.resolveManagedOpenCodeLaunchSpec(...args);
const clearResolvedOpenCodeBinary = (...args) => openCodeEnvRuntime.clearResolvedOpenCodeBinary(...args);
const openCodeResolutionRuntime = createOpenCodeResolutionRuntime({
  path,
  resolveOpencodeCliPath,
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  resolveManagedOpenCodeLaunchSpec,
  getResolvedState: () => ({
    resolvedOpencodeBinary,
    resolvedOpencodeBinarySource,
    useWslForOpencode,
    resolvedWslBinary,
    resolvedWslOpencodePath,
    resolvedWslDistro,
    resolvedNodeBinary,
    resolvedBunBinary,
  }),
  setResolvedOpencodeBinarySource: (value) => {
    resolvedOpencodeBinarySource = value;
  },
  getDetectedOpenCodeVersion: () => (openCodePort ? openCodeVersion : null),
});
const getOpenCodeResolutionSnapshot = (...args) =>
  openCodeResolutionRuntime.getOpenCodeResolutionSnapshot(...args);
const openCodeUpdateRuntime = createOpenCodeUpdateRuntime();
const checkForOpenCodeUpdates = (...args) =>
  openCodeUpdateRuntime.checkForUpdates(...args);

applyLoginShellEnvSnapshot();

notificationTemplateRuntime = createNotificationTemplateRuntime({
  readSettingsFromDisk,
  persistSettings,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
});

const standardSessionTitleRuntime = createStandardSessionTitleRuntime({
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
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
});

const processCanonicalOpenCodeEvent = createCanonicalOpenCodeEventProcessor({
  cacheSessionInfo: maybeCacheSessionInfoFromEvent,
  sendPush: maybeSendPushForTrigger,
  processSessionState: (payload) => sessionRuntime.processOpenCodeSsePayload(payload),
  processTurnTiming: (payload) => turnTimingRuntime.processOpenCodeEvent(payload),
  recordJournalEvent: (payload) => harnessRuntime.recordOpenCodeEvent(payload),
  recordMultiUserActivity: (payload) => multiUserRuntime?.recordOpenCodeActivity?.(payload),
  processEvidence: (payload) => evidenceRuntime?.processOpenCodeEvent(payload),
  processBrowserLease: (payload) => browserLeaseRuntime?.processOpenCodeEvent(payload),
  processManagedOrchestration: (payload) => managedOrchestrationRuntime?.processOpenCodeEvent?.(payload),
  processSessionTitle: (payload) => standardSessionTitleRuntime.processOpenCodeEvent(payload),
  processContextModeRecovery: (payload) => observeContextModeToolFailure(payload),
  processCommandDeadline: (payload) => observeCommandDeadline(payload),
  onSessionDeleted: (deletedSessionId) => {
    sessionRuntime.clearSessionActivity(deletedSessionId);
    void cursorSdkRuntime.deleteSessionState(deletedSessionId).catch((error) => {
      console.warn('[CursorSDK] Failed to clean up deleted session state:', error);
    });
  },
});

const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  waitForOpenCodePort: (...args) => waitForOpenCodePort(...args),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  parseSseDataPayload: (...args) => parseSseDataPayload(...args),
  globalEventHub: globalMessageStreamHub,
  onPayload: processCanonicalOpenCodeEvent,
});


const serverUtilsRuntime = createServerUtilsRuntime({
  fs,
  os,
  path,
  process,
  openCodeReadyGraceMs: OPEN_CODE_READY_GRACE_MS,
  longRequestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
  getRuntime: () => ({
    openCodePort,
    openCodeBaseUrl,
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
  openCodeProcess: { get: () => openCodeProcess, set: (value) => { openCodeProcess = value; } },
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => { openCodeBaseUrl = value; } },
  openCodeWorkingDirectory: { get: () => openCodeWorkingDirectory, set: (value) => { openCodeWorkingDirectory = value; } },
  currentRestartPromise: { get: () => currentRestartPromise, set: (value) => { currentRestartPromise = value; } },
  isRestartingOpenCode: { get: () => isRestartingOpenCode, set: (value) => { isRestartingOpenCode = value; } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
  lastOpenCodeError: { get: () => lastOpenCodeError, set: (value) => { lastOpenCodeError = value; } },
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
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  ensureLocalOpenCodeServerPassword,
  buildWslExecArgs,
  resolveWslExecutablePath,
  resolveManagedOpenCodeLaunchSpec,
  setOpenCodePort,
  setDetectedOpenCodeApiPrefix,
  setupProxy: (...args) => setupProxy(...args),
  ensureOpenCodeApiPrefix,
  clearResolvedOpenCodeBinary,
  buildAugmentedPath,
  buildManagedOpenCodePath,
  getManagedOpenCodeShellEnvSnapshot: getLoginShellEnvSnapshot,
  getActiveSessionCount,
  getAuthoritativeActiveSessionCount,
  acquireContextModeAdmissionHold: harnessRuntime.acquirePromptAdmissionHold,
  recordContextModeRecoveryIncident: (status) => harnessRuntime.record({
    type: 'log',
    level: status.state === 'healthy' ? 'info' : 'warn',
    event: 'context_mode_recovery',
    payload: status,
  }),
  provisionUserProfile: createUserProfileProvisioningRuntime({
    configRoot: defaultConfigRoot,
    profileRoot: path.join(defaultConfigRoot, 'user-profile'),
  }).provision,
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
  sanitizeProjects,
  sanitizeHiddenSkills,
  discoverSkills,
  getManagedOrchestrationEnvironment: async () => {
    if (!managedOrchestrationRuntime) {
      throw new Error('Managed orchestration runtime was not prepared before OpenCode startup');
    }
    return await managedOrchestrationRuntime.prepareBridge();
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
  onOpenCodeRestarted: () => {
    sessionRuntime.resetAllSessionActivityToIdle();
    void projectPrewarmRuntime?.run('opencode-restart');
  },
  onStartupStatus: (text) => onOpenCodeStartupStatus?.(text),
});

observeContextModeToolFailure = (payload) => (
  openCodeLifecycleRuntime.observeContextModeToolFailure(payload)
);
const restartOpenCode = (...args) => openCodeLifecycleRuntime.restartOpenCode(...args);
const waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const waitForAgentPresence = (...args) => openCodeLifecycleRuntime.waitForAgentPresence(...args);
const commandDeadlineRuntime = createWebCommandDeadlineRuntime({
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
  dataDirectory: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl: (pathname) => buildOpenCodeUrl(pathname, ''),
  getOpenCodeAuthHeaders,
  isManaged: () => !(isExternalOpenCode || ENV_SKIP_OPENCODE_START || ENV_CONFIGURED_OPENCODE_HOST),
  getManagedRuntime: () => managedOrchestrationRuntime,
  getMultiUserRuntime: () => multiUserRuntime,
  publishEvent: emitSyntheticOpenCodeEvent,
  recordIncident: (incident) => harnessRuntime.record({ type: 'lifecycle', event: incident.event,
    sessionID: incident.sessionID, messageID: incident.messageID, payload: incident }),
});
harnessRuntime.setPrimaryRecoveryRuntime(primaryRecoveryRuntime);
observeCommandDeadline = (payload) => commandDeadlineRuntime.observe(payload);
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
  applyChanges: (input) => openCodeLifecycleRuntime.applyOpenCodeConfigChanges(input),
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
const bootstrapOpenCodeAtStartup = async (...args) => {
  await openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup(...args);
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
  void projectPrewarmRuntime?.run('startup');
};
const killProcessOnPort = (...args) => openCodeLifecycleRuntime.killProcessOnPort(...args);
const waitForPortRelease = (...args) => openCodeLifecycleRuntime.waitForPortRelease(...args);

const fetchAgentsSnapshot = (...args) => serverUtilsRuntime.fetchAgentsSnapshot(...args);
const fetchProvidersSnapshot = (...args) => serverUtilsRuntime.fetchProvidersSnapshot(...args);
const fetchModelsSnapshot = (...args) => serverUtilsRuntime.fetchModelsSnapshot(...args);
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
  getSessionTitleRuntime: () => standardSessionTitleRuntime,
  shouldSkipOpenCodeStop: () => ENV_SKIP_OPENCODE_START || isExternalOpenCode,
  getOpenCodePort: () => openCodePort,
  getOpenCodeProcess: () => openCodeProcess,
  setOpenCodeProcess: (value) => {
    openCodeProcess = value;
  },
  killProcessOnPort,
  waitForPortRelease,
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
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
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
  if (multiUserRuntime.enabled) {
    console.log('Supabase multi-user identity and policy enforcement enabled');
  }
  pushRuntime.setSessionVisibilityFilter((tokenHash, sessionId) => (
    multiUserRuntime.canSessionTokenHashAccess(tokenHash, sessionId)
  ));

  browserLeaseRuntime = createBrowserLeaseRuntime({
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
    ownsSession: (principal, sessionId) => multiUserRuntime.ownsSession(principal, sessionId),
    getHostLeaseMetadata: typeof options.getBrowserLeaseObservationSnapshot === 'function'
      ? options.getBrowserLeaseObservationSnapshot
      : null,
    openHostLeaseStream: typeof options.openBrowserLeaseObservationStream === 'function'
      ? options.openBrowserLeaseObservationStream
      : null,
    onPrincipalChanged: broadcastBrowserAgentLeasesChanged,
    audit: (principal, action, context) => multiUserRuntime.audit(principal, action, context),
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
    getHealthSnapshot: () => {
      const launchSpec = resolvedOpencodeBinary && !useWslForOpencode
        ? resolveManagedOpenCodeLaunchSpec(resolvedOpencodeBinary)
        : null;
      const contextModeAvailable = resolveContextModeCapability({
        isOpenCodeReady,
        isRestartingOpenCode,
        isExternalOpenCode,
        skipOpenCodeStart: ENV_SKIP_OPENCODE_START,
        configuredOpenCodeHost: ENV_CONFIGURED_OPENCODE_HOST,
      });
      return {
        openCodePort,
        openCodeVersion: openCodePort ? openCodeVersion : null,
        openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
        openCodeSecureConnection: isOpenCodeConnectionSecure(),
        openCodeAuthSource: openCodeAuthSource || null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: true,
        isOpenCodeReady,
        lastOpenCodeError,
        openCodeProbe: openCodeLifecycleState.openCodeProbe ?? null,
        lastOpenCodeLaunchDiagnostics,
        opencodeBinaryResolved: resolvedOpencodeBinary || null,
        opencodeBinarySource: resolvedOpencodeBinarySource || null,
        opencodeLaunchBinary: launchSpec?.binary || null,
        opencodeLaunchArgs: launchSpec?.args || [],
        opencodeLaunchWrapperType: launchSpec?.wrapperType || null,
        opencodeViaWsl: useWslForOpencode,
        opencodeWslBinary: resolvedWslBinary || null,
        opencodeWslPath: resolvedWslOpencodePath || null,
        opencodeWslDistro: resolvedWslDistro || null,
        nodeBinaryResolved: resolvedNodeBinary || null,
        bunBinaryResolved: resolvedBunBinary || null,
        desktopNotifyEnabled: ENV_DESKTOP_NOTIFY,
        planModeExperimentalEnabled: PLAN_MODE_EXPERIMENT_ENABLED,
        contextModeAvailable,
        contextModeReadOnlyIndexing: contextModeAvailable,
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
          server,
          onDesktopHostLease: options.onDesktopHostLease,
          onDesktopHostRelease: options.onDesktopHostRelease,
          botRuntimeControl: options.runtimeServiceBotRuntimeControl,
          onDisableRuntimeService: options.onDisableRuntimeService,
          onPrepareRuntimeServiceUpdate: options.onPrepareRuntimeServiceUpdate,
        });
      }
    },
  });
  uiAuthController = bootstrapResult.uiAuthController;
  // Must precede managed session routes, which intercept the generic proxy.
  app.use('/api/session', (req, res, next) => {
    if (isSessionCreateRequest(req)) {
      const trace = beginSessionCreationTrace(req, (entry) => harnessRuntime.record(entry));
      res.once('finish', () => trace.mark('response_finished'));
      res.once('close', () => { if (!res.writableFinished) trace.mark('client_disconnected'); });
    }
    next();
  });
  multiUserRuntime.registerRoutes(app, {
    isSessionCreationRestarting: () => isRestartingOpenCode || !isOpenCodeReady,
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
  app.use('/api/session/:sessionID',
    express.json({ limit: '50mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    primaryRecoveryRuntime.middleware);
  app.use(
    '/api/session/:sessionID/prompt_async',
    express.json({ limit: '50mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    harnessRuntime.promptAdmissionMiddleware(turnTimingRuntime),
  );
  app.use('/api/session/:sessionID', harnessRuntime.controlJournalMiddleware);
  registerDiagnosticsRoutes(app, {
    runtime: harnessRuntime,
    getEvidenceRecords: (scope) => evidenceRuntime.getRecords(scope),
    getContextModeRecoveryStatus: openCodeLifecycleRuntime.getContextModeRecoveryStatus,
    getCommandDeadlineRecoveryStatus: commandDeadlineRuntime.getStatus,
  });
  registerMemoryDebugRoutes(app, {
    getAppMetrics: typeof options.getAppMetrics === 'function' ? options.getAppMetrics : null,
  });
  registerEvidenceRoutes(app, { runtime: evidenceRuntime });
  await harnessInitialization;

  managedOrchestrationRuntime = createWebManagedOrchestrationRuntime({
    dataDirectory: OPENCHAMBER_DATA_DIR,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    cursorSdkRuntime,
    publishEvent: emitSyntheticOpenCodeEvent,
    isManagedOpenCode: () => !(
      isExternalOpenCode
      || ENV_SKIP_OPENCODE_START
      || ENV_CONFIGURED_OPENCODE_HOST
    ),
    getWorkAdmissionBlock: harnessRuntime.getPromptAdmissionBlock,
    resolveAgentExecution: (params) => multiUserRuntime.resolveSessionAgentExecution?.(params)
      ?? params.fallbackExecution,
    auxiliaryRpcHandlers: {
      primary_recovery: (params) => primaryRecoveryRuntime.plugin(params),
      resolve_agent_execution: (params) => multiUserRuntime.resolveSessionAgentExecution?.(params)
        ?? params.fallbackExecution,
    },
    logger: console,
  });
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
  const agentRuntimeWarmup = createAgentRuntimeWarmup({
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
    getLatestWarmup: () => agentRuntimeWarmup.getLatestResult(),
    getRuntimeMode: () => (isExternalOpenCode || ENV_SKIP_OPENCODE_START ? 'external' : 'managed'),
    getPackagedAgents: () => listPackagedAgents(),
    readSkillBody: (skill) => parseMdFile(skill.path).body,
    getClaudeRuntime: () => inspectClaudeRuntimeCompatibility(),
    recordDiagnostic: (entry) => harnessRuntime.record(entry),
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: fetch,
  }));

  registerManagedOAuthMutationGate(app, { coordinator: openAiOAuthCoordinator,
    isManaged: () => Boolean(openCodeLifecycleState.openCodeProcess && !openCodeLifecycleState.isExternalOpenCode) });
  await featureRoutesRuntime.registerRoutes(app, {
    crypto,
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
    abortActiveSessionsForConfigRestart,
    auditForceConfigRestart,
    getOpenCodeResolutionSnapshot,
    checkForOpenCodeUpdates,
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
    cursorSdkRuntime,
    standardSessionTitleRuntime,
    getOpenCodePort: () => openCodePort,
    getOpenCodeWorkingDirectory: () => openCodeWorkingDirectory,
    setOpenCodeWorkingDirectory: (directory) => {
      openCodeWorkingDirectory = directory;
      syncToHmrState();
    },
    restartOpenCode,
    waitForOpenCodeReady,
    isExternalOpenCode: () => isExternalOpenCode || ENV_SKIP_OPENCODE_START,
    buildAugmentedPath,
    projectConfigRuntime,
    scheduledTasksRuntime,
    getOpenChamberEventClients: () => uiOpenChamberEventClients,
    writeSseEvent,
    emitSyntheticOpenCodeEvent,
    resolveZenModel,
    fetchFreeZenModels,
    getCachedZenModels,
    xaiToolCatalogRuntime,
    resolveZenModelNonBlocking,
    recordCommitTiming: (req, payload) => harnessRuntime.record({
      type: 'timing',
      actor: req?.principal?.id
        ? {
            id: req.principal.id,
            role: req.principal.role || null,
            scope: req.principal.scope || null,
          }
        : null,
      mark: payload.event,
      payload: {
        durationMs: payload.totalMs,
        stages: [
          { phase: 'context', durationMs: payload.contextMs },
          { phase: 'model', durationMs: payload.modelMs },
          { phase: 'provider', durationMs: payload.providerMs },
          { phase: 'parsing', durationMs: payload.parseMs },
        ],
        count: payload.selectedFileCount,
        scope: payload.stagedOnly === true ? 'staged-only' : 'staged-and-unstaged',
        outcome: payload.outcome,
        model: payload.model,
        state: payload.catalogState,
        retry: payload.retried === true,
        source: payload.source,
        providerOutcome: payload.providerOutcome,
      },
    }),
    resolveManagedProject: multiUserRuntime.resolveManagedProject?.bind(multiUserRuntime),
    ownsSession: multiUserRuntime.ownsSession?.bind(multiUserRuntime),
    resolveOwnedSessionPlanContext: multiUserRuntime.resolveOwnedSessionPlanContext?.bind(multiUserRuntime),
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
    xaiToolCatalogRuntime.stopPeriodicRefresh();
  });

  reportStartupPhase('listener', 'Opening DevRyan…');
  const startupPipelineResult = await startupPipelineRuntime.run({
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

  reportStartupPhase('ready', 'DevRyan is ready.');

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getOpenCodePort: () => getPublicRuntimePort(openCodePort, {
      startupSkipped: ENV_SKIP_OPENCODE_START,
      externallyManaged: isExternalOpenCode,
    }),
    getManagedOrchestrationDiagnostics: () => managedOrchestrationRuntime?.getDiagnostics() ?? null,
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

runCliEntryIfMain({
  process,
  currentFilename: __filename,
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => {
    exitOnShutdown = value;
  },
  startServer: main,
});

export {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
};
