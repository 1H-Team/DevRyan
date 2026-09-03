import { createProjectIdFromPath } from '../projects/project-id.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  clearCursorSdkAuth,
  saveCursorSdkAuth,
} from '@openchamber/cursor-sdk-runtime';
import { resolveProviderPromptTools } from '@openchamber/orchestration-runtime';
import {
  GITHUB_COPILOT_PROVIDER_ID,
  getProviderIntegrationLookupIds,
  hasGitHubCopilotProviderModels,
  isGitHubCopilotProviderId,
  mergeGitHubCopilotProvider,
} from './provider-integrations.js';
import { annotateOpenAIModelAvailability } from './openai-model-availability.js';
import { stripMessageDiffContent } from './diff-summary.js';
import { discoverGitHubCopilotModels } from './github-copilot-models.js';
import { createCursorSessionTitleRuntime } from './cursor-session-title-runtime.js';
import { createStandardSessionTitleRuntime } from './standard-session-title-runtime.js';
import { registerQuestionRoutes } from './question-routes.js';
import { createGlobalAgentsMdRuntime } from './global-agents-md-runtime.js';
import { registerGlobalAgentsMdRoutes } from './global-agents-md-routes.js';
import { runClaudeCodeAuthStatus } from './claude-auth-status.js';
import { resolveClaudeCodeLaunch as resolveClaudeCodeLaunchDefault } from './claude-cli-runtime.js';
import {
  readMeridianPromptMode,
  setMeridianPromptCompatibilityMode,
} from './meridian-sdk-features.js';

import { ANTHROPIC_PROVIDER_IDS } from './anthropic-provider-ids.js';
const ANTIGRAVITY_PROVIDER_ID = 'antigravity';
const CURSOR_ACP_PROVIDER_ID = 'cursor-acp';
const CURSOR_USAGE_TOKEN_MAX_LENGTH = 16_384;
// Upper bound on the one-time wait for the xai tool-catalog dedupe overrides on
// a cold cache; on timeout the prompt proceeds and the post-response refresh
// warms the cache for the next turn.
const XAI_TOOL_CATALOG_COLD_START_WAIT_MS = 1_200;

const getAntigravityAccountsSource = async () => {
  const { ANTIGRAVITY_ACCOUNTS_PATHS, readJsonFile } = await import('../quota/utils/index.js');
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = readJsonFile(filePath);
    if (Array.isArray(data?.accounts) && data.accounts.length > 0) {
      return { exists: true, path: filePath };
    }
  }
  return { exists: false, path: null };
};

const removeAntigravityAccounts = async () => {
  const { ANTIGRAVITY_ACCOUNTS_PATHS } = await import('../quota/utils/index.js');
  let removed = false;
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed = true;
      }
    } catch (error) {
      console.error(`Failed to remove Antigravity auth file: ${filePath}`, error);
      throw new Error('Failed to remove Antigravity authentication');
    }
  }
  return removed;
};

