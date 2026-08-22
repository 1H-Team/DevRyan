import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  removeProviderConfig,
  removeAntigravityProviderConfig,
  getProviderSources,
  ensureAnthropicOAuthProviderConfig,
  getAgentConfig,
  listConfigAgents,
} from './opencodeConfig';
import {
  getAntigravityAccountsSource,
  getProviderAuth,
  getProviderAuthLookupIds,
  readAuthFile,
  removeAntigravityAccounts,
  removeProviderAuthForLookupIds,
  writeAuthFile,
} from './opencodeAuth';
import {
  fetchQuotaForProvider,
  listConfiguredQuotaProviders,
  resolveClaudeProxyBaseUrlFromProviders,
  resolveCursorQuotaCredential,
  resolveOpenCodeZenCredential,
  resolveOllamaCloudCredential,
  validateCursorQuotaCredential,
  validateOpenCodeZenQuotaCredential,
  validateOllamaCloudQuotaCredential,
} from './quotaProviders';
import {
  MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES,
  assertManagedQuotaCredential,
  canonicalizeManagedQuotaProviderId,
  deleteManagedQuotaCredential,
  getManagedQuotaCredentialStatus,
  importCursorManagedCredential,
  readManagedQuotaCredential,
  writeManagedQuotaCredential,
  type CursorDashboardCredential,
  type CursorOAuthCredential,
  type ManagedQuotaCredential,
  type OpenCodeZenCredential,
  type OllamaCloudCredential,
} from './quotaCredentials';
import { getSessionActivitySnapshot } from './sessionActivityWatcher';
import type { BridgeContext, BridgeResponse } from './bridge';
import {
  clearCursorSdkAuth,
  createCursorSdkRuntime,
  CURSOR_PROVIDER_ID,
  saveCursorSdkAuth,
} from '@openchamber/cursor-sdk-runtime';
import { runClaudeCodeAuthStatus } from './claudeAuthStatus';
import type { ConfigApplyMutationResponse } from '@openchamber/shared-runtime';
import {
  readMeridianPromptMode,
  setMeridianPromptCompatibilityMode,
} from '../../web/server/lib/opencode/meridian-sdk-features.js';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type SystemRuntimeDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  fetchModelsMetadata: () => Promise<unknown>;
  updateCheckUrl: string;
  updateCheckUsesCompatibilityContract: boolean;
  markConfigChange: (
    reason: string,
    metadata?: unknown,
    changed?: boolean,
  ) => Promise<ConfigApplyMutationResponse & { runtimeApplied: false; runtimeMessage: string }>;
};

type NotificationBridgePayload = {
  title?: string;
  body?: string;
  tag?: string;
};

type NotificationsNotifyRequestPayload = {
  payload?: NotificationBridgePayload;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const CURSOR_ACP_PROVIDER_ID = 'cursor-acp';
const CURSOR_USAGE_TOKEN_MAX_LENGTH = 16_384;

const readProviderSourceSnapshot = (providerId: string, workingDirectory?: string) => {
  const sources = getProviderSources(providerId, workingDirectory);
  const authLookupIds = ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude'].includes(providerId)
    ? [providerId, 'anthropic', 'claude']
    : getProviderAuthLookupIds(providerId);
  const auth = authLookupIds.map((id) => getProviderAuth(id)).find(Boolean);
  if (providerId === CURSOR_ACP_PROVIDER_ID) {
    sources.auth.exists = Boolean(
      (typeof process.env.CURSOR_API_KEY === 'string' && process.env.CURSOR_API_KEY.trim()) ||
      (auth && typeof auth === 'object' && (
        (typeof (auth as { key?: unknown }).key === 'string' && ((auth as { key?: string }).key ?? '').trim()) ||
        (typeof (auth as { token?: unknown }).token === 'string' && ((auth as { token?: string }).token ?? '').trim())
      ))
    );
  } else {
    sources.auth.exists = Boolean(auth);
  }
  if (providerId === 'antigravity') {
    sources.auth = getAntigravityAccountsSource();
  }
  return sources;
};

const removeProviderConfigForScope = (
  providerId: string,
  workingDirectory: string | undefined,
  scope: 'user' | 'project' | 'custom',
): boolean => providerId === 'antigravity'
  ? removeAntigravityProviderConfig(workingDirectory, scope)
  : removeProviderConfig(providerId, workingDirectory, scope);
let cachedZenModels: { models: Array<{ id: string; owned_by?: string }>; at: number } | null = null;

const resolveClaudeQuotaRuntime = async (ctx?: BridgeContext) => {
  const manager = ctx?.manager;
  const isExternalRuntime = manager?.getDebugInfo?.().mode === 'external';
  if (!manager || isExternalRuntime) {
    return {
      claudeProxyBaseUrl: null,
      claudeProxyConfigured: false,
      isExternalRuntime: Boolean(isExternalRuntime),
    };
  }
  const apiUrl = manager.getApiUrl();
  if (!apiUrl) {
    return { claudeProxyBaseUrl: null, claudeProxyConfigured: false, isExternalRuntime: false };
  }
  try {
    const base = `${apiUrl.replace(/\/+$/, '')}/`;
    const directory = manager.getWorkingDirectory();
    const target = new URL('config/providers', base);
    if (directory) target.searchParams.set('directory', directory);
    const response = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...manager.getOpenCodeAuthHeaders(),
      },
    });
    if (!response.ok) {
      return { claudeProxyBaseUrl: null, claudeProxyConfigured: false, isExternalRuntime: false };
    }
    const claudeProxyBaseUrl = resolveClaudeProxyBaseUrlFromProviders(await response.json());
    return {
      claudeProxyBaseUrl,
      claudeProxyConfigured: Boolean(claudeProxyBaseUrl),
      isExternalRuntime: false,
    };
  } catch {
    return { claudeProxyBaseUrl: null, claudeProxyConfigured: false, isExternalRuntime: false };
  }
};

