import { createProjectIdFromPath } from '../projects/project-id.js';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  clearCursorSdkAuth,
  saveCursorSdkAuth,
} from '@openchamber/cursor-sdk-runtime';
import {
  GITHUB_COPILOT_PROVIDER_ID,
  getProviderIntegrationLookupIds,
  hasGitHubCopilotProviderModels,
  isGitHubCopilotProviderId,
  mergeGitHubCopilotProvider,
} from './provider-integrations.js';
import { annotateOpenAIModelAvailability } from './openai-model-availability.js';
import { discoverGitHubCopilotModels } from './github-copilot-models.js';
import { createCursorSessionTitleRuntime } from './cursor-session-title-runtime.js';
import { createStandardSessionTitleRuntime } from './standard-session-title-runtime.js';

const ANTHROPIC_PROVIDER_IDS = new Set(['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude']);
const ANTIGRAVITY_PROVIDER_ID = 'antigravity';
const CURSOR_ACP_PROVIDER_ID = 'cursor-acp';
const CURSOR_USAGE_TOKEN_MAX_LENGTH = 16_384;
const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
const OPENCODE_GO_WORKSPACE_ID_PATTERN = /^wrk_[a-zA-Z0-9]+$/;
const OPENCODE_GO_USAGE_COOKIE_MAX_LENGTH = 16_384;
const CLAUDE_AUTH_CHECK_TIMEOUT_MS = 45000;
const CLAUDE_AUTH_CHECK_PROMPT = 'Reply with exactly: OK';

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

const isExecutableFile = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const searchPathForExecutable = (binaryName, pathValue) => {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) return null;

  const parts = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const candidateNames = [trimmed];

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
    for (const ext of pathExt.split(';')) {
      const normalizedExt = ext.trim();
      if (!normalizedExt) continue;
      const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
        candidateNames.push(candidateName);
      }
    }
  }

  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
};

