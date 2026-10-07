import {inspectClaudeRequest,isClaudeInspectionUnavailable,unavailableClaudeInspection,sendClaudeInspectionError} from './runtime-host/native-claude-inspection.js';
import express from 'express';
import { isDirectLocalRequest } from '../security/direct-local-request.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import fs from 'fs';
import { OPENCODE_CONFIG_DIR } from './shared.js';
import path from 'path';
import { clearCursorSdkAuth } from '@openchamber/cursor-sdk-runtime';
import { resolveProviderPromptTools } from '@openchamber/orchestration-runtime';
import {
  GITHUB_COPILOT_PROVIDER_ID,
  getProviderIntegrationLookupIds,
  hasGitHubCopilotProviderModels,
  isGitHubCopilotProviderId,
  listProviderCredentialEnvKeys,
  mergeGitHubCopilotProvider,
} from './provider-integrations.js';
import { annotateOpenAIModelAvailability } from './openai-model-availability.js';
import { resolveSiwcAccountModels } from './openai-siwc-model-catalog.js';
import { readNativeOpenAiSelection } from './chatgpt-siwc-host.js';
import { annotateModelDefaultThinking } from './model-default-thinking.js';
import { stripMessageDiffContent } from './diff-summary.js';
import { discoverGitHubCopilotModels } from './github-copilot-models.js';
import { createCursorSessionTitleRuntime } from './cursor-session-title-runtime.js';
import { createStandardSessionTitleRuntime } from './standard-session-title-runtime.js';
import { registerQuestionRoutes } from './question-routes.js';
import { resolveGen2OpenCodeClient } from './opencode-client-seam.js';
import { readFacadeMessagePage, resolveFacadeDirectory, sendOpenCodeFacadeError, validateFacadeBody } from './v2/facade-routes.js';
import { createGlobalAgentsMdRuntime } from './global-agents-md-runtime.js';
import { registerGlobalAgentsMdRoutes } from './global-agents-md-routes.js';
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

const listDefaultAntigravityAccountsPaths = async () => {
  const { listAntigravityAccountsPaths } = await import('../quota/utils/index.js');
  return listAntigravityAccountsPaths();
};

const getAntigravityAccountsSource = async (listAccountsPaths) => {
  const { readJsonFile } = await import('../quota/utils/index.js');
  for (const filePath of await listAccountsPaths()) {
    const data = readJsonFile(filePath);
    if (Array.isArray(data?.accounts) && data.accounts.length > 0) {
      return { exists: true, path: filePath };
    }
  }
  return { exists: false, path: null };
};