type CursorSdkModelSelection = { id: string; params?: Array<{ id: string; value: string }> };
type CursorSdkAgentDefinition = { description: string; prompt: string; model: 'inherit' | CursorSdkModelSelection };
type ResolveCursorSdkModelSelection = (input: { modelID?: string | null; variant?: string | null }) =>
  CursorSdkModelSelection | Promise<CursorSdkModelSelection | null | undefined> | null | undefined;
type CursorSdkAgentDefinitionInput = {
  directory?: string | null;
  resolveModelSelection?: ResolveCursorSdkModelSelection;
};

export const resolveCursorSdkAgentModel = async (
  agent: Record<string, unknown>,
  resolveModelSelection?: CursorSdkAgentDefinitionInput['resolveModelSelection'],
): Promise<'inherit' | CursorSdkModelSelection> => {
  const model = agent?.model && typeof agent.model === 'object' && !Array.isArray(agent.model)
    ? agent.model as { providerID?: unknown; modelID?: unknown }
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
    return await resolveModelSelection({ modelID, variant }) ?? { id: modelID };
  } catch (error) {
    console.warn('[CursorSDK] failed to resolve VS Code agent model selection:', error);
    return { id: modelID };
  }
};

export const resolveCursorSdkAgentDefinitions = async ({ directory, resolveModelSelection }: CursorSdkAgentDefinitionInput = {}) => {
  const definitions: Record<string, CursorSdkAgentDefinition> = {};
  for (const agent of listConfigAgents(directory || undefined)) {
    const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
    const prompt = typeof agent?.prompt === 'string' ? agent.prompt.trim() : '';
    if (!name || !prompt || name.toLowerCase() === 'council') continue;
    definitions[name] = {
      description: typeof agent.description === 'string' && agent.description.trim()
        ? agent.description.trim()
        : `${name} DevRyan agent`,
      prompt,
      model: await resolveCursorSdkAgentModel(agent as Record<string, unknown>, resolveModelSelection),
    };
  }
  return definitions;
};

const cursorSdkRuntime = createCursorSdkRuntime({
  readAuth: readAuthFile,
  env: process.env,
  logger: console,
  resolveAgentPrompt: async ({ agent, directory }: { agent?: string; directory?: string | null }) => {
    if (!agent) return '';
    const result = getAgentConfig(agent, directory || undefined);
    return typeof result?.config?.prompt === 'string' ? result.config.prompt : '';
  },
  resolveAgentDefinitions: resolveCursorSdkAgentDefinitions,
});

export const getVsCodeCursorSdkRuntime = () => cursorSdkRuntime;

const getOpenChamberConfigDir = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const sanitizeInstallScope = (scope: string): 'desktop-tauri' | 'vscode' | 'web' => {
  if (scope === 'desktop-tauri' || scope === 'vscode' || scope === 'web') return scope;
  return 'web';
};

const getOrCreateInstallId = (scope: string): string => {
  const configDir = getOpenChamberConfigDir();
  const normalizedScope = sanitizeInstallScope(scope);
  const idPath = path.join(configDir, `install-id-${normalizedScope}`);

  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Generate new id.
  }

  const installId = randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
};

const mapNodePlatformToApiPlatform = (value: string): 'macos' | 'windows' | 'linux' | 'web' => {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
};

const mapNodeArchToApiArch = (value: string): 'arm64' | 'x64' | 'unknown' => {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
};