const runClaudeCliAuthCheck = ({ executable, pathValue, spawnImpl = spawn }) => new Promise((resolve) => {
  let settled = false;
  let stderr = '';
  let timer = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(result);
  };

  const child = spawnImpl(executable, ['-p', CLAUDE_AUTH_CHECK_PROMPT, '--output-format', 'text'], {
    env: { ...process.env, PATH: pathValue },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  timer = setTimeout(() => {
    child.kill?.('SIGTERM');
    finish({ ok: false, error: 'Timed out while checking Claude OAuth.' });
  }, CLAUDE_AUTH_CHECK_TIMEOUT_MS);

  child.stderr?.on?.('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 2000) {
      stderr = stderr.slice(-2000);
    }
  });

  child.on?.('error', (error) => {
    finish({
      ok: false,
      error: error?.code === 'ENOENT'
        ? 'Claude CLI was not found on PATH.'
        : error instanceof Error
          ? error.message
          : 'Failed to check Claude OAuth with the Claude CLI.',
    });
  });

  child.on?.('close', (code) => {
    if (code === 0) {
      finish({ ok: true });
      return;
    }

    finish({
      ok: false,
      error: stderr.trim() || `Claude CLI exited with code ${code}.`,
    });
  });
});

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    clientReloadDelayMs,
    getOpenCodeResolutionSnapshot,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    ensureAnthropicOAuthProviderConfig,
    refreshOpenCodeAfterConfigChange,
    buildAugmentedPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders = () => ({}),
    getOpenCodeWorkingDirectory = () => null,
    setOpenCodeWorkingDirectory = () => {},
    isExternalOpenCode = () => false,
    cursorSdkRuntime = null,
    cursorSessionTitleRuntime: injectedCursorSessionTitleRuntime = null,
    standardSessionTitleRuntime: injectedStandardSessionTitleRuntime = null,
    resolveZenModel = async () => undefined,
    authLibrary: injectedAuthLibrary = null,
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
    resolveZenModel,
    logger: console,
  });

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

  const readOpenCodeGoUsageAuthStatus = async () => {
    const { readAuthFile } = await getAuthLibrary();
    const auth = readAuthFile();
    const entry = auth?.[OPENCODE_GO_PROVIDER_ID];
    const workspaceId = typeof entry?.usageWorkspaceId === 'string' ? entry.usageWorkspaceId.trim() : '';
    const authCookie = typeof entry?.usageAuthCookie === 'string' ? entry.usageAuthCookie.trim() : '';
    return {
      configured: Boolean(workspaceId && authCookie),
      workspaceId: workspaceId || null,
    };
  };

  const normalizeOpenCodeGoWorkspaceId = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const workspaceId = value.trim();
    if (!OPENCODE_GO_WORKSPACE_ID_PATTERN.test(workspaceId)) {
      return null;
    }
    return workspaceId;
  };

  const normalizeOpenCodeGoAuthCookie = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const authCookie = value.trim();
    if (!authCookie || authCookie.length > OPENCODE_GO_USAGE_COOKIE_MAX_LENGTH) {
      return null;
    }
    return authCookie;
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

  app.put('/api/config/settings', async (req, res) => {
    console.log('[API:PUT /api/config/settings] Received request');
    try {
      const updated = await persistSettings(req.body ?? {});
      console.log(`[API:PUT /api/config/settings] Success, returning ${updated.projects?.length || 0} projects`);
      res.json(updated);
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
      const executable = searchPathForExecutable('claude', pathValue);
      return res.json({ installed: Boolean(executable), path: executable });
    } catch (error) {
      console.error('Failed to check Claude CLI availability:', error);
      return res.status(500).json({ error: error.message || 'Failed to check Claude CLI availability' });
    }
  });

  app.post('/api/provider/anthropic/check-oauth', async (req, res) => {
    try {
      const pathValue = typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
        : process.env.PATH || '';
      const executable = searchPathForExecutable('claude', pathValue);
      if (!executable) {
        return res.status(400).json({
          code: 'claude_cli_unavailable',
          error: 'Claude CLI is not installed or is not available on PATH.',
        });
      }

      const authCheck = await runClaudeCliAuthCheck({ executable, pathValue });
      if (!authCheck.ok) {
        return res.status(400).json({
          code: 'claude_cli_unauthenticated',
          error: authCheck.error || 'Claude OAuth check failed.',
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
      if (result.changed) {
        await refreshOpenCodeAfterConfigChange('anthropic oauth provider configured');
      }

      return res.json({
        success: true,
        configured: true,
        changed: result.changed,
        path: result.path,
        requiresReload: result.changed,
        reloadDelayMs: result.changed ? clientReloadDelayMs : undefined,
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

  app.post('/api/session/:sessionID/prompt_async', async (req, res, next) => {
    const sessionID = req.params.sessionID;
    const providerID = typeof req.body?.model?.providerID === 'string'
      ? req.body.model.providerID.trim()
      : '';
    if (!providerID || providerID === CURSOR_ACP_PROVIDER_ID) {
      return next();
    }

    try {
      const directory = await resolveRequestDirectory(req);
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
          });
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

      const byId = new Map();
      for (const record of upstreamRecords) {
        if (record?.info?.id) byId.set(record.info.id, record);
      }
      for (const record of cursorRecords) {
        if (record?.info?.id) byId.set(record.info.id, record);
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

  app.get('/api/provider/opencode-go/usage-auth/status', async (_req, res) => {
    try {
      return res.json(await readOpenCodeGoUsageAuthStatus());
    } catch (error) {
      console.error('Failed to read OpenCode Go usage auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to read OpenCode Go usage auth status' });
    }
  });

  app.put('/api/provider/opencode-go/usage-auth', async (req, res) => {
    try {
      const workspaceId = normalizeOpenCodeGoWorkspaceId(req.body?.workspaceId);
      const authCookie = normalizeOpenCodeGoAuthCookie(req.body?.authCookie);
      if (!workspaceId) {
        return res.status(400).json({ error: 'A valid OpenCode Go workspace ID is required.' });
      }
      if (!authCookie) {
        return res.status(400).json({ error: 'OpenCode Go auth cookie is required.' });
      }

      const { readAuthFile, writeAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      const existing = auth?.[OPENCODE_GO_PROVIDER_ID] && typeof auth[OPENCODE_GO_PROVIDER_ID] === 'object'
        ? auth[OPENCODE_GO_PROVIDER_ID]
        : {};
      writeAuthFile({
        ...auth,
        [OPENCODE_GO_PROVIDER_ID]: {
          ...existing,
          usageWorkspaceId: workspaceId,
          usageAuthCookie: authCookie,
        },
      });

      return res.json({ success: true, configured: true, workspaceId });
    } catch (error) {
      console.error('Failed to save OpenCode Go usage auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to save OpenCode Go usage auth' });
    }
  });

  app.delete('/api/provider/opencode-go/usage-auth', async (_req, res) => {
    try {
      const { readAuthFile, writeAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      const existing = auth?.[OPENCODE_GO_PROVIDER_ID] && typeof auth[OPENCODE_GO_PROVIDER_ID] === 'object'
        ? { ...auth[OPENCODE_GO_PROVIDER_ID] }
        : {};
      delete existing.usageWorkspaceId;
      delete existing.usageAuthCookie;
      writeAuthFile({
        ...auth,
        [OPENCODE_GO_PROVIDER_ID]: existing,
      });

      return res.json({ success: true, configured: false, workspaceId: null });
    } catch (error) {
      console.error('Failed to clear OpenCode Go usage auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear OpenCode Go usage auth' });
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

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      const authLookupIds = ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude'].includes(providerId)
        ? [providerId, 'anthropic', 'claude']
        : isGitHubCopilotProviderId(providerId)
        ? getProviderIntegrationLookupIds(providerId)
        : [providerId];
      const auth = authLookupIds.map((id) => getProviderAuth(id)).find(Boolean);
      if (providerId === CURSOR_ACP_PROVIDER_ID) {
        sources.sources.auth.exists = Boolean(
          (typeof process.env.CURSOR_API_KEY === 'string' && process.env.CURSOR_API_KEY.trim()) ||
          (auth && typeof auth === 'object' && (
            (typeof auth.key === 'string' && auth.key.trim()) ||
            (typeof auth.token === 'string' && auth.token.trim())
          ))
        );
      } else {
        sources.sources.auth.exists = Boolean(auth);
      }
      if (providerId === ANTIGRAVITY_PROVIDER_ID) {
        sources.sources.auth = await getAntigravityAccountsSource();
      }

      return res.json({
        providerId,
        sources: sources.sources,
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

      if (scope === 'project') {
        if (!requestedDirectory) {
          return res.status(400).json({ error: 'Working directory is required for project scope' });
        }
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      }

      let removed = false;
      if (scope === 'auth') {
        if (providerId === CURSOR_ACP_PROVIDER_ID) {
          const auth = await getAuthLibrary();
          removed = clearCursorSdkAuth({ readAuth: auth.readAuthFile, writeAuth: auth.writeAuthFile });
        } else {
          removed = providerId === ANTIGRAVITY_PROVIDER_ID
          ? await removeAntigravityAccounts()
          : await removeProviderAuthForLookupIds(getProviderIntegrationLookupIds(providerId));
        }
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const auth = await getAuthLibrary();
        const authRemoved = providerId === CURSOR_ACP_PROVIDER_ID
          ? clearCursorSdkAuth({ readAuth: auth.readAuthFile, writeAuth: auth.writeAuthFile })
          : providerId === ANTIGRAVITY_PROVIDER_ID
          ? await removeAntigravityAccounts()
          : await removeProviderAuthForLookupIds(getProviderIntegrationLookupIds(providerId));
        const userRemoved = removeProviderConfig(providerId, null, 'user');
        const customRemoved = removeProviderConfig(providerId, null, 'custom');
        removed = authRemoved || userRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        await refreshOpenCodeAfterConfigChange(`provider ${providerId} disconnected (${scope})`);
      }

      return res.json({
        success: true,
        removed,
        requiresReload: removed,
        message: removed ? 'Provider disconnected successfully' : 'Provider was not connected',
        reloadDelayMs: removed ? clientReloadDelayMs : undefined,
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

  // Behavior / Global AGENTS.md endpoints
  const AGENTS_MD_PATH = path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      try {
        await fs.promises.access(AGENTS_MD_PATH);
      } catch {
        return res.json({ content: '', exists: false });
      }
      const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
      return res.json({ content, exists: true });
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(AGENTS_MD_PATH);
      try {
        await fs.promises.access(parentDir);
      } catch {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');

      // Refresh OpenCode so it picks up the new AGENTS.md without a full restart
      try {
        await refreshOpenCodeAfterConfigChange('global behavior (AGENTS.md) updated');
      } catch {
        // Non-fatal: file was written successfully
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