export const createOpenCodeUpdateCheckHandler = ({
  readSettingsFromDiskMigrated,
  getOpenCodeResolutionSnapshot,
  checkForOpenCodeUpdates,
}) => async (_req, res) => {
  try {
    const settings = await readSettingsFromDiskMigrated();
    const resolution = await getOpenCodeResolutionSnapshot(settings);
    const updateInfo = await checkForOpenCodeUpdates({
      currentVersion: resolution.detectedVersion,
      supportedVersion: resolution.targetVersion,
    });
    res.json(updateInfo);
  } catch (error) {
    console.error('Failed to check for OpenCode updates:', error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to check the latest OpenCode version',
    });
  }
};

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    clientReloadDelayMs,
    getOpenCodeResolutionSnapshot,
    checkForOpenCodeUpdates,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeAntigravityProviderConfig = () => false,
    removeProviderConfig,
    ensureAnthropicOAuthProviderConfig,
    markConfigChange,
    buildAugmentedPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders = () => ({}),
    getOpenCodeWorkingDirectory = () => null,
    setOpenCodeWorkingDirectory = () => {},
    isExternalOpenCode = () => false,
    cursorSdkRuntime = null,
    cursorSessionTitleRuntime: injectedCursorSessionTitleRuntime = null,
    standardSessionTitleRuntime: injectedStandardSessionTitleRuntime = null,
    xaiToolCatalogRuntime = null,
    globalAgentsMdRuntime: injectedGlobalAgentsMdRuntime = null,
    resolveZenModel = async () => undefined,
    resolveZenModelNonBlocking = () => ({}),
    authLibrary: injectedAuthLibrary = null,
    readClaudePromptMode = readMeridianPromptMode,
    setClaudePromptCompatibilityMode = setMeridianPromptCompatibilityMode,
    resolveClaudeCodeLaunch = resolveClaudeCodeLaunchDefault,
  } = dependencies;

  const cursorSessionTitleRuntime = injectedCursorSessionTitleRuntime || createCursorSessionTitleRuntime({
    cursorSdkRuntime,
    fetchImpl: fetch,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    logger: console,
  });
  const standardSessionTitleRuntime = injectedStandardSessionTitleRuntime || createStandardSessionTitleRuntime({
    fetchImpl: fetch,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    logger: console,
  });
  const globalAgentsMdRuntime = injectedGlobalAgentsMdRuntime || createGlobalAgentsMdRuntime({
    agentsMdPath: path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md'),
    refreshRuntime: ({ changed } = {}) => markConfigChange(
      'global behavior (AGENTS.md) updated',
      {},
      changed !== false,
    ),
    isEditable: () => !isExternalOpenCode(),
  });

  registerQuestionRoutes(app, {
    cursorSdkRuntime,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  });
  registerGlobalAgentsMdRoutes(app, { runtime: globalAgentsMdRuntime });

  let authLibrary = injectedAuthLibrary;
  const pendingMcpAuthContextByState = new Map();
  const PENDING_MCP_AUTH_TTL_MS = 30 * 60 * 1000;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  const normalizePendingString = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
  };

  const readCursorUsageAuthConfigured = async () => {
    const { readAuthFile } = await getAuthLibrary();
    const auth = readAuthFile();
    const cursorAuth = auth?.[CURSOR_ACP_PROVIDER_ID];
    return Boolean(
      cursorAuth &&
      typeof cursorAuth === 'object' &&
      typeof cursorAuth.usageSessionToken === 'string' &&
      cursorAuth.usageSessionToken.trim().length > 0
    );
  };

  const hasProviderAuthForLookupIds = async (providerIds) => {
    const { readAuthFile } = await getAuthLibrary();
    const auth = readAuthFile();
    return providerIds.some((providerId) => (
      auth?.[providerId] && typeof auth[providerId] === 'object'
    ));
  };

  const removeProviderAuthForLookupIds = async (providerIds) => {
    const { removeProviderAuth } = await getAuthLibrary();
    let removed = false;
    for (const providerId of providerIds) {
      removed = removeProviderAuth(providerId) || removed;
    }
    return removed;
  };

  const readProviderSourceSnapshot = async (providerId, directory) => {
    const result = getProviderSources(providerId, directory);
    const { getProviderAuth } = await getAuthLibrary();
    const authLookupIds = ANTHROPIC_PROVIDER_IDS.has(providerId)
      ? [providerId, 'anthropic', 'claude']
      : getProviderIntegrationLookupIds(providerId);
    const auth = authLookupIds.map((id) => getProviderAuth(id)).find(Boolean);

    if (providerId === CURSOR_ACP_PROVIDER_ID) {
      result.sources.auth.exists = Boolean(
        (typeof process.env.CURSOR_API_KEY === 'string' && process.env.CURSOR_API_KEY.trim()) ||
        (auth && typeof auth === 'object' && (
          (typeof auth.key === 'string' && auth.key.trim()) ||
          (typeof auth.token === 'string' && auth.token.trim())
        ))
      );
    } else {
      result.sources.auth.exists = Boolean(auth);
    }
    if (providerId === ANTIGRAVITY_PROVIDER_ID) {
      result.sources.auth = await getAntigravityAccountsSource();
    }
    return result.sources;
  };

  const removeProviderConfigForScope = (providerId, directory, scope) => (
    providerId === ANTIGRAVITY_PROVIDER_ID
      ? removeAntigravityProviderConfig(directory, scope)
      : removeProviderConfig(providerId, directory, scope)
  );

  const normalizeCursorUsageSessionToken = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const token = value.trim();
    if (!token || token.length > CURSOR_USAGE_TOKEN_MAX_LENGTH) {
      return null;
    }
    return token;
  };

  const normalizeWorkspaceDirectory = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return path.resolve(trimmed);
  };

  const directoriesMatch = (left, right) => {
    const normalizedLeft = normalizeWorkspaceDirectory(left);
    const normalizedRight = normalizeWorkspaceDirectory(right);
    return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
  };

  app.put('/api/auth/:providerId', async (req, res, next) => {
    const providerId = typeof req.params?.providerId === 'string' ? req.params.providerId.trim().toLowerCase() : '';
    if (providerId === CURSOR_ACP_PROVIDER_ID) {
      try {
        const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
        if (!key) {
          return res.status(400).json({ error: 'Cursor SDK API key is required.' });
        }
        const auth = await getAuthLibrary();
        saveCursorSdkAuth({
          readAuth: auth.readAuthFile,
          writeAuth: auth.writeAuthFile,
          key,
          type: typeof req.body?.type === 'string' ? req.body.type : 'api',
        });
        return res.json({ success: true, configured: true });
      } catch (error) {
        console.error('Failed to save Cursor SDK auth:', error);
        return res.status(500).json({ error: error.message || 'Failed to save Cursor SDK auth' });
      }
    }
    if (!ANTHROPIC_PROVIDER_IDS.has(providerId)) {
      return next();
    }

    return res.status(400).json({ error: 'Anthropic API key authentication is not supported in OpenChamber. Use Anthropic OAuth instead.' });
  });

  const pruneExpiredPendingMcpAuthContexts = () => {
    const now = Date.now();
    for (const [state, entry] of pendingMcpAuthContextByState.entries()) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
        pendingMcpAuthContextByState.delete(state);
      }
    }
  };

  app.get('/api/config/settings', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  app.get('/api/opencode/update-check', createOpenCodeUpdateCheckHandler({
    readSettingsFromDiskMigrated,
    getOpenCodeResolutionSnapshot,
    checkForOpenCodeUpdates,
  }));

  app.put('/api/config/settings', async (req, res) => {
    console.log('[API:PUT /api/config/settings] Received request');
    try {
      const previous = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'opencodeBinary')
        ? await readSettingsFromDiskMigrated()
        : null;
      const updated = await persistSettings(req.body ?? {});
      const runtimeSettingChanged = previous !== null
        && String(previous?.opencodeBinary ?? '').trim() !== String(updated?.opencodeBinary ?? '').trim();
      const applyResult = await markConfigChange(
        'runtime binary setting',
        {},
        runtimeSettingChanged,
      );
      console.log(`[API:PUT /api/config/settings] Success, returning ${updated.projects?.length || 0} projects`);
      res.json({ ...updated, ...applyResult });
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  app.post('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(req.body?.state);
      if (!state) {
        return res.json({ success: true, context: null });
      }

      const name = normalizePendingString(req.body?.name);
      if (!name) {
        return res.status(400).json({ error: 'MCP server name is required' });
      }

      const entry = {
        name,
        directory: normalizePendingString(req.body?.directory),
        expiresAt: Date.now() + PENDING_MCP_AUTH_TTL_MS,
      };
      pendingMcpAuthContextByState.set(state, entry);

      return res.json({
        success: true,
        context: {
          name: entry.name,
          directory: entry.directory,
        },
      });
    } catch (error) {
      console.error('Failed to store pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to store pending MCP auth context' });
    }
  });

  app.get('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json(null);
      }

      const pendingMcpAuthContext = pendingMcpAuthContextByState.get(state) ?? null;
      if (!pendingMcpAuthContext) {
        return res.status(404).json({ error: 'No pending MCP auth context' });
      }

      return res.json(pendingMcpAuthContext);
    } catch (error) {
      console.error('Failed to read pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to read pending MCP auth context' });
    }
  });

  app.delete('/api/mcp/auth/pending', async (req, res) => {
    try {
      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json({ success: true });
      }

      pendingMcpAuthContextByState.delete(state);
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to clear pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear pending MCP auth context' });
    }
  });

  app.get('/api/provider/anthropic/claude-cli', async (_req, res) => {
    try {
      const pathValue = typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
        : process.env.PATH || '';
      const launch = resolveClaudeCodeLaunch({ pathValue });
      if (!launch) {
        return res.json({
          installed: false,
          path: null,
          loggedIn: false,
          authStatus: 'unavailable',
        });
      }

      const authCheck = await runClaudeCodeAuthStatus({
        executable: launch.executable,
        pathValue: launch.pathValue,
      });
      const auth = authCheck.auth ?? null;
      return res.json({
        installed: true,
        path: launch.executable,
        loggedIn: authCheck.ok,
        authStatus: authCheck.ok
          ? 'authenticated'
          : authCheck.code === 'claude_not_authenticated'
            ? 'signed_out'
            : 'error',
        ...(auth?.authMethod ? { authMethod: auth.authMethod } : {}),
        ...(auth?.apiProvider ? { apiProvider: auth.apiProvider } : {}),
        ...(auth?.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
        ...(!authCheck.ok && authCheck.code !== 'claude_not_authenticated'
          ? { error: authCheck.error, errorCode: authCheck.code }
          : {}),
      });
    } catch (error) {
      console.error('Failed to check Claude Code availability:', error);
      return res.status(500).json({ error: error.message || 'Failed to check Claude Code availability' });
    }
  });

  app.get('/api/provider/anthropic/prompt-mode', (_req, res) => {
    if (isExternalOpenCode()) {
      return res.json({
        mode: 'external',
        compatibilityMode: false,
        editable: false,
      });
    }
    const result = readClaudePromptMode();
    if (!result.ok) {
      return res.status(500).json({ code: result.code, error: result.error });
    }
    return res.json({
      mode: result.mode,
      compatibilityMode: result.compatibilityMode,
      editable: true,
    });
  });

  app.put('/api/provider/anthropic/prompt-mode', (req, res) => {
    if (isExternalOpenCode()) {
      return res.status(409).json({
        code: 'external_opencode_read_only',
        error: 'Claude prompt mode is managed by the configured external OpenCode runtime.',
      });
    }
    if (typeof req.body?.compatibilityMode !== 'boolean') {
      return res.status(400).json({
        code: 'invalid_compatibility_mode',
        error: 'compatibilityMode must be a boolean',
      });
    }
    const result = setClaudePromptCompatibilityMode(req.body.compatibilityMode);
    if (!result.ok) {
      return res.status(500).json({ code: result.code, error: result.error });
    }
    return res.json({
      success: true,
      changed: result.changed,
      mode: result.mode,
      compatibilityMode: result.compatibilityMode,
      editable: true,
    });
  });

  app.post('/api/provider/anthropic/check-oauth', async (req, res) => {
    try {
      const pathValue = typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
        : process.env.PATH || '';
      const launch = resolveClaudeCodeLaunch({ pathValue });
      if (!launch) {
        return res.status(400).json({
          code: 'claude_cli_unavailable',
          error: 'Claude Code is not installed or is not available on PATH.',
        });
      }

      const authCheck = await runClaudeCodeAuthStatus({
        executable: launch.executable,
        pathValue: launch.pathValue,
      });
      if (!authCheck.ok) {
        return res.status(400).json({
          code: authCheck.code === 'claude_not_authenticated'
            ? 'claude_cli_unauthenticated'
            : 'claude_cli_auth_check_failed',
          reason: authCheck.code,
          error: authCheck.error || 'Claude Code authentication check failed.',
        });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;
      if (requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      }

      const result = ensureAnthropicOAuthProviderConfig({ workingDirectory: directory });
      const applyResult = await markConfigChange(
        'anthropic oauth provider configured',
        {},
        result.changed,
      );

      return res.json({
        success: true,
        configured: true,
        changed: result.changed,
        path: result.path,
        ...applyResult,
        auth: authCheck.auth,
      });
    } catch (error) {
      console.error('Failed to check Claude OAuth:', error);
      return res.status(500).json({ error: error.message || 'Failed to check Claude OAuth' });
    }
  });

  app.get('/api/provider/cursor-acp/runtime-status', async (_req, res) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.getRuntimeStatus !== 'function') {
        return res.status(500).json({ error: 'Cursor SDK runtime is unavailable.' });
      }
      return res.json(cursorSdkRuntime.getRuntimeStatus());
    } catch (error) {
      console.error('Failed to read Cursor runtime status:', error);
      return res.status(500).json({ error: error.message || 'Failed to read Cursor runtime status' });
    }
  });

  app.post('/api/provider/cursor-acp/workspace', async (req, res) => {
    try {
      const requestedDirectory = typeof req.body?.directory === 'string'
        ? req.body.directory.trim()
        : typeof req.body?.path === 'string'
          ? req.body.path.trim()
          : '';
      if (!requestedDirectory) {
        return res.status(400).json({ success: false, error: 'Directory is required.' });
      }

      const validated = await validateDirectoryPath(requestedDirectory);
      if (!validated.ok) {
        return res.status(400).json({ success: false, error: validated.error });
      }

      const targetDirectory = normalizeWorkspaceDirectory(validated.directory);
      return res.json({
        success: true,
        sdkManaged: true,
        changed: false,
        restarted: false,
        path: targetDirectory,
      });
    } catch (error) {
      console.error('Failed to repair Cursor workspace:', error);
      return res.status(500).json({ success: false, error: error.message || 'Failed to repair Cursor workspace' });
    }
  });

  app.post('/api/provider/cursor-acp/session-prewarm', async (req, res) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.prewarmSession !== 'function') {
        return res.status(500).json({ ok: false, error: 'Cursor SDK runtime is unavailable.' });
      }

      const sessionID = typeof req.body?.sessionID === 'string' ? req.body.sessionID.trim() : '';
      if (!sessionID) {
        return res.status(400).json({ ok: false, error: 'Session ID is required.' });
      }

      const result = await cursorSdkRuntime.prewarmSession({
        sessionID,
        directory: typeof req.body?.directory === 'string' ? req.body.directory.trim() : '',
        modelID: typeof req.body?.modelID === 'string' ? req.body.modelID.trim() : '',
        variant: typeof req.body?.variant === 'string' ? req.body.variant.trim() : '',
        agent: typeof req.body?.agent === 'string' ? req.body.agent.trim() : '',
      });
      return res.json(result);
    } catch (error) {
      console.error('Failed to prewarm Cursor session:', error);
      return res.status(500).json({ ok: false, error: error.message || 'Failed to prewarm Cursor session' });
    }
  });

  app.post('/api/provider/cursor-acp/configure', async (_req, res) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.verifyConnection !== 'function') {
        return res.status(500).json({ error: 'Cursor SDK runtime is unavailable.' });
      }

      const result = await cursorSdkRuntime.verifyConnection();
      const status = typeof cursorSdkRuntime.getRuntimeStatus === 'function'
        ? cursorSdkRuntime.getRuntimeStatus()
        : {};

      return res.json({
        success: true,
        configured: result.configured !== false,
        changed: false,
        requiresReload: false,
        bridge: { kind: 'cursor-sdk' },
        sdkAuthConfigured: result.sdkAuthConfigured ?? status?.sdkAuthConfigured ?? false,
        usageAuthConfigured: result.usageAuthConfigured ?? status?.usageAuthConfigured ?? false,
        ...result,
      });
    } catch (error) {
      console.error('Failed to configure Cursor provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to configure Cursor provider' });
    }
  });

  const resolveRequestDirectory = async (req) => {
    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requestedDirectory = headerDirectory || queryDirectory || null;
    if (!requestedDirectory) {
      return getOpenCodeWorkingDirectory();
    }
    const resolved = await resolveProjectDirectory(req);
    return resolved.directory || null;
  };

  app.get('/api/session', async (req, res, next) => {
    try {
      const directory = await resolveRequestDirectory(req);
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          void standardSessionTitleRuntime.schedulePlaceholderRecovery?.({ directory });
        }
      });
      return next();
    } catch (error) {
      return next(error);
    }
  });

  const mergeCursorProvider = async (payload) => {
    if (
      !cursorSdkRuntime
      || (
        typeof cursorSdkRuntime.getCachedVirtualProvider !== 'function'
        && typeof cursorSdkRuntime.getVirtualProvider !== 'function'
      )
    ) {
      return payload;
    }
    const virtualProvider = (() => {
      if (typeof cursorSdkRuntime.getCachedVirtualProvider === 'function') {
        if (typeof cursorSdkRuntime.refreshVirtualProvider === 'function') {
          cursorSdkRuntime.refreshVirtualProvider({ reason: 'providers_route' }).catch((error) => {
            console.warn('[CursorSDK] Failed to refresh Cursor provider metadata:', error);
          });
        }
        return cursorSdkRuntime.getCachedVirtualProvider();
      }
      return null;
    })() || (typeof cursorSdkRuntime.getVirtualProvider === 'function' ? await Promise.race([
      cursorSdkRuntime.getVirtualProvider(),
      new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 250);
        timeout.unref?.();
      }),
    ]) : null);
    if (!virtualProvider || typeof virtualProvider !== 'object') {
      return payload;
    }
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    const nextProviders = providers.filter((provider) => provider?.id !== CURSOR_ACP_PROVIDER_ID);
    nextProviders.push(virtualProvider);
    return {
      ...(payload && typeof payload === 'object' ? payload : {}),
      providers: nextProviders,
      default: payload?.default && typeof payload.default === 'object' ? payload.default : {},
    };
  };

  const mergeProviderIntegrations = async (payload, req) => {
    const directory = await resolveRequestDirectory(req);
    const githubCopilotSources = getProviderSources(GITHUB_COPILOT_PROVIDER_ID, directory);
    const sourceMap = githubCopilotSources?.sources || {};
    const githubCopilotConfiguredBySource = ['user', 'project', 'custom'].some((scope) => (
      sourceMap?.[scope]?.exists === true
    ));
    const githubCopilotConfigured = githubCopilotConfiguredBySource
      || await hasProviderAuthForLookupIds(getProviderIntegrationLookupIds(GITHUB_COPILOT_PROVIDER_ID));
    let githubCopilotModels;
    if (githubCopilotConfigured && !hasGitHubCopilotProviderModels(payload)) {
      const { readAuthFile } = await getAuthLibrary();
      const discovery = await discoverGitHubCopilotModels({ readAuthFile, fetchImpl: fetch });
      if (discovery.source !== 'unavailable') {
        githubCopilotModels = discovery.models;
      }
    }
    const withGitHubCopilot = mergeGitHubCopilotProvider(payload, {
      configured: githubCopilotConfigured,
      models: githubCopilotModels,
    });
    let withOpenAIAvailability = withGitHubCopilot;
    if (!isExternalOpenCode()) {
      const { readAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      withOpenAIAvailability = annotateOpenAIModelAvailability(withGitHubCopilot, auth?.openai);
    }
    return mergeCursorProvider(withOpenAIAvailability);
  };

  const touchOpenCodeSessionForCursorPrompt = async ({ sessionID, directory }) => {
    if (typeof buildOpenCodeUrl !== 'function') {
      return;
    }

    const query = typeof directory === 'string' && directory.trim()
      ? `?directory=${encodeURIComponent(directory.trim())}`
      : '';
    try {
      await fetch(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}${query}`, ''), {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        body: JSON.stringify({ time: { archived: 0 } }),
      });
    } catch (error) {
      console.warn('[CursorSDK] Failed to refresh OpenCode session metadata:', error);
    }
  };

  app.get('/api/config/providers', async (req, res) => {
    let upstreamPayload = { providers: [], default: {} };
    if (typeof buildOpenCodeUrl === 'function') {
      try {
        const query = req.originalUrl?.includes('?') ? `?${req.originalUrl.split('?').slice(1).join('?')}` : '';
        const response = await fetch(buildOpenCodeUrl(`/config/providers${query}`, ''), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
        });
        if (response.ok) {
          const parsed = await response.json().catch(() => null);
          if (parsed && typeof parsed === 'object') {
            upstreamPayload = parsed;
            void xaiToolCatalogRuntime?.refreshProviderPayload?.({
              directory: typeof req.query?.directory === 'string' ? req.query.directory : undefined,
              payload: parsed,
            });
          }
        }
      } catch {
        // Cursor remains visible even if OpenCode provider discovery is unavailable.
      }
    }

    try {
      return res.json(await mergeProviderIntegrations(upstreamPayload, req));
    } catch (error) {
      // Provider integrations (Copilot/Cursor discovery, auth reads) are best-effort.
      // If merging fails, still return the upstream provider list so the UI never
      // blanks the entire provider list or persists an empty snapshot.
      console.error('Failed to merge provider integrations:', error);
      return res.json(upstreamPayload);
    }
  });

  app.get('/api/session/status', async (req, res, next) => {
    try {
      const cursorStatuses = cursorSdkRuntime && typeof cursorSdkRuntime.getSessionStatus === 'function'
        ? cursorSdkRuntime.getSessionStatus()
        : {};
      const hasCursorStatuses = cursorStatuses && Object.keys(cursorStatuses).length > 0;
      if (typeof buildOpenCodeUrl !== 'function') {
        return hasCursorStatuses ? res.json(cursorStatuses) : next();
      }

      const upstreamPath = req.originalUrl?.startsWith('/api')
        ? req.originalUrl.slice(4) || '/'
        : req.originalUrl || '/session/status';
      let upstreamStatuses = {};
      let upstreamResponded = false;
      try {
        const response = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
        });
        upstreamResponded = true;
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            upstreamStatuses = payload;
          }
        } else if (!hasCursorStatuses) {
          const text = await response.text().catch(() => '');
          return res.status(response.status).send(text);
        }
      } catch {
        if (!hasCursorStatuses) {
          return next();
        }
      }

      if (!upstreamResponded && !hasCursorStatuses) {
        return next();
      }

      return res.json({
        ...upstreamStatuses,
        ...cursorStatuses,
      });
    } catch (error) {
      console.error('Failed to merge Cursor SDK session status:', error);
      return next(error);
    }
  });

  app.post('/api/session/:sessionID/prompt_async', (req, _res, next) => {
    const providerID = typeof req.body?.model?.providerID === 'string'
      ? req.body.model.providerID.trim()
      : '';
    const agent = typeof req.body?.agent === 'string' ? req.body.agent : '';
    const toolOverrides = resolveProviderPromptTools(providerID, agent);
    if (toolOverrides) {
      const existingTools = req.body?.tools && typeof req.body.tools === 'object' && !Array.isArray(req.body.tools)
        ? req.body.tools
        : {};
      req.body.tools = { ...existingTools, ...toolOverrides };
    }
    return next();
  });

  app.post('/api/session/:sessionID/prompt_async', async (req, res, next) => {
    const sessionID = req.params.sessionID;
    const providerID = typeof req.body?.model?.providerID === 'string'
      ? req.body.model.providerID.trim()
      : '';
    const modelID = typeof req.body?.model?.modelID === 'string'
      ? req.body.model.modelID.trim()
      : '';
    if (!providerID || providerID === CURSOR_ACP_PROVIDER_ID) {
      return next();
    }

    try {
      const directory = await resolveRequestDirectory(req);
      const isXaiProvider = xaiToolCatalogRuntime?.supportsProvider?.(providerID) === true;
      let cachedXaiTools = isXaiProvider
        ? xaiToolCatalogRuntime?.getPromptToolOverrides?.({ directory, providerID, modelID })
        : null;
      if (isXaiProvider && cachedXaiTools === null) {
        // Cold start: without this bounded warm, the first xai prompt ships the
        // full duplicated MCP tool catalog (the dedupe overrides only existed
        // after the first response finished). Cap the wait so prompt acceptance
        // is never delayed more than XAI_TOOL_CATALOG_COLD_START_WAIT_MS.
        // The startup + periodic catalog warms should keep this path cold-free;
        // the log below is the regression signal when they stop doing so.
        const coldWaitStartedAt = Date.now();
        await Promise.race([
          Promise.resolve(
            xaiToolCatalogRuntime?.refreshModel?.({ directory, providerID, modelID }),
          ).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, XAI_TOOL_CATALOG_COLD_START_WAIT_MS)),
        ]);
        cachedXaiTools = xaiToolCatalogRuntime?.getPromptToolOverrides?.({ directory, providerID, modelID }) ?? null;
        console.warn('[XaiTools] cold-start wait engaged', {
          directory,
          modelID,
          waitedMs: Date.now() - coldWaitStartedAt,
        });
      }
      if (cachedXaiTools && Object.keys(cachedXaiTools).length > 0) {
        const existingTools = req.body?.tools && typeof req.body.tools === 'object' && !Array.isArray(req.body.tools)
          ? req.body.tools
          : {};
        req.body.tools = { ...existingTools, ...cachedXaiTools };
      }
      const text = (Array.isArray(req.body?.parts) ? req.body.parts : [])
        .filter((part) => part?.type === 'text' && part?.synthetic !== true)
        .map((part) => typeof part.text === 'string' ? part.text.trim() : '')
        .filter(Boolean)
        .join(' ');
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          void standardSessionTitleRuntime.schedule({
            sessionID,
            directory,
            text,
            providerID,
            modelID,
            variant: typeof req.body?.variant === 'string' ? req.body.variant.trim() : undefined,
          });
          if (isXaiProvider && cachedXaiTools === null) {
            void xaiToolCatalogRuntime?.refreshModel?.({ directory, providerID, modelID });
          }
        }
      });
      return next();
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/session/:sessionID/prompt_async', async (req, res, next) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.handlePromptAsync !== 'function') {
        return next();
      }
      const directory = await resolveRequestDirectory(req);
      const result = await cursorSdkRuntime.handlePromptAsync({
        sessionID: req.params.sessionID,
        body: req.body || {},
        directory,
      });
      if (!result?.handled) {
        return next();
      }
      await touchOpenCodeSessionForCursorPrompt({
        sessionID: req.params.sessionID,
        directory,
      });
      const handledStatus = result.status || 200;
      if (handledStatus >= 200 && handledStatus < 300) {
        void cursorSessionTitleRuntime.schedule({
          sessionID: req.params.sessionID,
          directory,
        });
      }
      if (result.status === 204) {
        return res.status(204).end();
      }
      return res.status(result.status || 200).json(result.body || { ok: true });
    } catch (error) {
      console.error('Failed to run Cursor SDK prompt:', error);
      return res.status(500).json({ error: error.message || 'Failed to run Cursor SDK prompt' });
    }
  });

  app.post('/api/session/:sessionID/abort', async (req, res, next) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.abortSession !== 'function') {
        return next();
      }
      const aborted = await cursorSdkRuntime.abortSession(req.params.sessionID);
      if (!aborted) {
        return next();
      }
      return res.json({ success: true, aborted: true });
    } catch (error) {
      console.error('Failed to abort Cursor SDK prompt:', error);
      return res.status(500).json({ error: error.message || 'Failed to abort Cursor SDK prompt' });
    }
  });

  app.delete('/api/session/:sessionID', (req, res, next) => {
    if (cursorSdkRuntime && typeof cursorSdkRuntime.deleteSessionState === 'function') {
      const { sessionID } = req.params;
      // Clean up only after the proxied OpenCode deletion succeeded, so a
      // failed delete does not orphan the session from its Cursor agent.
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cursorSdkRuntime.deleteSessionState(sessionID).catch((error) => {
            console.warn('[CursorSDK] Failed to clean up deleted session state:', error);
          });
        }
      });
    }
    return next();
  });

  app.all('/api/session/:sessionID/message', async (req, res, next) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.getSessionMessages !== 'function') {
        return next();
      }
      const cursorRecords = await cursorSdkRuntime.getSessionMessages(req.params.sessionID);
      if (!Array.isArray(cursorRecords) || cursorRecords.length === 0) {
        return next();
      }

      let upstreamRecords = [];
      if (typeof buildOpenCodeUrl === 'function') {
        try {
          const upstreamPath = req.originalUrl.startsWith('/api')
            ? req.originalUrl.slice(4) || '/'
            : req.originalUrl;
          const response = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
            method: req.method,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              ...getOpenCodeAuthHeaders(),
            },
            body: req.method === 'GET' || req.method === 'HEAD'
              ? undefined
              : JSON.stringify(req.body || {}),
          });
          if (response.ok) {
            const payload = await response.json().catch(() => null);
            upstreamRecords = Array.isArray(payload) ? payload : [];
          }
        } catch {
          upstreamRecords = [];
        }
      }

      // This route shadows the proxy's stripping route for Cursor-backed
      // sessions, so it must apply the same diff-body strip: a workspace diff
      // snapshot can make an unstripped transcript ~92MB (see diff-summary.js).
      // Strip per-record as entries land so the unstripped payload is released
      // as early as possible.
      const byId = new Map();
      for (const record of upstreamRecords) {
        if (record?.info?.id) byId.set(record.info.id, stripMessageDiffContent(record));
      }
      upstreamRecords = [];
      for (const record of cursorRecords) {
        if (record?.info?.id) byId.set(record.info.id, stripMessageDiffContent(record));
      }
      return res.json(Array.from(byId.values()).sort((left, right) => (
        String(left?.info?.id || '').localeCompare(String(right?.info?.id || ''))
      )));
    } catch (error) {
      console.error('Failed to merge Cursor SDK messages:', error);
      return next();
    }
  });

  app.get('/api/provider/cursor-acp/usage-auth/status', async (_req, res) => {
    try {
      return res.json({ configured: await readCursorUsageAuthConfigured() });
    } catch (error) {
      console.error('Failed to read Cursor usage auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to read Cursor usage auth status' });
    }
  });

  app.put('/api/provider/cursor-acp/usage-auth', async (req, res) => {
    try {
      const sessionToken = normalizeCursorUsageSessionToken(req.body?.sessionToken);
      if (!sessionToken) {
        return res.status(400).json({ error: 'Cursor usage session token is required.' });
      }

      const { readAuthFile, writeAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      const existing = auth?.[CURSOR_ACP_PROVIDER_ID] && typeof auth[CURSOR_ACP_PROVIDER_ID] === 'object'
        ? auth[CURSOR_ACP_PROVIDER_ID]
        : {};
      writeAuthFile({
        ...auth,
        [CURSOR_ACP_PROVIDER_ID]: {
          ...existing,
          usageSessionToken: sessionToken,
        },
      });

      return res.json({ success: true, configured: true });
    } catch (error) {
      console.error('Failed to save Cursor usage auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to save Cursor usage auth' });
    }
  });

  app.delete('/api/provider/cursor-acp/usage-auth', async (_req, res) => {
    try {
      const { readAuthFile, writeAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      const existing = auth?.[CURSOR_ACP_PROVIDER_ID] && typeof auth[CURSOR_ACP_PROVIDER_ID] === 'object'
        ? { ...auth[CURSOR_ACP_PROVIDER_ID] }
        : {};
      delete existing.usageSessionToken;
      writeAuthFile({
        ...auth,
        [CURSOR_ACP_PROVIDER_ID]: existing,
      });

      return res.json({ success: true, configured: false });
    } catch (error) {
      console.error('Failed to clear Cursor usage auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear Cursor usage auth' });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      if (requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      }

      return res.json({
        providerId,
        sources: await readProviderSourceSnapshot(providerId, directory),
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || (scope === 'all' && requestedDirectory)) {
        if (!requestedDirectory) {
          return res.status(400).json({ error: 'Working directory is required for project scope' });
        }
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      }

      const removedSources = {
        auth: false,
        user: false,
        project: false,
        custom: false,
      };
      if (scope === 'auth') {
        if (providerId === CURSOR_ACP_PROVIDER_ID) {
          const auth = await getAuthLibrary();
          removedSources.auth = clearCursorSdkAuth({ readAuth: auth.readAuthFile, writeAuth: auth.writeAuthFile });
        } else {
          removedSources.auth = providerId === ANTIGRAVITY_PROVIDER_ID
            ? await removeAntigravityAccounts()
            : await removeProviderAuthForLookupIds(getProviderIntegrationLookupIds(providerId));
        }
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removedSources[scope] = removeProviderConfigForScope(providerId, directory, scope);
      } else if (scope === 'all') {
        const auth = await getAuthLibrary();
        removedSources.auth = providerId === CURSOR_ACP_PROVIDER_ID
          ? clearCursorSdkAuth({ readAuth: auth.readAuthFile, writeAuth: auth.writeAuthFile })
          : providerId === ANTIGRAVITY_PROVIDER_ID
            ? await removeAntigravityAccounts()
            : await removeProviderAuthForLookupIds(getProviderIntegrationLookupIds(providerId));
        removedSources.user = removeProviderConfigForScope(providerId, null, 'user');
        removedSources.custom = removeProviderConfigForScope(providerId, null, 'custom');
        removedSources.project = directory
          ? removeProviderConfigForScope(providerId, directory, 'project')
          : false;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      const removed = Object.values(removedSources).some(Boolean);

      const applyResult = await markConfigChange(
        `provider ${providerId} disconnected (${scope})`,
        { providerId, scope },
        true,
      );
      const sources = await readProviderSourceSnapshot(providerId, directory);

      return res.json({
        success: true,
        removed,
        removedSources,
        sources,
        ...applyResult,
        message: removed
          ? 'Provider configuration removed; runtime refresh requested'
          : 'No stored provider configuration was found; runtime refresh requested',
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });
      if (!directoriesMatch(getOpenCodeWorkingDirectory(), resolvedPath)) {
        setOpenCodeWorkingDirectory(resolvedPath);
      }

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });

};