const compareReleaseVersions = (left: string, right: string): number => {
  const a = left.replace(/^v/, '').split('.').map((part) => Number.parseInt(part || '0', 10));
  const b = right.replace(/^v/, '').split('.').map((part) => Number.parseInt(part || '0', 10));
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const normalizeGithubReleaseUpdate = (
  value: unknown,
  currentVersion: string,
): Record<string, unknown> | null => {
  const release = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const version = typeof release?.tag_name === 'string'
    ? release.tag_name.trim().replace(/^v/, '')
    : '';
  if (!version) return null;

  return {
    available: currentVersion !== 'unknown' && compareReleaseVersions(version, currentVersion) > 0,
    version,
    currentVersion,
    body: typeof release?.body === 'string' ? release.body : undefined,
    date: typeof release?.published_at === 'string' ? release.published_at : undefined,
    nextSuggestedCheckInSec: 6 * 60 * 60,
  };
};

type ParsedDiffHunk = {
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

const VIRTUAL_DIFF_SCHEME = 'openchamber-diff';
const virtualDiffContents = new Map<string, string>();
let virtualDiffCounter = 0;
let virtualDiffProviderDisposable: vscode.Disposable | null = null;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizeCursorUsageSessionToken = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const token = value.trim();
  if (!token || token.length > CURSOR_USAGE_TOKEN_MAX_LENGTH) {
    return null;
  }
  return token;
};

const normalizeWorkspaceDirectory = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
};

const readCursorUsageAuthConfigured = (): boolean => {
  const auth = readAuthFile();
  const entry = asObject(auth[CURSOR_ACP_PROVIDER_ID]);
  return Boolean(normalizeCursorUsageSessionToken(entry?.usageSessionToken));
};

type QuotaCredentialResponse = {
  status: number;
  body: Record<string, unknown>;
};

const quotaCredentialError = (
  code: 'UNSUPPORTED_PROVIDER' | 'INVALID_CREDENTIAL' | 'NOT_CONFIGURED' | 'IMPORT_UNAVAILABLE' | 'PAYLOAD_TOO_LARGE',
  status: number,
): QuotaCredentialResponse => ({
  status,
  body: {
    code,
    error: {
      UNSUPPORTED_PROVIDER: 'Unsupported credential provider',
      INVALID_CREDENTIAL: 'Credential validation failed',
      NOT_CONFIGURED: 'Managed credential is not configured',
      IMPORT_UNAVAILABLE: 'Credential import is unavailable',
      PAYLOAD_TOO_LARGE: 'Credential payload is too large',
    }[code],
  },
});

const getManagedQuotaEffectiveSource = (providerId: string) => {
  if (providerId === 'opencode') return resolveOpenCodeZenCredential().source;
  if (providerId === 'ollama-cloud') return resolveOllamaCloudCredential().source;
  return resolveCursorQuotaCredential().source;
};

const getSafeManagedQuotaStatus = (providerId: string) => ({
  ...getManagedQuotaCredentialStatus(providerId),
  effectiveSource: getManagedQuotaEffectiveSource(providerId) ?? null,
});

const validateManagedQuotaCredential = async (
  providerId: string,
  credential: ManagedQuotaCredential,
): Promise<ManagedQuotaCredential> => {
  const record = asObject(credential) ?? {};
  if (providerId === 'opencode') {
    const normalized: OpenCodeZenCredential = {
      workspaceId: String(record.workspaceId ?? ''),
      authCookie: String(record.authCookie ?? ''),
    };
    return validateOpenCodeZenQuotaCredential(normalized);
  }
  if (providerId === 'ollama-cloud') {
    const normalized: OllamaCloudCredential = { cookie: String(record.cookie ?? '') };
    await validateOllamaCloudQuotaCredential(normalized);
    return normalized;
  }
  const normalized: CursorDashboardCredential | CursorOAuthCredential = typeof record.sessionToken === 'string'
    ? { sessionToken: record.sessionToken }
    : {
        ...(typeof record.accessToken === 'string' ? { accessToken: record.accessToken } : {}),
        ...(typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {}),
      };
  return validateCursorQuotaCredential(normalized);
};