const removeAntigravityAccounts = async (listAccountsPaths) => {
  let removed = false;
  for (const filePath of await listAccountsPaths()) {
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
    ensureNativeDirectory,
    resolveProjectDirectory,
    getProviderSources,
    removeAntigravityProviderConfig = () => false,
    removeProviderConfig,
    listProviderConfigFiles = () => [],
    getProviderEnvironmentSnapshot = () => ({}),
    // Injected in tests so they never touch the user's real account files.
    listAntigravityAccountsPaths = listDefaultAntigravityAccountsPaths,
    markConfigChange,
    buildOpenCodeUrl,
    openCodeClient,
    getNativeRuntimeOwner = () => null,
    getClaudeEnrollmentOwner = () => null,
    getChatgptSiwcEnrollmentOwner = () => null,
    isProviderAdministrator = () => false,
    getOpenCodeAuthHeaders = () => ({}),
    getOpenCodeWorkingDirectory = () => null,
    setOpenCodeWorkingDirectory = () => {},
    isExternalOpenCode = () => false,
    cursorSdkRuntime = null,
    processesRuntime = null,
    cursorSessionTitleRuntime: injectedCursorSessionTitleRuntime = null,
    standardSessionTitleRuntime: injectedStandardSessionTitleRuntime = null,
    xaiToolCatalogRuntime = null,
    globalAgentsMdRuntime: injectedGlobalAgentsMdRuntime = null,
    resolveZenModel = async () => undefined,
    resolveZenModelNonBlocking = () => ({}),
    authLibrary: injectedAuthLibrary = null,
    readClaudePromptMode = readMeridianPromptMode,
    setClaudePromptCompatibilityMode = setMeridianPromptCompatibilityMode,
  } = dependencies;

  const cursorSessionTitleRuntime = injectedCursorSessionTitleRuntime || createCursorSessionTitleRuntime({
    openCodeClient,
    cursorSdkRuntime,
    fetchImpl: fetch,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    logger: console,
  });
  const standardSessionTitleRuntime = injectedStandardSessionTitleRuntime || createStandardSessionTitleRuntime({
    openCodeClient,
    fetchImpl: fetch,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    logger: console,
  });
  const globalAgentsMdRuntime = injectedGlobalAgentsMdRuntime || createGlobalAgentsMdRuntime({
    agentsMdPath: path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md'),
    refreshRuntime: ({ changed } = {}) => markConfigChange(
      'global behavior (AGENTS.md) updated',
      {},
      changed !== false,
    ),
    isEditable: () => !isExternalOpenCode(),
  });

  registerQuestionRoutes(app, {
    openCodeClient,
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

  const nativeProviderOwner = (providerId) => {
    if (!['openai', CURSOR_ACP_PROVIDER_ID, 'xai', 'opencode', 'opencode-go'].includes(providerId)) return null;
    resolveGen2OpenCodeClient(openCodeClient);
    const owner = getNativeRuntimeOwner();
    if (typeof owner?.withProviderConfigurationAuthorization !== 'function') {
      throw Object.assign(new Error('Native provider configuration owner unavailable'), { code: 'native_provider_configuration_owner_required', statusCode: 503 });
    }
    return owner;
  };
  const readProviderSourceSnapshot = async (providerId, directory) => {
    const native = nativeProviderOwner(providerId);
    if (native) return native.withProviderConfigurationAuthorization({ providerID: providerId, directory, scope: 'read' }, async owner => ({
      ...owner.readSources(), auth: await owner.readAuthenticationSource(),
    }));
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
      result.sources.auth = await getAntigravityAccountsSource(listAntigravityAccountsPaths);
    }
    return result.sources;
  };

  const removeProviderConfigForScope = (providerId, directory, scope) => (
    providerId === ANTIGRAVITY_PROVIDER_ID
      ? removeAntigravityProviderConfig(directory, scope)
      : removeProviderConfig(providerId, directory, scope)
  );

  // What still supplies a provider after a disconnect. OpenCode merges every
  // config layer, the auth store, and credential env vars, so a removal is
  // verified against all of them instead of being assumed to have worked.
  const listRemainingProviderSources = async (providerId, directory) => {
    const remaining = listProviderConfigFiles(providerId, directory)
      .map((filePath) => ({ type: 'config', path: filePath }));
    if (providerId === ANTIGRAVITY_PROVIDER_ID) {
      const accounts = await getAntigravityAccountsSource(listAntigravityAccountsPaths);
      if (accounts.exists) remaining.push({ type: 'auth', path: accounts.path });
      return remaining;
    }
    if (providerId !== CURSOR_ACP_PROVIDER_ID
      && await hasProviderAuthForLookupIds(getProviderIntegrationLookupIds(providerId))) {
      remaining.push({ type: 'auth', path: null });
    }
    const environment = { ...(getProviderEnvironmentSnapshot() || {}), ...process.env };
    for (const name of listProviderCredentialEnvKeys(providerId, environment)) {
      remaining.push({ type: 'env', name });
    }
    return remaining;
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

  app.post('/api/mcp/auth/pending', express.json({ limit: '16kb' }), async (req, res) => {
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

  app.get('/api/provider/anthropic/claude-cli', async (req, res) => {
    try {
      const directory=await resolveRequestDirectory(req);
      return res.json(await inspectClaudeRequest({req,res,kind:'status',directory,getNativeRuntimeOwner,isExternalOpenCode}));
    } catch(error) {
      if(isClaudeInspectionUnavailable(error?.code))return res.json(unavailableClaudeInspection('status',error.code));
      return sendClaudeInspectionError(res,error);
    }
  });

  const enrollmentAdmin=(req,res,next)=>isProviderAdministrator(req)?next():res.status(403).json({code:'native_claude_enrollment_administrator_required'});
  const enrollmentCsrf=(req,res,next)=>req.get('x-devryan-csrf')==='1'?next():res.status(403).json({code:'native_claude_enrollment_csrf_required'});
  const enrollmentBody=limit=>{const parse=express.json({limit});return(req,res,next)=>parse(req,res,error=>error?res.status(400).json({code:'native_claude_enrollment_request_invalid'}):next());};
  const emptyEnrollmentBody=body=>body===undefined||body!==null&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===0;
  const enrollmentReply=async(req,res,action)=>{
    try{
      const owner=getClaudeEnrollmentOwner();if(!owner) return res.status(409).json({code:'native_claude_enrollment_update_required'});
      const context={request:req,directory:await resolveRequestDirectory(req)};
      res.json(await action(owner,context));
    }catch(error){
      const code=/^native_claude_enrollment_[a-z_]+$/.test(error?.code??'')?error.code:'native_claude_enrollment_refused';
      res.status([400,403,404,409,503].includes(error?.status)?error.status:409).json({code});
    }
  };
  app.get('/api/provider/anthropic/enrollment',enrollmentAdmin,(req,res)=>enrollmentReply(req,res,async(owner,context)=>({accounts:await owner.list(context)})));
  app.post('/api/provider/anthropic/enrollment',enrollmentAdmin,enrollmentCsrf,enrollmentBody('12kb'),(req,res)=>enrollmentReply(req,res,async(owner,context)=>{
    if(!emptyEnrollmentBody(req.body))throw Object.assign(new Error('native_claude_enrollment_request_invalid'),{code:'native_claude_enrollment_request_invalid',status:400});
    return owner.begin(context);
  }));
  app.post('/api/provider/anthropic/enrollment/:id/complete',enrollmentAdmin,enrollmentCsrf,enrollmentBody('12kb'),(req,res)=>enrollmentReply(req,res,(owner,context)=>owner.complete(req.params.id,req.body,context)));
  app.post('/api/provider/anthropic/enrollment/:id/select',enrollmentAdmin,enrollmentCsrf,enrollmentBody('1kb'),(req,res)=>enrollmentReply(req,res,(owner,context)=>{
    if(!emptyEnrollmentBody(req.body))throw Object.assign(new Error('native_claude_enrollment_request_invalid'),{code:'native_claude_enrollment_request_invalid',status:400});
    return owner.select(req.params.id,context);
  }));

  const siwcLocal=(req,res,next)=>isDirectLocalRequest(req)?next():res.status(403).json({code:'native_chatgpt_siwc_local_required'});
  const siwcAdmin=(req,res,next)=>isProviderAdministrator(req)?next():res.status(403).json({code:'native_chatgpt_siwc_administrator_required'});
  const siwcCsrf=(req,res,next)=>req.get('x-devryan-csrf')==='1'?next():res.status(403).json({code:'native_chatgpt_siwc_csrf_required'});
  const siwcBody=limit=>{const parse=express.json({limit});return(req,res,next)=>parse(req,res,error=>error?res.status(400).json({code:'native_chatgpt_siwc_request_invalid'}):next());};
  const emptySiwcBody=body=>body===undefined||body!==null&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===0;
  const siwcSelectionBody=(body,allowRegistration=false)=>{
    if(body===undefined)body={};
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='expectedActiveCredentialID'&&(!allowRegistration||key!=='registrationRef'))
      ||body.expectedActiveCredentialID!==undefined&&body.expectedActiveCredentialID!==null&&(typeof body.expectedActiveCredentialID!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(body.expectedActiveCredentialID))
      ||body.registrationRef!==undefined&&(typeof body.registrationRef!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.registrationRef)))
      throw Object.assign(new Error('native_chatgpt_siwc_request_invalid'),{code:'native_chatgpt_siwc_request_invalid',status:400});
    return body;
  };
  const siwcReply=async(req,res,action)=>{
    try{
      const owner=getChatgptSiwcEnrollmentOwner();
      if(!owner) return res.status(409).json({code:'native_chatgpt_siwc_update_required'});
      const context={request:req,directory:await resolveRequestDirectory(req)};
      res.json(await action(owner,context));
    }catch(error){
      const code=/^native_chatgpt_siwc_[a-z_]+$/.test(error?.code??'')?error.code:'native_chatgpt_siwc_refused';
      res.status([400,403,404,408,409,503].includes(error?.status)?error.status:409).json({code,
        ...(['confirmed','unconfirmed','not_applicable'].includes(error?.remoteRevocation)?{remoteRevocation:error.remoteRevocation}:{}),
        ...(['complete','failed'].includes(error?.localCleanup)?{localCleanup:error.localCleanup}:{}),
      });
    }
  };
  app.get('/api/provider/openai/siwc',siwcLocal,siwcAdmin,(req,res)=>siwcReply(req,res,async(owner,context)=>owner.status(context)));
  app.post('/api/provider/openai/siwc',siwcLocal,siwcAdmin,siwcCsrf,siwcBody('4kb'),(req,res)=>siwcReply(req,res,async(owner,context)=>{
    return owner.begin({...context,...siwcSelectionBody(req.body,true)});
  }));
  app.post('/api/provider/openai/siwc/:id/complete',siwcLocal,siwcAdmin,siwcCsrf,siwcBody('4kb'),(req,res)=>siwcReply(req,res,(owner,context)=>{
    if(!emptySiwcBody(req.body))throw Object.assign(new Error('native_chatgpt_siwc_request_invalid'),{code:'native_chatgpt_siwc_request_invalid',status:400});
    return owner.complete(req.params.id,req.body,context);
  }));
  app.post('/api/provider/openai/siwc/:id/select',siwcLocal,siwcAdmin,siwcCsrf,siwcBody('4kb'),(req,res)=>siwcReply(req,res,(owner,context)=>{
    const body=siwcSelectionBody(req.body);
    if(body.expectedActiveCredentialID===undefined)throw Object.assign(new Error('native_chatgpt_siwc_request_invalid'),{code:'native_chatgpt_siwc_request_invalid',status:400});
    return owner.select(req.params.id,{...context,...body});
  }));
  app.delete('/api/provider/openai/siwc/:id',siwcLocal,siwcAdmin,siwcCsrf,(req,res)=>siwcReply(req,res,(owner,context)=>owner.cancel(req.params.id,context)));
  app.delete('/api/provider/openai/siwc',siwcLocal,siwcAdmin,siwcCsrf,siwcBody('4kb'),(req,res)=>siwcReply(req,res,(owner,context)=>{
    const body=siwcSelectionBody(req.body);
    if(body.expectedActiveCredentialID===undefined)throw Object.assign(new Error('native_chatgpt_siwc_request_invalid'),{code:'native_chatgpt_siwc_request_invalid',status:400});
    return owner.disconnect({...context,...body});
  }));

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
      const directory=await resolveRequestDirectory(req);
      const auth=await inspectClaudeRequest({req,res,kind:'status',directory,getNativeRuntimeOwner,isExternalOpenCode});
      return res.json({success:true,configured:true,changed:false,auth});
    } catch(error) {
      if(isClaudeInspectionUnavailable(error?.code))return res.status(400).json({code:error.code,error:'Selected Claude account is unavailable.'});
      return sendClaudeInspectionError(res,error);
    }
  });

  app.get('/api/provider/cursor-acp/runtime-status', async (req, res) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.getRuntimeStatus !== 'function') {
        return res.status(500).json({ error: 'Cursor SDK runtime is unavailable.' });
      }
      const status = cursorSdkRuntime.getRuntimeStatus();
      if (status.capabilities?.supported === false) return res.json(status);
      const native = nativeProviderOwner(CURSOR_ACP_PROVIDER_ID);
      if (!native) return res.json(status);
      const directory = await resolveRequestDirectory(req);
      const auth = await native.withProviderConfigurationAuthorization({ providerID: CURSOR_ACP_PROVIDER_ID, directory, scope: 'read' }, owner => owner.readAuthenticationSource());
      return res.json({ ...status, sdkAuthConfigured: auth.exists, authObservation: 'known' });
    } catch (error) {
      console.error('Failed to read Cursor runtime status:', error);
      return res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message || 'Failed to read Cursor runtime status', code: error.code });
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
      return res.status(error.statusCode ?? 500).json({ ok: false, error: error.message || 'Failed to prewarm Cursor session', code: error.code });
    }
  });

  app.post('/api/provider/cursor-acp/configure', async (req, res) => {
    try {
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.verifyConnection !== 'function') {
        return res.status(500).json({ error: 'Cursor SDK runtime is unavailable.' });
      }

      const result = await cursorSdkRuntime.verifyConnection({ directory: await resolveRequestDirectory(req) });
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
      return res.status(error.statusCode ?? 500).json({ error: error.message || 'Failed to configure Cursor provider', code: error.code });
    }
  });

  const resolveRequestDirectory = async (req) => {
    resolveGen2OpenCodeClient(openCodeClient);
    return resolveFacadeDirectory(req, getOpenCodeWorkingDirectory);
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

  const mergeCursorProvider = async (payload, scope = {}) => {
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
          cursorSdkRuntime.refreshVirtualProvider({ reason: 'providers_route',...scope }).catch((error) => {
            console.warn('[CursorSDK] Failed to refresh Cursor provider metadata:', error);
          });
        }
        return cursorSdkRuntime.getCachedVirtualProvider();
      }
      return null;
    })() || (typeof cursorSdkRuntime.getVirtualProvider === 'function' ? await Promise.race([
      cursorSdkRuntime.getVirtualProvider(scope),
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
      let selected, lookupUnavailable = false;
      try { selected = await readNativeOpenAiSelection(getNativeRuntimeOwner, directory, { refresh: true }); } catch {
        lookupUnavailable = true;
        try { selected = await readNativeOpenAiSelection(getNativeRuntimeOwner, directory); } catch { /* Unknown ownership remains unavailable. */ }
      }
      let auth = selected?.value;
      let accountModels = lookupUnavailable ? null : await resolveSiwcAccountModels(auth);
      if (selected) {
        try {
          const current = await readNativeOpenAiSelection(getNativeRuntimeOwner, directory);
          if (JSON.stringify(current) !== JSON.stringify(selected)) { auth = current?.value; accountModels = null; lookupUnavailable = true; }
        } catch { accountModels = null; lookupUnavailable = true; }
      }
      withOpenAIAvailability = annotateOpenAIModelAvailability(withGitHubCopilot, auth, { accountModels, unavailable: lookupUnavailable });
    }
    return mergeCursorProvider(withOpenAIAvailability, { directory: await resolveRequestDirectory(req) });
  };

  const touchOpenCodeSessionForCursorPrompt = async ({ sessionID, directory }) => {
    const client = resolveGen2OpenCodeClient(openCodeClient);
    await client.sessions.archive(sessionID, 0, { directory });
  };

  app.get('/api/config/providers', async (req, res) => {
    let upstreamPayload = { providers: [], default: {} };
    let upstreamOk = false;
    {
      try {
        const client = resolveGen2OpenCodeClient(openCodeClient);
        const parsed = await client.catalog.providers({ directory: await resolveRequestDirectory(req) });
        if (parsed && typeof parsed === 'object') {
          upstreamPayload = parsed;
          upstreamOk = true;
          void xaiToolCatalogRuntime?.refreshProviderPayload?.({
            directory: typeof req.query?.directory === 'string' ? req.query.directory : undefined,
            payload: parsed,
          });
        }
      } catch {
        // Cursor remains visible even if OpenCode provider discovery is unavailable.
      }
    }

    // Without the upstream catalog only integration providers remain; flag it so
    // clients keep their last complete catalog instead of committing this one.
    const markIncomplete = (payload) => (upstreamOk ? payload : { ...payload, catalogIncomplete: true });
    try {
      return res.json(markIncomplete(annotateModelDefaultThinking(await mergeProviderIntegrations(upstreamPayload, req))));
    } catch (error) {
      // Provider integrations (Copilot/Cursor discovery, auth reads) are best-effort.
      // If merging fails, still return the upstream provider list so the UI never
      // blanks the entire provider list or persists an empty snapshot.
      console.error('Failed to merge provider integrations:', error);
      const availablePayload = isExternalOpenCode() ? upstreamPayload : annotateOpenAIModelAvailability(upstreamPayload, undefined, { unavailable: true });
      return res.json(markIncomplete(annotateModelDefaultThinking(availablePayload)));
    }
  });

  app.get('/api/session/status', async (req, res) => {
    try {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      const cursorStatuses = cursorSdkRuntime && typeof cursorSdkRuntime.getSessionStatus === 'function'
        ? cursorSdkRuntime.getSessionStatus() : {};
      const upstream = await client.sessions.status({ directory: await resolveRequestDirectory(req) });
      return res.json({ ...upstream, ...cursorStatuses });
    } catch (error) { return sendOpenCodeFacadeError(res, error); }
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

  // Bounded per-session xAI tool overrides (see the freeze note below).
  const xaiSessionToolOverrides = new Map();
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
      // The tool block is part of the cached provider prefix: once a session
      // has sent reduced overrides, keep that exact set even if the catalog
      // later refreshes, so the prefix never changes mid-session.
      const frozenKey = isXaiProvider && process.env.DEVRYAN_XAI_TOOLS_SESSION_FREEZE !== '0'
        ? `${directory}\0${sessionID}\0${providerID}\0${modelID}` : null;
      const frozenXaiTools = frozenKey ? xaiSessionToolOverrides.get(frozenKey) : undefined;
      let cachedXaiTools = frozenXaiTools ?? (isXaiProvider
        ? xaiToolCatalogRuntime?.getPromptToolOverrides?.({ directory, providerID, modelID })
        : null);
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
      if (frozenKey && !frozenXaiTools && cachedXaiTools && Object.keys(cachedXaiTools).length > 0) {
        xaiSessionToolOverrides.set(frozenKey, cachedXaiTools);
        while (xaiSessionToolOverrides.size > 512) xaiSessionToolOverrides.delete(xaiSessionToolOverrides.keys().next().value);
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
    const { sessionID } = req.params;
    const cleanupCursorState = Boolean(cursorSdkRuntime && typeof cursorSdkRuntime.deleteSessionState === 'function');
    const stopTrackedDevServers = Boolean(processesRuntime && typeof processesRuntime.stopSessionDevServers === 'function');
    if (cleanupCursorState || stopTrackedDevServers) {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory : undefined;
      // Clean up only after the proxied OpenCode deletion succeeded, so a
      // failed delete does not orphan the session from its Cursor agent.
      res.once('finish', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        if (cleanupCursorState) {
          cursorSdkRuntime.deleteSessionState(sessionID).catch((error) => {
            console.warn('[CursorSDK] Failed to clean up deleted session state:', error);
          });
        }
        if (stopTrackedDevServers) {
          // Only dev servers carrying this session's marker, and only while the
          // project opts into tracking; the runtime enforces both.
          processesRuntime.stopSessionDevServers(sessionID, { directory }).catch((error) => {
            console.warn('[processes] Failed to stop dev servers of deleted session:', error);
          });
        }
      });
    }
    return next();
  });

  app.patch('/api/session/:sessionID', async (req, res, next) => {
    try {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      if (req.body?.time === undefined) return next();
      validateFacadeBody(req.body, ['time']);
      validateFacadeBody(req.body.time, ['archived']);
      const at = req.body.time.archived;
      if (!Number.isSafeInteger(at) || at < 0) {
        throw Object.assign(new Error('time.archived must be a nonnegative integer'), { statusCode: 400, code: 'opencode_invalid_input' });
      }
      const session = await client.sessions.archive(req.params.sessionID, at, { directory: await resolveRequestDirectory(req) });
      return res.json(session);
    } catch (error) { return sendOpenCodeFacadeError(res, error); }
  });

  app.all('/api/session/:sessionID/message', async (req, res, next) => {
    try {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      if (req.method !== 'GET') return next();
      if (!cursorSdkRuntime || typeof cursorSdkRuntime.getSessionMessages !== 'function') {
        return next();
      }
      const cursorRecords = await cursorSdkRuntime.getSessionMessages(req.params.sessionID);
      if (!Array.isArray(cursorRecords) || cursorRecords.length === 0) {
        return next();
      }

      const page = await client.sessions.messages(req.params.sessionID, readFacadeMessagePage(req), { directory: await resolveRequestDirectory(req) });
      let upstreamRecords = page?.records ?? [];
      if (page?.cursor) res.setHeader('x-next-cursor', page.cursor);

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
      return sendOpenCodeFacadeError(res, error);
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
      return res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message || 'Failed to get provider sources', code: error.code });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res, next) => {
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

      const native = nativeProviderOwner(providerId);
      if (native) {
        if (requestedDirectory && !directory) {
          const resolved = await resolveProjectDirectory(req);
          if (!resolved.directory) return res.status(400).json({ error: resolved.error });
          directory = resolved.directory;
        }
        const removedSources = { auth: false, user: false, project: false, custom: false };
        let mutationStarted = false, applyResult, failure;
        try {
          const result = await native.withProviderConfigurationAuthorization({ providerID: providerId, directory, scope }, async owner => {
            try {
              await owner.verifyConfiguration();
              if (scope === 'auth' || scope === 'all') await owner.disconnectCredentials(
                () => { removedSources.auth = true; }, () => { mutationStarted = true; });
              await owner.removeConfiguration(source => { removedSources[source] = true; mutationStarted = true; });
            } catch (error) { failure = error; }
            // A lost credential ACK is also a possibly changed source. Retain
            // a pending revision even when its exact removed flag is uncertain.
            if (!failure || mutationStarted) {
              try { applyResult = await markConfigChange(`provider ${providerId} disconnected (${scope})`, { providerId, scope, partial: Boolean(failure) }, true); }
              catch (error) { failure ??= error; }
            }
            if (failure) throw failure;
            const sources = { ...owner.readSources(), auth: await owner.readAuthenticationSource() };
            const stillProvidedBy = scope === 'all' ? owner.listRemainingConfigSources() : [];
            if (scope === 'all' && sources.auth.exists) stillProvidedBy.push({ type: 'auth', path: null });
            if (scope === 'all') for (const name of listProviderCredentialEnvKeys(providerId, { ...(getProviderEnvironmentSnapshot() || {}), ...process.env })) stillProvidedBy.push({ type: 'env', name });
            await owner.recheck();
            return { success: true, removed: Object.values(removedSources).some(Boolean), removedSources, sources, stillProvidedBy, ...applyResult,
              message: stillProvidedBy.length ? 'Provider is still configured elsewhere' : 'Provider configuration removed; runtime refresh requested' };
          });
          return res.json(result);
        } catch (error) {
          return res.status(error.statusCode ?? error.status ?? 500).json({ success: false, error: error.message || 'Failed to disconnect provider', code: error.code ?? 'PROVIDER_DISCONNECT_FAILED',
            partial: mutationStarted, removedSources, ...applyResult, recoveryRequired: mutationStarted && !applyResult });
        }
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
            ? await removeAntigravityAccounts(listAntigravityAccountsPaths)
            : await removeProviderAuthForLookupIds(getProviderIntegrationLookupIds(providerId));
        }
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removedSources[scope] = removeProviderConfigForScope(providerId, directory, scope);
      } else if (scope === 'all') {
        const auth = await getAuthLibrary();
        removedSources.auth = providerId === CURSOR_ACP_PROVIDER_ID
          ? clearCursorSdkAuth({ readAuth: auth.readAuthFile, writeAuth: auth.writeAuthFile })
          : providerId === ANTIGRAVITY_PROVIDER_ID
            // The plugin rebuilds its accounts from Google OAuth credentials.
            ? (await Promise.all([
              removeAntigravityAccounts(listAntigravityAccountsPaths),
              removeProviderAuthForLookupIds(getProviderIntegrationLookupIds('google')),
            ])).some(Boolean)
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

      // Restart even for an idempotent disconnect: the runtime may still hold a
      // provider whose source is already gone.
      const applyResult = await markConfigChange(
        `provider ${providerId} disconnected (${scope})`,
        { providerId, scope },
        true,
      );
      const sources = await readProviderSourceSnapshot(providerId, directory);
      const stillProvidedBy = scope === 'all'
        ? await listRemainingProviderSources(providerId, directory)
        : [];

      return res.json({
        success: true,
        removed,
        removedSources,
        stillProvidedBy,
        sources,
        ...applyResult,
        message: stillProvidedBy.length > 0
          ? 'Provider is still configured elsewhere'
          : removed
            ? 'Provider configuration removed; runtime refresh requested'
            : 'No stored provider configuration was found; runtime refresh requested',
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message || 'Failed to disconnect provider', code: error.code });
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
      try {
        if (typeof ensureNativeDirectory !== 'function') throw Object.assign(new Error('Native project preparation is unavailable'),
          { code: 'native_runtime_not_ready', statusCode: 503 });
        await ensureNativeDirectory(resolvedPath);
      } catch (cause) {
        // Keep registration inspectable, but do not announce an active location
        // whose native owner failed preparation. A newer selection wins.
        const latest = await readSettingsFromDisk();
        if (latest.activeProjectId === activeProjectId && latest.lastDirectory === resolvedPath) {
          await persistSettings({ activeProjectId: currentSettings.activeProjectId ?? null,
            lastDirectory: currentSettings.lastDirectory ?? null });
        }
        throw cause;
      }
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
      return res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message || 'Failed to update working directory', code: error.code });
    }
  });

};