const handleQuotaCredentialRequest = async (payload: unknown): Promise<QuotaCredentialResponse> => {
  const request = asObject(payload) ?? {};
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET';
  const action = typeof request.action === 'string' ? request.action : '';
  const body = request.body;
  let providerId: string;
  try {
    providerId = canonicalizeManagedQuotaProviderId(request.providerId);
  } catch {
    return quotaCredentialError('UNSUPPORTED_PROVIDER', 404);
  }

  if (method === 'GET' && !action) {
    return { status: 200, body: getSafeManagedQuotaStatus(providerId) };
  }

  let serializedBody = '';
  try {
    serializedBody = body === undefined ? '' : JSON.stringify(body);
  } catch {
    return quotaCredentialError('INVALID_CREDENTIAL', 400);
  }
  if (Buffer.byteLength(serializedBody, 'utf8') > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
    return quotaCredentialError('PAYLOAD_TOO_LARGE', 413);
  }

  if (method === 'PUT' && !action) {
    try {
      const { credential } = assertManagedQuotaCredential(providerId, body);
      const validated = await validateManagedQuotaCredential(providerId, credential);
      writeManagedQuotaCredential(providerId, validated);
      return { status: 200, body: getSafeManagedQuotaStatus(providerId) };
    } catch {
      return quotaCredentialError('INVALID_CREDENTIAL', 400);
    }
  }

  if (method === 'POST' && action === 'validate') {
    try {
      const hasBody = isRecord(body) && Object.keys(body).length > 0;
      const credential = hasBody
        ? assertManagedQuotaCredential(providerId, body).credential
        : readManagedQuotaCredential(providerId);
      if (!credential) return quotaCredentialError('NOT_CONFIGURED', 404);
      await validateManagedQuotaCredential(providerId, credential);
      return { status: 200, body: { valid: true } };
    } catch {
      return quotaCredentialError('INVALID_CREDENTIAL', 400);
    }
  }

  if (method === 'POST' && action === 'import') {
    if (providerId !== 'cursor-acp') return quotaCredentialError('IMPORT_UNAVAILABLE', 404);
    try {
      const imported = importCursorManagedCredential();
      const validated = await validateManagedQuotaCredential(providerId, imported);
      writeManagedQuotaCredential(providerId, validated);
      return { status: 200, body: getSafeManagedQuotaStatus(providerId) };
    } catch {
      return quotaCredentialError('IMPORT_UNAVAILABLE', 400);
    }
  }

  if (method === 'DELETE' && !action) {
    deleteManagedQuotaCredential(providerId);
    return { status: 200, body: getSafeManagedQuotaStatus(providerId) };
  }

  return quotaCredentialError('INVALID_CREDENTIAL', 400);
};

const ensureVirtualDiffProviderRegistered = (ctx?: BridgeContext): void => {
  if (virtualDiffProviderDisposable) {
    return;
  }

  virtualDiffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
    VIRTUAL_DIFF_SCHEME,
    {
      provideTextDocumentContent: (uri: vscode.Uri) => {
        const key = new URLSearchParams(uri.query).get('key') || '';
        return virtualDiffContents.get(key) ?? '';
      },
    },
  );

  if (ctx?.context) {
    ctx.context.subscriptions.push(virtualDiffProviderDisposable);
  }
};

const createVirtualOriginalDiffUri = (modifiedPath: string, content: string): vscode.Uri => {
  const key = `${Date.now()}-${++virtualDiffCounter}`;
  virtualDiffContents.set(key, content);

  if (virtualDiffContents.size > 100) {
    const firstKey = virtualDiffContents.keys().next().value;
    if (firstKey) {
      virtualDiffContents.delete(firstKey);
    }
  }

  return vscode.Uri.from({
    scheme: VIRTUAL_DIFF_SCHEME,
    path: `/${path.basename(modifiedPath) || 'original'}`,
    query: `key=${encodeURIComponent(key)}`,
  });
};

const parseUnifiedDiffHunks = (patch: string): ParsedDiffHunk[] => {
  const lines = patch.split(/\r?\n/);
  const hunks: ParsedDiffHunk[] = [];

  let current: ParsedDiffHunk | null = null;

  for (const line of lines) {
    const headerMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (headerMatch) {
      if (current) {
        hunks.push(current);
      }
      current = {
        newStart: Number(headerMatch[1] || 1),
        oldLines: [],
        newLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\ No newline')) {
      continue;
    }

    if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(' ')) {
      const content = line.slice(1);
      current.oldLines.push(content);
      current.newLines.push(content);
    }
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
};

const reconstructOriginalContentFromPatch = (modifiedContent: string, patch: string): string | null => {
  const hunks = parseUnifiedDiffHunks(patch);
  if (hunks.length === 0) {
    return null;
  }

  const lines = modifiedContent.split('\n');
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index];
    if (!hunk) {
      continue;
    }
    const startIndex = Math.max(0, hunk.newStart - 1);
    const replaceCount = hunk.newLines.length;
    lines.splice(startIndex, replaceCount, ...hunk.oldLines);
  }

  return lines.join('\n');
};

const fetchFreeZenModels = async (): Promise<Array<{ id: string; owned_by?: string }>> => {
  const now = Date.now();
  if (cachedZenModels && now - cachedZenModels.at < ZEN_MODELS_CACHE_TTL_MS) {
    return cachedZenModels.models;
  }

  const signal = AbortSignal.timeout(8_000);
  const [response, metadataResponse] = await Promise.all([
    fetch(ZEN_MODELS_URL, {
      headers: { Accept: 'application/json' },
      signal,
    }),
    fetch('https://models.dev/api.json', {
      headers: { Accept: 'application/json' },
      signal,
    }),
  ]);

  if (!response.ok) {
    throw new Error(`zen models request failed (${response.status})`);
  }
  if (!metadataResponse.ok) {
    throw new Error(`models.dev request failed (${metadataResponse.status})`);
  }

  const rawPayload = await response.json().catch(() => null);
  const rawMetadata = await metadataResponse.json().catch(() => null);
  const payload = asObject(rawPayload);
  const metadata = asObject(rawMetadata);
  const metadataProvider = asObject(metadata?.opencode);
  const metadataModels = asObject(metadataProvider?.models);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models = rows
    .map((entry) => {
      const id = typeof (entry as { id?: unknown })?.id === 'string'
        ? (entry as { id: string }).id.trim()
        : '';
      const ownedBy = typeof (entry as { owned_by?: unknown })?.owned_by === 'string'
        ? (entry as { owned_by: string }).owned_by
        : undefined;
      const metadataModel = asObject(metadataModels?.[id]);
      const cost = asObject(metadataModel?.cost);
      if (!id || cost?.input !== 0 || cost?.output !== 0) return null;
      return ownedBy ? { id, owned_by: ownedBy } : { id };
    })
    .filter((entry): entry is { id: string; owned_by?: string } => entry !== null);

  cachedZenModels = { models, at: Date.now() };
  return models;
};

export async function handleSystemBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: SystemRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:opencode/directory': {
      const target = (payload as { path?: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }
      const baseDirectory =
        ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const resolvedPath = deps.resolveUserPath(target, baseDirectory);
      const result = await ctx?.manager?.setWorkingDirectory(resolvedPath);
      if (!result) {
        return { id, type, success: false, error: 'OpenCode manager unavailable' };
      }
      return { id, type, success: true, data: result };
    }

    case 'api:models/metadata': {
      try {
        const data = await deps.fetchModelsMetadata();
        return { id, type, success: true, data };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:session-activity:get': {
      return { id, type, success: true, data: getSessionActivitySnapshot() };
    }

    case 'api:zen:models': {
      try {
        const models = await fetchFreeZenModels();
        return { id, type, success: true, data: { models } };
      } catch (error) {
        if (cachedZenModels) {
          return { id, type, success: true, data: { models: cachedZenModels.models } };
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:openchamber:update-check': {
      try {
        const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
        const currentVersion = typeof body.currentVersion === 'string' && body.currentVersion.trim().length > 0
          ? body.currentVersion.trim()
          : String(ctx?.context?.extension?.packageJSON?.version || 'unknown');

        if (!deps.updateCheckUsesCompatibilityContract) {
          const response = await fetch(deps.updateCheckUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': `DevRyan-VSCode/${currentVersion}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            return {
              id,
              type,
              success: false,
              error: `DevRyan release check failed with ${response.status}`,
            };
          }
          const update = normalizeGithubReleaseUpdate(await response.json(), currentVersion);
          if (!update) {
            return { id, type, success: false, error: 'Invalid DevRyan release metadata' };
          }
          return { id, type, success: true, data: update };
        }

        const instanceMode = typeof body.instanceMode === 'string' && body.instanceMode.trim().length > 0
          ? body.instanceMode.trim()
          : 'local';
        const deviceClass = typeof body.deviceClass === 'string' && body.deviceClass.trim().length > 0
          ? body.deviceClass.trim()
          : 'desktop';
        const platformRaw = typeof body.platform === 'string' && body.platform.trim().length > 0
          ? body.platform.trim()
          : os.platform();
        const archRaw = typeof body.arch === 'string' && body.arch.trim().length > 0
          ? body.arch.trim()
          : os.arch();
        const reportUsage = body.reportUsage !== false;

        const installId = getOrCreateInstallId('vscode');
        const requestBody = {
          appType: 'vscode',
          deviceClass,
          platform: mapNodePlatformToApiPlatform(platformRaw),
          arch: mapNodeArchToApiArch(archRaw),
          channel: 'stable',
          currentVersion,
          installId,
          instanceMode,
          reportUsage,
        };

        const response = await fetch(deps.updateCheckUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => 'update check failed');
          return { id, type, success: false, error: text || `Update check failed with ${response.status}` };
        }

        const data = await response.json();
        return { id, type, success: true, data };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'editor:openFile': {
      const { path: filePath, line, column } = payload as { path: string; line?: number; column?: number };
      try {
        const options: vscode.TextDocumentShowOptions = {};
        if (typeof line === 'number') {
          const pos = new vscode.Position(Math.max(0, line - 1), column || 0);
          options.selection = new vscode.Range(pos, pos);
        }
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(filePath),
          options,
        );
        return { id, type, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'editor:openDiff': {
      const { original, modified, label, line, patch } = payload as {
        original: string;
        modified: string;
        label?: string;
        line?: number;
        patch?: string;
      };
      try {
        const modifiedUri = vscode.Uri.file(modified);
        const modifiedDoc = await vscode.workspace.openTextDocument(modifiedUri);
        let originalUri = original ? vscode.Uri.file(original) : modifiedUri;

        if (typeof patch === 'string' && patch.trim().length > 0) {
          const originalContent = reconstructOriginalContentFromPatch(modifiedDoc.getText(), patch);
          if (typeof originalContent === 'string') {
            ensureVirtualDiffProviderRegistered(ctx);
            originalUri = createVirtualOriginalDiffUri(modified, originalContent);
          }
        }

        const leftLabel = original ? path.basename(original) : `${path.basename(modified)} (before)`;
        const title = label || `${leftLabel} ↔ ${path.basename(modified)}`;

        await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);

        if (typeof line === 'number' && Number.isFinite(line)) {
          const targetLine = Math.max(0, Math.trunc(line) - 1);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const targetEditor = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === modifiedUri.toString(),
          );
          if (targetEditor) {
            const target = new vscode.Position(targetLine, 0);
            targetEditor.selection = new vscode.Selection(target, target);
            targetEditor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
          }
        }

        return { id, type, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/auth:delete': {
      const { providerId, scope, directory } = (payload || {}) as { providerId?: string; scope?: string; directory?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      const normalizedScope = typeof scope === 'string' ? scope : 'auth';
      const workingDirectory = typeof directory === 'string' && directory.trim().length > 0
        ? directory.trim()
        : ctx?.manager?.getWorkingDirectory();
      try {
        const removedSources = {
          auth: false,
          user: false,
          project: false,
          custom: false,
        };
        if (normalizedScope === 'auth') {
          removedSources.auth = providerId === CURSOR_ACP_PROVIDER_ID
            ? clearCursorSdkAuth({ readAuth: readAuthFile, writeAuth: writeAuthFile })
            : providerId === 'antigravity'
              ? removeAntigravityAccounts()
              : removeProviderAuthForLookupIds(providerId);
        } else if (normalizedScope === 'user' || normalizedScope === 'project' || normalizedScope === 'custom') {
          removedSources[normalizedScope] = removeProviderConfigForScope(providerId, workingDirectory, normalizedScope);
        } else if (normalizedScope === 'all') {
          removedSources.auth = providerId === CURSOR_ACP_PROVIDER_ID
            ? clearCursorSdkAuth({ readAuth: readAuthFile, writeAuth: writeAuthFile })
            : providerId === 'antigravity'
              ? removeAntigravityAccounts()
              : removeProviderAuthForLookupIds(providerId);
          removedSources.user = removeProviderConfigForScope(providerId, workingDirectory, 'user');
          removedSources.project = workingDirectory
            ? removeProviderConfigForScope(providerId, workingDirectory, 'project')
            : false;
          removedSources.custom = removeProviderConfigForScope(providerId, workingDirectory, 'custom');
        } else {
          return { id, type, success: false, error: 'Invalid scope' };
        }

        const removed = Object.values(removedSources).some(Boolean);

        const applyResult = await deps.markConfigChange(
          'provider disconnect',
          { providerId, scope: normalizedScope },
          true,
        );
        const sources = readProviderSourceSnapshot(providerId, workingDirectory);
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            removed,
            removedSources,
            sources,
            ...applyResult,
            message: removed
              ? `Provider ${providerId} configuration removed; runtime refresh requested.`
              : `No stored ${providerId} configuration was found; runtime refresh requested.`,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:auth/cursor-acp:save': {
      const body = asObject(payload);
      const key = typeof body?.key === 'string' ? body.key.trim() : '';
      if (!key) {
        return { id, type, success: false, error: 'Cursor SDK API key is required.' };
      }
      try {
        saveCursorSdkAuth({
          readAuth: readAuthFile,
          writeAuth: writeAuthFile,
          key,
          type: typeof body?.type === 'string' && body.type.trim() ? body.type.trim() : 'api',
        });
        return {
          id,
          type,
          success: true,
          data: { success: true, configured: true },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/source:get': {
      const { providerId, directory } = (payload || {}) as { providerId?: string; directory?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      try {
        const workingDirectory = typeof directory === 'string' && directory.trim().length > 0
          ? directory.trim()
          : ctx?.manager?.getWorkingDirectory();
        const sources = readProviderSourceSnapshot(providerId, workingDirectory);
        return { id, type, success: true, data: { providerId, sources } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/anthropic/claude-code-status': {
      const authCheck = await runClaudeCodeAuthStatus();
      const auth = authCheck.auth ?? null;
      const unavailable = !authCheck.ok && authCheck.code === 'claude_cli_unavailable';
      return {
        id,
        type,
        success: true,
        data: {
          installed: !unavailable,
          path: typeof process.env.CLAUDE_CODE_CLI === 'string' ? process.env.CLAUDE_CODE_CLI : null,
          loggedIn: authCheck.ok,
          authStatus: authCheck.ok
            ? 'authenticated'
            : unavailable
              ? 'unavailable'
              : authCheck.code === 'claude_not_authenticated'
                ? 'signed_out'
                : 'error',
          ...(auth?.authMethod ? { authMethod: auth.authMethod } : {}),
          ...(auth?.apiProvider ? { apiProvider: auth.apiProvider } : {}),
          ...(auth?.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
          ...(!authCheck.ok && authCheck.code !== 'claude_not_authenticated' && !unavailable
            ? { error: authCheck.error, errorCode: authCheck.code }
            : {}),
        },
      };
    }

    case 'api:provider/anthropic/prompt-mode:get': {
      if (ctx?.manager?.getDebugInfo?.().mode === 'external') {
        return {
          id,
          type,
          success: true,
          data: {
            status: 200,
            body: { mode: 'external', compatibilityMode: false, editable: false },
          },
        };
      }
      const result = readMeridianPromptMode();
      if (!result.ok) {
        return {
          id,
          type,
          success: true,
          data: { status: 500, body: { code: result.code, error: result.error } },
        };
      }
      return {
        id,
        type,
        success: true,
        data: {
          status: 200,
          body: {
            mode: result.mode,
            compatibilityMode: result.compatibilityMode,
            editable: true,
          },
        },
      };
    }

    case 'api:provider/anthropic/prompt-mode:set': {
      if (ctx?.manager?.getDebugInfo?.().mode === 'external') {
        return {
          id,
          type,
          success: true,
          data: {
            status: 409,
            body: {
              code: 'external_opencode_read_only',
              error: 'Claude prompt mode is managed by the configured external OpenCode runtime.',
            },
          },
        };
      }
      const { compatibilityMode } = (payload || {}) as { compatibilityMode?: unknown };
      if (typeof compatibilityMode !== 'boolean') {
        return {
          id,
          type,
          success: true,
          data: {
            status: 400,
            body: {
              code: 'invalid_compatibility_mode',
              error: 'compatibilityMode must be a boolean',
            },
          },
        };
      }
      const result = setMeridianPromptCompatibilityMode(compatibilityMode);
      if (!result.ok) {
        return {
          id,
          type,
          success: true,
          data: { status: 500, body: { code: result.code, error: result.error } },
        };
      }
      return {
        id,
        type,
        success: true,
        data: {
          status: 200,
          body: {
            success: true,
            changed: result.changed,
            mode: result.mode,
            compatibilityMode: result.compatibilityMode,
            editable: true,
          },
        },
      };
    }

    case 'api:provider/anthropic/check-oauth': {
      const { directory } = (payload || {}) as { directory?: string };
      const workingDirectory = typeof directory === 'string' && directory.trim().length > 0
        ? directory.trim()
        : ctx?.manager?.getWorkingDirectory();
      try {
        const authCheck = await runClaudeCodeAuthStatus();
        if (!authCheck.ok) {
          return {
            id,
            type,
            success: false,
            error: authCheck.error || 'Claude Code authentication check failed.',
          };
        }

        const result = ensureAnthropicOAuthProviderConfig({ workingDirectory });
        const applyResult = await deps.markConfigChange(
          'anthropic oauth provider configuration',
          { providerId: 'anthropic' },
          result.changed,
        );
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            configured: true,
            changed: result.changed,
            path: result.path,
            ...applyResult,
            auth: authCheck.auth,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/cursor-acp/configure': {
      try {
        const result = await cursorSdkRuntime.verifyConnection();
        const status = cursorSdkRuntime.getRuntimeStatus();
        return {
          id,
          type,
          success: true,
          data: {
            ...result,
            success: true,
            configured: result.configured !== false,
            changed: false,
            requiresReload: false,
            bridge: { kind: 'cursor-sdk' },
            sdkAuthConfigured: result.sdkAuthConfigured ?? status.sdkAuthConfigured ?? false,
            usageAuthConfigured: result.usageAuthConfigured ?? status.usageAuthConfigured ?? false,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/cursor-acp/runtime-status': {
      try {
        return {
          id,
          type,
          success: true,
          data: cursorSdkRuntime.getRuntimeStatus(),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/cursor-acp/workspace': {
      try {
        const body = isRecord(payload) ? payload : {};
        const requested = normalizeWorkspaceDirectory(body.directory ?? body.path);
        if (!requested) {
          return { id, type, success: false, error: 'Directory is required.' };
        }
        const stats = fs.statSync(requested);
        if (!stats.isDirectory()) {
          return { id, type, success: false, error: 'Specified path is not a directory.' };
        }

        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            sdkManaged: true,
            changed: false,
            restarted: false,
            path: requested,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/cursor-acp/usage-auth/status': {
      try {
        return {
          id,
          type,
          success: true,
          data: { configured: readCursorUsageAuthConfigured() },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/cursor-acp/usage-auth:save': {
      const body = asObject(payload);
      const sessionToken = normalizeCursorUsageSessionToken(body?.sessionToken);
      if (!sessionToken) {
        return { id, type, success: false, error: 'A Cursor usage session token is required.' };
      }
      try {
        const auth = readAuthFile();
        const existing = asObject(auth[CURSOR_ACP_PROVIDER_ID]) ?? {};
        auth[CURSOR_ACP_PROVIDER_ID] = {
          ...existing,
          usageSessionToken: sessionToken,
        };
        writeAuthFile(auth);
        return {
          id,
          type,
          success: true,
          data: { success: true, configured: true },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/cursor-acp/usage-auth:clear': {
      try {
        const auth = readAuthFile();
        const existing = asObject(auth[CURSOR_ACP_PROVIDER_ID]) ?? {};
        const changed = Object.prototype.hasOwnProperty.call(existing, 'usageSessionToken');
        if (changed) {
          const nextEntry = { ...existing };
          delete nextEntry.usageSessionToken;
          auth[CURSOR_ACP_PROVIDER_ID] = nextEntry;
          writeAuthFile(auth);
        }
        return {
          id,
          type,
          success: true,
          data: { success: true, configured: false, changed },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:quota:providers': {
      try {
        const claudeRuntime = await resolveClaudeQuotaRuntime(ctx);
        const providers = listConfiguredQuotaProviders(claudeRuntime);
        return { id, type, success: true, data: { providers } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:quota:credentials': {
      try {
        return {
          id,
          type,
          success: true,
          data: await handleQuotaCredentialRequest(payload),
        };
      } catch {
        return {
          id,
          type,
          success: true,
          data: quotaCredentialError('INVALID_CREDENTIAL', 400),
        };
      }
    }

    case 'api:quota:get': {
      const { providerId, forceRefresh } = (payload || {}) as { providerId?: string; forceRefresh?: boolean };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      try {
        const claudeRuntime = providerId === 'claude'
          ? await resolveClaudeQuotaRuntime(ctx)
          : {};
        const result = await fetchQuotaForProvider(providerId, {
          ...claudeRuntime,
          forceRefresh: Boolean(forceRefresh),
        });
        return { id, type, success: true, data: result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'vscode:command': {
      const { command, args } = (payload || {}) as { command?: string; args?: unknown[] };
      if (!command) {
        return { id, type, success: false, error: 'Command is required' };
      }
      try {
        const result = await vscode.commands.executeCommand(command, ...(args || []));
        return { id, type, success: true, data: { result } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'vscode:openExternalUrl': {
      const { url } = (payload || {}) as { url?: string };
      const target = typeof url === 'string' ? url.trim() : '';
      if (!target) {
        return { id, type, success: false, error: 'URL is required' };
      }
      try {
        await vscode.env.openExternal(vscode.Uri.parse(target));
        return { id, type, success: true, data: { opened: true } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'notifications:can-notify': {
      return { id, type, success: true, data: true };
    }

    case 'notifications:notify': {
      const request = (payload || {}) as NotificationsNotifyRequestPayload;
      const notification = request.payload || {};
      const title = typeof notification.title === 'string' ? notification.title.trim() : '';
      const body = typeof notification.body === 'string' ? notification.body.trim() : '';

      const message = title && body
        ? `${title}: ${body}`
        : title || body;

      if (!message) {
        return { id, type, success: true, data: { shown: false } };
      }

      void vscode.window.showInformationMessage(message);
      return { id, type, success: true, data: { shown: true } };
    }

    default:
      return null;
  }
}
