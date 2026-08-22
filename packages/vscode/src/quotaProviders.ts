import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  fetchCodexQuotaAdapter,
  fetchDeepSeekQuotaAdapter,
  fetchKimiQuotaAdapter,
  fetchOpenCodeZenQuotaAdapter,
  fetchOpenCodeGoQuotaAdapter,
  fetchXaiQuotaAdapter,
  fetchZaiQuotaAdapter,
  refreshXaiOAuthToken,
} from '@openchamber/shared-runtime';
import {
  type CursorDashboardCredential,
  type CursorOAuthCredential,
  type ManagedQuotaCredential,
  type OpenCodeZenCredential,
  type OllamaCloudCredential,
  deleteLegacyOpenCodeGoQuotaCredential,
  readManagedQuotaCredential,
  writeManagedQuotaCredential,
} from './quotaCredentials';
import { mutateAuthFile, writeAuthFile as writeOpenCodeAuthFile } from './opencodeAuth';

type AuthEntry = Record<string, unknown> | string;
type AuthFile = Record<string, AuthEntry>;

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  description?: string | null;
};

type ProviderUsage = {
  windows: Record<string, UsageWindow>;
  models?: Record<string, ProviderUsage>;
  resetCredits?: UsageResetCredits;
};

type UsageResetCredit = {
  id: string;
  status: string;
  resetType: string | null;
  grantedAt: number | null;
  grantedAtFormatted: string | null;
  expiresAt: number | null;
  expiresAtFormatted: string | null;
};

type UsageResetCredits = {
  availableCount: number | null;
  totalEarnedCount: number | null;
  credits: UsageResetCredit[];
  source: 'dedicated' | 'usage';
};

type QuotaFetch = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers?: { get: (name: string) => string | null };
}>;

type FetchQuotaOptions = {
  readAuth?: () => AuthFile;
  writeAuth?: (auth: AuthFile) => unknown;
  fetchImpl?: QuotaFetch;
  now?: () => number;
  refreshXaiAccessToken?: (credential: {
    accessToken: string;
    refreshToken: string;
  }) => Promise<{
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
  } | null>;
  env?: NodeJS.ProcessEnv;
  readManagedCredential?: (providerId: string) => ManagedQuotaCredential | null;
  writeManagedCredential?: (providerId: string, credential: ManagedQuotaCredential) => unknown;
  readTokenFile?: (filePath: string) => string;
  readLegacyOllamaCookie?: () => string | null;
  deleteLegacyOpenCodeGoCredential?: () => void;
  mutateOpenCodeAuth?: typeof mutateAuthFile;
  claudeProxyBaseUrl?: string | null;
  claudeProxyConfigured?: boolean;
  isExternalRuntime?: boolean;
  forceRefresh?: boolean;
  fetchClaudeCodeUsage?: () => Promise<ReturnType<typeof parseClaudeCodeUsageOutput>>;
};

const ANTHROPIC_AUTH_ALIASES = [
  'anthropic',
  'claude',
  'anthropic-oauth',
  'opencode-with-claude',
];
const XAI_AUTH_ALIASES = ['xai', 'grok', 'xai-oauth'];

type GoogleModelsPayload = {
  models?: Record<string, {
    quotaInfo?: {
      remainingFraction?: number;
      resetTime?: string;
    };
  }>;
};

type GoogleQuotaBucketsPayload = {
  buckets?: Array<{
    modelId?: string;
    remainingFraction?: number;
    resetTime?: string;
  }>;
};

type ZhipuaiTokensLimit = {
  type: 'TOKENS_LIMIT';
  unit?: number;
  number?: number;
  nextResetTime?: number;
  percentage?: number;
};

type ZhipuaiMcpTimeLimit = {
  type: 'TIME_LIMIT';
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{
    modelCode?: string;
    usage?: number;
  }>;
};

type ZhipuaiPayload = {
  data?: {
    limits?: Array<ZhipuaiTokensLimit | ZhipuaiMcpTimeLimit>;
    level?: string;
  };
};

export type ProviderResult = {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: ProviderUsage | null;
  fetchedAt: number;
  usageUpdatedAt?: number;
  error?: string;
  errorCode?: string;
  warnings?: string[];
};

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');
const OLLAMA_CLOUD_COOKIE_PATH = path.join(os.homedir(), '.config', 'ollama-quota', 'cookie');
const CURSOR_CURRENT_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard?tab=spending';
const CURSOR_OAUTH_BASE_URL = 'https://api2.cursor.sh';
const CURSOR_OAUTH_USAGE_URL = `${CURSOR_OAUTH_BASE_URL}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const CURSOR_OAUTH_REFRESH_URL = `${CURSOR_OAUTH_BASE_URL}/oauth/token`;
const CURSOR_OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const CURSOR_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const COPILOT_AI_CREDITS_DESCRIPTION = 'AI Credits are consumed from token usage, including input, output, and cached tokens.';
const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json'),
];

// OAuth Secret value used to init client
// Note: It's ok to save this in git because this is an installed application
// as described here: https://developers.google.com/identity/protocols/oauth2#installed
// "The process results in a client ID and, in some cases, a client secret,
// which you embed in the source code of your application. (In this context,
// the client secret is obviously not treated as a secret.)"
// ref: https://github.com/opgginc/opencode-bar

const ANTIGRAVITY_GOOGLE_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_GOOGLE_CLIENT_SECRET = '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';
const GEMINI_GOOGLE_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_GOOGLE_CLIENT_SECRET = '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';
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const GOOGLE_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const GOOGLE_PRIMARY_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

const GOOGLE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  GOOGLE_PRIMARY_ENDPOINT,
];

const GOOGLE_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

const resolveGoogleWindow = (sourceId: GoogleAuthSource['sourceId'], resetAt: number | null) => {
  if (sourceId === 'gemini') {
    return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
  }

  if (sourceId === 'antigravity') {
    const remainingSeconds = typeof resetAt === 'number'
      ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      : null;

    if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
      return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
    }

    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS } as const;
  }

  return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS } as const;
};

const ZAI_TOKEN_WINDOW_SECONDS: Record<number, number> = { 3: 3600 };
const OPENCODE_GO_ALIASES = ['opencode-go', 'opencodego', 'go'];

const readAuthFile = (): AuthFile => {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed) as AuthFile;
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
};

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

const readTextFile = (filePath: string): string | null => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    return content || null;
  } catch (error) {
    console.warn(`Failed to read text file: ${filePath}`, error);
    return null;
  }
};

const getAuthEntry = (auth: AuthFile, aliases: string[]) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

const normalizeAuthEntry = (entry: AuthEntry | null) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry } as Record<string, unknown>;
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};

const asObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const parseGoogleRefreshToken = (rawRefreshToken: unknown) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }

  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject),
  };
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toTimestamp = (value: unknown): number | null => {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const formatResetTime = (timestamp: number) => {
  try {
    const resetDate = new Date(timestamp);
    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      // Same day: show time only (e.g., "9:56 PM")
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    // Different day: show date + weekday + time (e.g., "Feb 2, Sun 9:56 PM")
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
};

const calculateResetAfterSeconds = (resetAt: number | null) => {
  if (!resetAt) return null;
  const delta = Math.floor((resetAt - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

const toUsageWindow = (data: {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAt: number | null;
  valueLabel?: string | null;
  description?: string | null;
}) => {
  const resetAfterSeconds = calculateResetAfterSeconds(data.resetAt);
  const resetFormatted = data.resetAt ? formatResetTime(data.resetAt) : null;
  return {
    usedPercent: data.usedPercent,
    remainingPercent: data.usedPercent !== null ? Math.max(0, 100 - data.usedPercent) : null,
    windowSeconds: data.windowSeconds ?? null,
    resetAfterSeconds,
    resetAt: data.resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(data.valueLabel ? { valueLabel: data.valueLabel } : {}),
    ...(data.description ? { description: data.description } : {}),
  } satisfies UsageWindow;
};

const buildResult = (data: {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage?: ProviderUsage | null;
  error?: string;
  errorCode?: string;
  warnings?: string[];
  usageUpdatedAt?: number;
}): ProviderResult => ({
  providerId: data.providerId,
  providerName: data.providerName,
  ok: data.ok,
  configured: data.configured,
  usage: data.usage ?? null,
  ...(data.error ? { error: data.error } : {}),
  ...(data.errorCode ? { errorCode: data.errorCode } : {}),
  ...(Array.isArray(data.warnings) && data.warnings.length > 0 ? { warnings: data.warnings } : {}),
  ...(typeof data.usageUpdatedAt === 'number' && Number.isFinite(data.usageUpdatedAt)
    ? { usageUpdatedAt: data.usageUpdatedAt }
    : {}),
  fetchedAt: Date.now(),
});

const formatMoney = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};

export const listConfiguredQuotaProviders = ({
  claudeProxyConfigured = false,
  isExternalRuntime = false,
  readAuth = readAuthFile,
  readManagedCredential = readManagedQuotaCredential,
}: {
  claudeProxyConfigured?: boolean;
  isExternalRuntime?: boolean;
  readAuth?: () => AuthFile;
  readManagedCredential?: (providerId: string) => ManagedQuotaCredential | null;
} = {}) => {
  const auth = readAuth();
  const configured = new Set<string>();

  const anthropicAuth = normalizeAuthEntry(getAuthEntry(auth, ANTHROPIC_AUTH_ALIASES));
  if (
    !isExternalRuntime
    && (
      (anthropicAuth && ((anthropicAuth as Record<string, unknown>).access || (anthropicAuth as Record<string, unknown>).token))
      || claudeProxyConfigured
    )
  ) {
    configured.add('claude');
  }

  const openaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt']));
  if (openaiAuth && ((openaiAuth as Record<string, unknown>).access || (openaiAuth as Record<string, unknown>).token)) {
    configured.add('codex');
  }

  const xaiAuth = normalizeAuthEntry(getAuthEntry(auth, XAI_AUTH_ALIASES));
  if (xaiAuth && ((xaiAuth as Record<string, unknown>).access || (xaiAuth as Record<string, unknown>).token)) {
    configured.add('xai');
  }

  if (resolveCursorQuotaCredential({ readAuth: () => auth }).credential) {
    configured.add('cursor-acp');
  }

  const deepseekAuth = normalizeAuthEntry(getAuthEntry(auth, ['deepseek']));
  if (deepseekAuth && ((deepseekAuth as Record<string, unknown>).key || (deepseekAuth as Record<string, unknown>).token)) {
    configured.add('deepseek');
  }

  if (resolveGeminiCliAuth(auth)) {
    configured.add('google');
  }
  if (resolveAntigravityAuth()) {
    configured.add('antigravity');
  }

  const zaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai']));
  if (zaiAuth && ((zaiAuth as Record<string, unknown>).key || (zaiAuth as Record<string, unknown>).token)) {
    configured.add('zai-coding-plan');
  }

  const zhipuaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan']));
  if (zhipuaiAuth && ((zhipuaiAuth as Record<string, unknown>).key || (zhipuaiAuth as Record<string, unknown>).token)) {
    configured.add('zhipuai-coding-plan');
  }

  const kimiAuth = normalizeAuthEntry(getAuthEntry(auth, ['kimi-for-coding', 'kimi']));
  if (kimiAuth && ((kimiAuth as Record<string, unknown>).key || (kimiAuth as Record<string, unknown>).token)) {
    configured.add('kimi-for-coding');
  }

  const openrouterAuth = normalizeAuthEntry(getAuthEntry(auth, ['openrouter']));
  if (openrouterAuth && ((openrouterAuth as Record<string, unknown>).key || (openrouterAuth as Record<string, unknown>).token)) {
    configured.add('openrouter');
  }

  const nanopgAuth = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt']));
  if (nanopgAuth && ((nanopgAuth as Record<string, unknown>).key || (nanopgAuth as Record<string, unknown>).token)) {
    configured.add('nano-gpt');
  }

  const copilotAuth = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot']));
  if (copilotAuth && ((copilotAuth as Record<string, unknown>).access || (copilotAuth as Record<string, unknown>).token)) {
    configured.add('github-copilot');
    configured.add('github-copilot-addon');
  }

  const minimaxAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-coding-plan']));
  if (minimaxAuth && ((minimaxAuth as Record<string, unknown>).key || (minimaxAuth as Record<string, unknown>).token)) {
    configured.add('minimax-coding-plan');
  }

  const minimaxCnAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-cn-coding-plan']));
  if (minimaxCnAuth && ((minimaxCnAuth as Record<string, unknown>).key || (minimaxCnAuth as Record<string, unknown>).token)) {
    configured.add('minimax-cn-coding-plan');
  }

  if (resolveOllamaCloudCredential().credential) {
    configured.add('ollama-cloud');
  }

  if (resolveOpenCodeZenCredential({ readManagedCredential }).credential) {
    configured.add('opencode');
  }

  const openCodeGo = resolveOpenCodeGoCredentials({ readAuth: () => auth });
  if (openCodeGo.apiConfigured) {
    configured.add('opencode-go');
  }

  return Array.from(configured);
};

export const fetchCodexQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt'])) as Record<string, unknown> | null;
  return fetchCodexQuotaAdapter({
    credential: {
      accessToken: (entry?.access as string | undefined) ?? (entry?.token as string | undefined) ?? '',
      accountId: (entry?.accountId as string | undefined) ?? (entry?.account_id as string | undefined),
    },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};

const resolveXaiAuthEntry = (auth: AuthFile) => {
  const authKey = XAI_AUTH_ALIASES.find((alias) => auth[alias]) ?? null;
  return {
    authKey,
    entry: normalizeAuthEntry(authKey ? auth[authKey] : null) as Record<string, unknown> | null,
  };
};

export const fetchXaiQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const { authKey, entry } = resolveXaiAuthEntry(auth);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);
  const refreshToken = (entry?.refresh as string | undefined) ?? (entry?.refresh_token as string | undefined);

  const refreshAccessToken = options.refreshXaiAccessToken ?? (refreshToken && authKey
    ? async () => {
      const refreshed = await refreshXaiOAuthToken({ refreshToken, fetchImpl, now });
      if (!entry || typeof auth[authKey] !== 'object') {
        throw new Error('xAI OAuth credentials cannot be updated.');
      }
      auth[authKey] = {
        ...entry,
        access: refreshed.accessToken,
        refresh: refreshed.refreshToken,
        ...(refreshed.expiresAt !== null ? { expires: refreshed.expiresAt } : {}),
      };
      (options.writeAuth ?? writeOpenCodeAuthFile)(auth);
      return refreshed;
    }
    : undefined);

  return fetchXaiQuotaAdapter({
    credential: {
      accessToken: accessToken ?? '',
      refreshToken,
    },
    fetchImpl,
    refreshAccessToken,
    now,
  });
};

export const fetchDeepSeekQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['deepseek'])) as Record<string, unknown> | null;
  return fetchDeepSeekQuotaAdapter({
    credential: {
      apiKey: (entry?.key as string | undefined) ?? (entry?.token as string | undefined) ?? '',
    },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};

export const resolveOpenCodeGoCredentials = (options: FetchQuotaOptions = {}) => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, OPENCODE_GO_ALIASES)) as Record<string, unknown> | null;
  const values = [entry?.key, entry?.token, entry?.access];
  const apiKey = values
    .map((value) => asNonEmptyString(value))
    .find((value) => Boolean(value) && !/[\r\n]/.test(value as string)) ?? null;
  return {
    apiConfigured: Boolean(apiKey),
    apiKey,
    source: apiKey ? 'auth' as const : null,
  };
};

export const resolveOpenCodeZenCredential = (options: FetchQuotaOptions = {}) => {
  const managed = (options.readManagedCredential ?? readManagedQuotaCredential)('opencode');
  const record = asObject(managed);
  const workspaceId = asNonEmptyString(record?.workspaceId);
  const authCookie = asNonEmptyString(record?.authCookie);
  const credential = workspaceId && authCookie
    ? { workspaceId, authCookie } satisfies OpenCodeZenCredential
    : null;
  return {
    credential,
    source: credential ? 'managed' as const : null,
  };
};

export const fetchOpenCodeZenQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const { credential } = resolveOpenCodeZenCredential(options);
  return fetchOpenCodeZenQuotaAdapter({
    credential,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};

export const validateOpenCodeZenQuotaCredential = async (
  credential: OpenCodeZenCredential,
  options: FetchQuotaOptions = {},
): Promise<OpenCodeZenCredential> => {
  const result = await fetchOpenCodeZenQuotaAdapter({
    credential,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
  if (!result.ok) throw new Error('OpenCode Zen dashboard credential could not be validated.');
  return credential;
};

const cleanOpenCodeGoLegacyCredentials = (options: FetchQuotaOptions): string[] => {
  let failed = false;
  try {
    (options.deleteLegacyOpenCodeGoCredential ?? deleteLegacyOpenCodeGoQuotaCredential)();
  } catch {
    failed = true;
  }
  try {
    (options.mutateOpenCodeAuth ?? mutateAuthFile)((auth) => {
      const entry = auth['opencode-go'];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      if (!Object.hasOwn(entry, 'usageWorkspaceId') && !Object.hasOwn(entry, 'usageAuthCookie')) return false;
      delete entry.usageWorkspaceId;
      delete entry.usageAuthCookie;
      return auth;
    });
  } catch {
    failed = true;
  }
  return failed ? ['OpenCode Go usage refreshed, but legacy credential cleanup failed.'] : [];
};

export const fetchOpenCodeGoQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const credentials = resolveOpenCodeGoCredentials(options);
  const result = await fetchOpenCodeGoQuotaAdapter({
    credential: { apiKey: credentials.apiKey ?? '' },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
  if (!result.ok) return result;

  const cleanupWarnings = cleanOpenCodeGoLegacyCredentials(options);
  return cleanupWarnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...cleanupWarnings] }
    : result;
};

const getCursorUsageSessionToken = (auth: AuthFile): string | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['cursor-acp']));
  return asNonEmptyString(entry?.usageSessionToken);
};

const defaultReadTokenFile = (filePath: string): string => {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
};

export const resolveCursorQuotaCredential = (options: FetchQuotaOptions = {}) => {
  const env = options.env ?? process.env;
  const environmentAccessToken = asNonEmptyString(env.CURSOR_TOKEN)
    ?? asNonEmptyString(env.CURSOR_ACCESS_TOKEN);
  const environmentRefreshToken = asNonEmptyString(env.CURSOR_REFRESH_TOKEN);
  if (environmentAccessToken || environmentRefreshToken) {
    return {
      kind: 'oauth' as const,
      source: 'environment' as const,
      credential: {
        ...(environmentAccessToken ? { accessToken: environmentAccessToken } : {}),
        ...(environmentRefreshToken ? { refreshToken: environmentRefreshToken } : {}),
      } satisfies CursorOAuthCredential,
    };
  }

  const readTokenFile = options.readTokenFile ?? defaultReadTokenFile;
  const fileAccessToken = readTokenFile(asNonEmptyString(env.CURSOR_TOKEN_FILE) ?? '');
  const fileRefreshToken = readTokenFile(asNonEmptyString(env.CURSOR_REFRESH_TOKEN_FILE) ?? '');
  if (fileAccessToken || fileRefreshToken) {
    return {
      kind: 'oauth' as const,
      source: 'token-file' as const,
      credential: {
        ...(fileAccessToken ? { accessToken: fileAccessToken } : {}),
        ...(fileRefreshToken ? { refreshToken: fileRefreshToken } : {}),
      } satisfies CursorOAuthCredential,
    };
  }

  const managed = (options.readManagedCredential ?? readManagedQuotaCredential)('cursor-acp');
  const managedRecord = asObject(managed);
  const managedSessionToken = asNonEmptyString(managedRecord?.sessionToken);
  if (managedSessionToken) {
    return {
      kind: 'dashboard' as const,
      source: 'managed' as const,
      credential: { sessionToken: managedSessionToken } satisfies CursorDashboardCredential,
    };
  }
  const managedAccessToken = asNonEmptyString(managedRecord?.accessToken);
  const managedRefreshToken = asNonEmptyString(managedRecord?.refreshToken);
  if (managedAccessToken || managedRefreshToken) {
    return {
      kind: 'oauth' as const,
      source: 'managed' as const,
      credential: {
        ...(managedAccessToken ? { accessToken: managedAccessToken } : {}),
        ...(managedRefreshToken ? { refreshToken: managedRefreshToken } : {}),
      } satisfies CursorOAuthCredential,
    };
  }

  const auth = options.readAuth?.() ?? readAuthFile();
  const legacySessionToken = getCursorUsageSessionToken(auth);
  return legacySessionToken
    ? {
        kind: 'dashboard' as const,
        source: 'legacy' as const,
        credential: { sessionToken: legacySessionToken } satisfies CursorDashboardCredential,
      }
    : { kind: null, source: null, credential: null };
};

const getCursorUsageSessionTokenCandidates = (sessionToken: string): string[] => {
  const token = sessionToken.trim();
  if (!token) return [];

  const candidates = [token];
  const addCandidate = (candidate: string) => {
    const normalized = candidate.trim();
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  if (token.includes('::')) {
    addCandidate(token.replaceAll('::', '%3A%3A'));
  }

  if (/%[0-9a-f]{2}/i.test(token)) {
    try {
      addCandidate(decodeURIComponent(token));
    } catch {
      // Keep the raw token when it is not valid URI-encoded text.
    }
  }

  return candidates;
};

const resolveCursorBillingWindowSeconds = (startAt: number | null, endAt: number | null) => {
  if (typeof startAt !== 'number' || typeof endAt !== 'number' || endAt <= startAt) {
    return null;
  }
  return Math.round((endAt - startAt) / 1000);
};

const buildCursorUsage = (payload: unknown): ProviderUsage => {
  const root = asObject(payload);
  const individualUsage = asObject(root?.individualUsage);
  const plan = asObject(individualUsage?.plan) ?? asObject(root?.planUsage);
  if (!plan) {
    throw new Error('Cursor usage response did not include plan usage buckets.');
  }

  const autoPercent = toNumber(plan.autoPercentUsed);
  const apiPercent = toNumber(plan.apiPercentUsed);
  if (autoPercent === null || apiPercent === null) {
    throw new Error('Cursor usage response did not include plan usage buckets.');
  }

  const billingCycleStart = toTimestamp(root?.billingCycleStart);
  const billingCycleEnd = toTimestamp(root?.billingCycleEnd);
  const windowSeconds = resolveCursorBillingWindowSeconds(billingCycleStart, billingCycleEnd);

  const windows: ProviderUsage['windows'] = {};
  windows['auto-composer'] = toUsageWindow({
    usedPercent: autoPercent,
    windowSeconds,
    resetAt: billingCycleEnd,
  });
  windows.api = toUsageWindow({
    usedPercent: apiPercent,
    windowSeconds,
    resetAt: billingCycleEnd,
  });

  return {
    windows,
  };
};

const buildCursorUsageRequests = (sessionToken: string): Array<{ url: string; init: RequestInit }> => [
  {
    url: CURSOR_CURRENT_PERIOD_USAGE_URL,
    init: {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        Pragma: 'no-cache',
        Origin: 'https://cursor.com',
        Referer: CURSOR_DASHBOARD_URL,
        Cookie: `WorkosCursorSessionToken=${sessionToken}`,
      },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    },
  },
];

const fetchCursorDashboardPayload = async (sessionToken: string, fetchImpl: QuotaFetch) => {
  let response: Awaited<ReturnType<QuotaFetch>> | null = null;
  for (const tokenCandidate of getCursorUsageSessionTokenCandidates(sessionToken)) {
    for (const request of buildCursorUsageRequests(tokenCandidate)) {
      response = await fetchImpl(request.url, request.init);
      if (response.ok || (response.status >= 300 && response.status < 400)) break;
    }
    if (response?.ok || (response && response.status >= 300 && response.status < 400)) break;
  }
  if (!response?.ok) {
    throw new Error(response?.status === 401 || response?.status === 403 || (response && response.status >= 300 && response.status < 400)
      ? 'Cursor session expired. Update the Cursor usage session token.'
      : `Cursor usage API error: ${response?.status ?? 'unknown'}`);
  }
  const payload = await response.json();
  buildCursorUsage(payload);
  return payload;
};

const readCursorJwtExpiry = (token: string): number | null => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const record = asObject(parsed);
    return typeof record?.exp === 'number' && Number.isFinite(record.exp) ? record.exp * 1000 : null;
  } catch {
    return null;
  }
};

const cursorAccessTokenNeedsRefresh = (accessToken: string | undefined) => {
  if (!accessToken) return true;
  const expiresAt = readCursorJwtExpiry(accessToken);
  return expiresAt !== null && expiresAt - Date.now() <= CURSOR_REFRESH_BUFFER_MS;
};

const refreshCursorAccessToken = async (refreshToken: string, fetchImpl: QuotaFetch) => {
  const response = await fetchImpl(CURSOR_OAUTH_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const payload = asObject(await response.json().catch(() => null));
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    throw new Error('Cursor OAuth session expired. Update or import the Cursor credential.');
  }
  const accessToken = asNonEmptyString(payload?.access_token);
  if (!accessToken) throw new Error('Cursor refresh response did not include an access token.');
  return accessToken;
};

const resolveCursorOAuthAccessToken = async (credential: CursorOAuthCredential, fetchImpl: QuotaFetch) => {
  const currentAccessToken = credential.accessToken;
  if (currentAccessToken && !cursorAccessTokenNeedsRefresh(currentAccessToken)) {
    return { accessToken: currentAccessToken, credential, refreshed: false };
  }
  if (!credential.refreshToken) throw new Error('Cursor access token is required.');
  const accessToken = await refreshCursorAccessToken(credential.refreshToken, fetchImpl);
  return {
    accessToken,
    credential: { accessToken, refreshToken: credential.refreshToken } satisfies CursorOAuthCredential,
    refreshed: true,
  };
};

const fetchCursorOAuthPayload = async (accessToken: string, fetchImpl: QuotaFetch) => {
  const response = await fetchImpl(CURSOR_OAUTH_USAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'Cursor OAuth session expired. Update or import the Cursor credential.'
      : `Cursor usage API error: ${response.status}`);
  }
  const payload = await response.json();
  buildCursorUsage(payload);
  return payload;
};

export const validateCursorQuotaCredential = async (
  credential: CursorDashboardCredential | CursorOAuthCredential,
  fetchImpl: QuotaFetch = fetch,
): Promise<CursorDashboardCredential | CursorOAuthCredential> => {
  if ('sessionToken' in credential) {
    await fetchCursorDashboardPayload(credential.sessionToken, fetchImpl);
    return credential;
  }
  const resolved = await resolveCursorOAuthAccessToken(credential, fetchImpl);
  await fetchCursorOAuthPayload(resolved.accessToken, fetchImpl);
  return resolved.credential;
};

export const fetchCursorAcpQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = resolveCursorQuotaCredential(options);

  if (!resolved.credential) {
    return buildResult({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: false,
      configured: false,
      error: 'Cursor usage tracking is not configured.',
    });
  }

  try {
    let payload: unknown;
    if (resolved.kind === 'dashboard') {
      payload = await fetchCursorDashboardPayload(resolved.credential.sessionToken, fetchImpl);
    } else {
      const oauth = await resolveCursorOAuthAccessToken(resolved.credential, fetchImpl);
      payload = await fetchCursorOAuthPayload(oauth.accessToken, fetchImpl);
      if (oauth.refreshed && resolved.source === 'managed') {
        (options.writeManagedCredential ?? writeManagedQuotaCredential)('cursor-acp', oauth.credential);
      }
    }

    return buildResult({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: true,
      configured: true,
      usage: buildCursorUsage(payload),
    });
  } catch (error) {
    return buildResult({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

type GoogleAuthSource = {
  sourceId: 'gemini' | 'antigravity';
  sourceLabel: string;
  accessToken?: string;
  refreshToken?: string;
  expires?: number;
  projectId?: string;
  email?: string;
};

const resolveGeminiCliAuth = (auth: AuthFile): GoogleAuthSource | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth'])) as Record<string, unknown> | null;
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const accessToken = asNonEmptyString(oauthObject.access) ?? asNonEmptyString(oauthObject.token);
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken: accessToken ?? undefined,
    refreshToken: refreshParts.refreshToken ?? undefined,
    projectId: (refreshParts.projectId ?? refreshParts.managedProjectId) ?? undefined,
    expires: toTimestamp(oauthObject.expires) ?? undefined,
  };
};

const resolveAntigravityAuth = (): GoogleAuthSource | null => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = readJsonFile(filePath);
    const accounts = data?.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const index = typeof (data as Record<string, unknown>)?.activeIndex === 'number'
        ? (data as Record<string, unknown>).activeIndex as number
        : 0;
      const account = (accounts[index] as Record<string, unknown> | undefined) ?? (accounts[0] as Record<string, unknown> | undefined);
      if (account?.refreshToken) {
        const refreshParts = parseGoogleRefreshToken(account.refreshToken);
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken ?? undefined,
          projectId: asNonEmptyString(account.projectId)
            ?? asNonEmptyString(account.managedProjectId)
            ?? refreshParts.projectId
            ?? refreshParts.managedProjectId
            ?? undefined,
          email: asNonEmptyString(account.email) ?? undefined,
        };
      }
    }
  }

  return null;
};

const resolveGoogleAuthSources = (): GoogleAuthSource[] => {
  const auth = readAuthFile();
  const sources: GoogleAuthSource[] = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  const antigravityAuth = resolveAntigravityAuth();
  if (antigravityAuth) {
    sources.push(antigravityAuth);
  }

  return sources;
};

const resolveGoogleOAuthClient = (sourceId: GoogleAuthSource['sourceId']) => {
  if (sourceId === 'gemini') {
    return {
      clientId: GEMINI_GOOGLE_CLIENT_ID,
      clientSecret: GEMINI_GOOGLE_CLIENT_SECRET,
    };
  }

  return {
    clientId: ANTIGRAVITY_GOOGLE_CLIENT_ID,
    clientSecret: ANTIGRAVITY_GOOGLE_CLIENT_SECRET,
  };
};

const refreshGoogleAccessToken = async (refreshToken: string, clientId: string, clientSecret: string) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as Record<string, unknown>;
  return typeof data?.access_token === 'string' ? data.access_token : null;
};

const fetchGoogleQuotaBuckets = async (accessToken: string, projectId?: string) => {
  const body = projectId ? { project: projectId } : {};
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
  try {
    const response = await fetch(`${GOOGLE_PRIMARY_ENDPOINT}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.json() as GoogleQuotaBucketsPayload;
  } catch {
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const fetchGoogleModels = async (accessToken: string, projectId?: string) => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of GOOGLE_ENDPOINTS) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...GOOGLE_HEADERS,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      if (response.ok) {
        return await response.json() as Record<string, unknown>;
      }
    } catch {
      // fall through
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  return null;
};

const fetchGoogleQuotaForSource = async (
  sourceId: GoogleAuthSource['sourceId'],
  providerId: string,
  providerName: string,
): Promise<ProviderResult> => {
  const authSources = resolveGoogleAuthSources().filter((source) => source.sourceId === sourceId);
  if (!authSources.length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const models: Record<string, ProviderUsage> = {};
  const sourceErrors: string[] = [];

  for (const source of authSources) {
    const now = Date.now();
    let accessToken = source.accessToken;

    if (!accessToken || (typeof source.expires === 'number' && source.expires <= now)) {
      if (!source.refreshToken) {
        sourceErrors.push(`${source.sourceLabel}: Missing refresh token`);
        continue;
      }
      const { clientId, clientSecret } = resolveGoogleOAuthClient(source.sourceId);
      accessToken = (await refreshGoogleAccessToken(source.refreshToken, clientId, clientSecret)) ?? undefined;
    }

    if (!accessToken) {
      sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
      continue;
    }

    const projectId = source.projectId ?? DEFAULT_PROJECT_ID;
    let mergedAnyModel = false;

    if (source.sourceId === 'gemini') {
      const quotaPayload = await fetchGoogleQuotaBuckets(accessToken, projectId);
      const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];

      for (const bucket of buckets) {
        const modelId = asNonEmptyString(bucket.modelId);
        if (!modelId) {
          continue;
        }

        const scopedName = modelId.startsWith(`${source.sourceId}/`)
          ? modelId
          : `${source.sourceId}/${modelId}`;

        const remainingFraction = toNumber(bucket.remainingFraction);
        const remainingPercent = remainingFraction !== null
          ? Math.round(remainingFraction * 100)
          : null;
        const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
        const resetAt = toTimestamp(bucket.resetTime);
        const window = resolveGoogleWindow(source.sourceId, resetAt);

        models[scopedName] = {
          windows: {
            [window.label]: toUsageWindow({
              usedPercent,
              windowSeconds: window.seconds,
              resetAt,
            }),
          },
        };
        mergedAnyModel = true;
      }
    }

    const payload = await fetchGoogleModels(accessToken, projectId);
    if (payload && typeof payload === 'object') {
      const payloadModels = (payload as GoogleModelsPayload).models ?? {};
      for (const [modelName, modelData] of Object.entries(payloadModels)) {
        const scopedName = modelName.startsWith(`${source.sourceId}/`)
          ? modelName
          : `${source.sourceId}/${modelName}`;
        const quotaInfo = modelData?.quotaInfo;
        const remainingFraction = quotaInfo?.remainingFraction;
        const remainingPercent = typeof remainingFraction === 'number'
          ? Math.round(remainingFraction * 100)
          : null;
        const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
        const resetAt = quotaInfo?.resetTime
          ? new Date(quotaInfo.resetTime).getTime()
          : null;
        const window = resolveGoogleWindow(source.sourceId, resetAt);
        models[scopedName] = {
          windows: {
            [window.label]: toUsageWindow({
              usedPercent,
              windowSeconds: window.seconds,
              resetAt,
            }),
          },
        };
        mergedAnyModel = true;
      }
    }

    if (!mergedAnyModel) {
      sourceErrors.push(`${source.sourceLabel}: Failed to fetch models`);
    }
  }

  if (!Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models',
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined,
    },
  });
};

export const fetchGoogleQuota = async (): Promise<ProviderResult> => fetchGoogleQuotaForSource(
  'gemini',
  'google',
  'Google',
);

export const fetchAntigravityQuota = async (): Promise<ProviderResult> => fetchGoogleQuotaForSource(
  'antigravity',
  'antigravity',
  'Antigravity',
);

const CLAUDE_USAGE_TIMEOUT_MS = 15_000;
const CLAUDE_PROXY_TIMEOUT_MS = 5_000;
const CLAUDE_USAGE_OUTPUT_LIMIT = 64 * 1024;
const CLAUDE_STATUS_PATH = path.join(os.homedir(), '.cache', 'openchamber', 'claude-code-status.json');
const CLAUDE_FIVE_HOUR_SECONDS = 5 * 60 * 60;
const CLAUDE_SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
const CLAUDE_PROVIDER_NAME = 'Claude';

export const resolveSafeClaudeQuotaUrl = (baseUrl: string | null | undefined): string | null => {
  if (!baseUrl) return null;
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !parsed.port
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    return new URL('/v1/usage/quota', parsed.origin).toString();
  } catch {
    return null;
  }
};

export const resolveClaudeProxyBaseUrlFromProviders = (payload: unknown): string | null => {
  const root = asObject(payload);
  const providers = Array.isArray(root?.providers) ? root.providers : [];
  const anthropic = providers.map(asObject).find((provider) => provider?.id === 'anthropic') ?? null;
  if (!anthropic) return null;
  const options = asObject(anthropic.options);
  const baseUrl = options?.baseURL ?? anthropic.baseURL;
  return typeof baseUrl === 'string' && resolveSafeClaudeQuotaUrl(baseUrl) ? baseUrl : null;
};

const mapClaudeBucketLabel = (type: string) => {
  if (type === 'five_hour') return { label: '5h', windowSeconds: CLAUDE_FIVE_HOUR_SECONDS };
  if (type === 'seven_day') return { label: '7d', windowSeconds: CLAUDE_SEVEN_DAY_SECONDS };
  if (type.startsWith('seven_day_')) {
    const model = type.slice('seven_day_'.length).replace(/_/g, '-');
    return model ? { label: `7d-${model}`, windowSeconds: CLAUDE_SEVEN_DAY_SECONDS } : null;
  }
  return null;
};

const transformClaudeProxyPayload = (payload: unknown): {
  ok: boolean;
  usage?: ProviderUsage;
  usageUpdatedAt?: number;
  error?: string;
} => {
  const root = asObject(payload);
  if (!root || !Array.isArray(root.buckets)) {
    return { ok: false, error: 'Claude quota proxy returned a malformed response.' };
  }
  const windows: Record<string, UsageWindow> = {};
  let usageUpdatedAt = toTimestamp(root.asOf);
  for (const rawBucket of root.buckets) {
    const bucket = asObject(rawBucket);
    if (!bucket || typeof bucket.type !== 'string') continue;
    const mapping = mapClaudeBucketLabel(bucket.type);
    const utilization = toNumber(bucket.utilization);
    if (!mapping || utilization === null || utilization < 0) continue;
    const observedAt = toTimestamp(bucket.observedAt);
    if (observedAt !== null) {
      usageUpdatedAt = usageUpdatedAt === null ? observedAt : Math.max(usageUpdatedAt, observedAt);
    }
    windows[mapping.label] = toUsageWindow({
      usedPercent: utilization * 100,
      windowSeconds: mapping.windowSeconds,
      resetAt: toTimestamp(bucket.resetsAt),
    });
  }
  if (!windows['5h'] && !windows['7d']) {
    return { ok: false, error: 'Claude quota proxy did not return subscription limits.' };
  }
  return { ok: true, usage: { windows }, usageUpdatedAt: usageUpdatedAt ?? Date.now() };
};

const parseClaudeResetAt = (value: string, now: number): number | null => {
  const normalized = value.replace(/\s+\([^)]*\)\s*$/, '').replace(/\bat\b/i, '').trim();
  const withYear = /\b\d{4}\b/.test(normalized)
    ? normalized
    : `${normalized} ${new Date(now).getFullYear()}`;
  const timestamp = new Date(withYear).getTime();
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp < now - 24 * 60 * 60 * 1000 && !/\b\d{4}\b/.test(normalized)) {
    return new Date(`${normalized} ${new Date(now).getFullYear() + 1}`).getTime();
  }
  return timestamp;
};

export const parseClaudeCodeUsageOutput = (raw: string, now = Date.now()): {
  ok: boolean;
  usage?: ProviderUsage;
  usageUpdatedAt?: number;
  error?: string;
} => {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload.is_error === true || typeof payload.result !== 'string') {
      return { ok: false, error: 'Claude Code returned unexpected usage output.' };
    }
    const windows: Record<string, UsageWindow> = {};
    const session = payload.result.match(/Current session:\s*([\d.]+)% used\s*·\s*resets\s+([^\r\n]+)/i);
    const week = payload.result.match(/Current week \(all models\):\s*([\d.]+)% used\s*·\s*resets\s+([^\r\n]+)/i);
    if (session) {
      windows['5h'] = toUsageWindow({
        usedPercent: Number(session[1]),
        windowSeconds: CLAUDE_FIVE_HOUR_SECONDS,
        resetAt: parseClaudeResetAt(session[2], now),
      });
    }
    if (week) {
      windows['7d'] = toUsageWindow({
        usedPercent: Number(week[1]),
        windowSeconds: CLAUDE_SEVEN_DAY_SECONDS,
        resetAt: parseClaudeResetAt(week[2], now),
      });
    }
    const modelPattern = /Current week \((?!all models\))([^):]+)\):\s*([\d.]+)% used\s*·\s*resets\s+([^\r\n]+)/gi;
    for (const match of payload.result.matchAll(modelPattern)) {
      const model = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!model) continue;
      windows[`7d-${model}`] = toUsageWindow({
        usedPercent: Number(match[2]),
        windowSeconds: CLAUDE_SEVEN_DAY_SECONDS,
        resetAt: parseClaudeResetAt(match[3], now),
      });
    }
    if (!windows['5h'] && !windows['7d']) {
      return { ok: false, error: 'Claude Code usage output did not contain subscription limits.' };
    }
    return { ok: true, usage: { windows }, usageUpdatedAt: now };
  } catch {
    return { ok: false, error: 'Claude Code returned malformed usage output.' };
  }
};

const fetchClaudeCodeUsage = (): Promise<ReturnType<typeof parseClaudeCodeUsageOutput>> => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const child = spawn(process.env.CLAUDE_CODE_CLI || 'claude', [
    '-p',
    '/usage',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-turns',
    '1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const finish = (result: ReturnType<typeof parseClaudeCodeUsageOutput>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ ok: false, error: 'Timed out while reading Claude Code usage.' });
  }, CLAUDE_USAGE_TIMEOUT_MS);
  const append = (current: string, chunk: Buffer): string | null => {
    const next = `${current}${String(chunk)}`;
    return Buffer.byteLength(next, 'utf8') <= CLAUDE_USAGE_OUTPUT_LIMIT ? next : null;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    const next = append(stdout, chunk);
    if (next === null) {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'Claude Code usage output exceeded the safe response limit.' });
      return;
    }
    stdout = next;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const next = append(stderr, chunk);
    if (next === null) {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'Claude Code usage error output exceeded the safe response limit.' });
      return;
    }
    stderr = next;
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    finish({ ok: false, error: error.code === 'ENOENT' ? 'Claude Code was not found on PATH.' : error.message });
  });
  child.on('close', (code) => {
    finish(code === 0
      ? parseClaudeCodeUsageOutput(stdout)
      : { ok: false, error: stderr.trim() || stdout.trim() || `Claude Code exited with code ${code}.` });
  });
});

const readDegradedClaudeStatus = (): {
  usage: ProviderUsage | null;
  usageUpdatedAt?: number;
} => {
  try {
    const stats = fs.statSync(CLAUDE_STATUS_PATH);
    if (!stats.isFile() || stats.size > CLAUDE_USAGE_OUTPUT_LIMIT) return { usage: null };
    const payload = JSON.parse(fs.readFileSync(CLAUDE_STATUS_PATH, 'utf8')) as Record<string, unknown>;
    const rateLimits = asObject(payload.rate_limits);
    const fiveHour = asObject(rateLimits?.five_hour);
    const sevenDay = asObject(rateLimits?.seven_day);
    const windows: Record<string, UsageWindow> = {};
    const fiveHourPercent = toNumber(fiveHour?.used_percentage);
    const sevenDayPercent = toNumber(sevenDay?.used_percentage);
    if (fiveHourPercent !== null) {
      windows['5h'] = toUsageWindow({
        usedPercent: fiveHourPercent,
        windowSeconds: CLAUDE_FIVE_HOUR_SECONDS,
        resetAt: toTimestamp(fiveHour?.resets_at),
      });
    }
    if (sevenDayPercent !== null) {
      windows['7d'] = toUsageWindow({
        usedPercent: sevenDayPercent,
        windowSeconds: CLAUDE_SEVEN_DAY_SECONDS,
        resetAt: toTimestamp(sevenDay?.resets_at),
      });
    }
    return Object.keys(windows).length
      ? { usage: { windows }, usageUpdatedAt: stats.mtimeMs }
      : { usage: null };
  } catch {
    return { usage: null };
  }
};

export const fetchClaudeQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  if (options.isExternalRuntime) {
    return buildResult({
      providerId: 'claude',
      providerName: CLAUDE_PROVIDER_NAME,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const auth = (options.readAuth ?? readAuthFile)();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ANTHROPIC_AUTH_ALIASES)) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);
  const fetchImpl = options.fetchImpl ?? (fetch as QuotaFetch);
  let oauthError: string | null = null;

  if (accessToken) {
    try {
      const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
      if (!response.ok) {
        oauthError = `Anthropic OAuth usage returned HTTP ${response.status}.`;
      } else {
        const payload = await response.json() as Record<string, unknown>;
        const windows: Record<string, UsageWindow> = {};
        for (const [key, value] of Object.entries(payload)) {
          if (key !== 'five_hour' && key !== 'seven_day' && !key.startsWith('seven_day_')) continue;
          const usageWindow = asObject(value);
          if (!usageWindow) continue;
          const usedPercent = toNumber(usageWindow.utilization);
          if (usedPercent === null || usedPercent < 0) continue;
          const label = key === 'five_hour'
            ? '5h'
            : key === 'seven_day'
              ? '7d'
              : `7d-${key.slice('seven_day_'.length).replace(/_/g, '-')}`;
          windows[label] = toUsageWindow({
            usedPercent,
            windowSeconds: key === 'five_hour' ? CLAUDE_FIVE_HOUR_SECONDS : CLAUDE_SEVEN_DAY_SECONDS,
            resetAt: toTimestamp(usageWindow.resets_at),
          });
        }
        if (windows['5h'] || windows['7d']) {
          return buildResult({
            providerId: 'claude',
            providerName: CLAUDE_PROVIDER_NAME,
            ok: true,
            configured: true,
            usage: { windows },
            usageUpdatedAt: Date.now(),
          });
        }
        oauthError = 'Anthropic OAuth usage did not return subscription limits.';
      }
    } catch (error) {
      oauthError = error instanceof Error ? error.message : 'Anthropic OAuth usage request failed.';
    }
  }

  if (!options.claudeProxyConfigured) {
    return buildResult({
      providerId: 'claude',
      providerName: CLAUDE_PROVIDER_NAME,
      ok: false,
      configured: Boolean(accessToken),
      error: oauthError ?? 'Not configured',
      ...(oauthError ? { errorCode: 'claude_oauth_usage_unavailable' } : {}),
    });
  }

  let proxyError = 'The active Claude quota proxy could not be resolved.';
  const quotaUrl = resolveSafeClaudeQuotaUrl(options.claudeProxyBaseUrl);
  if (quotaUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_PROXY_TIMEOUT_MS);
    try {
      const response = await fetchImpl(quotaUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        const declaredLength = Number.parseInt(response.headers?.get('content-length') ?? '0', 10);
        if (!Number.isFinite(declaredLength) || declaredLength <= CLAUDE_USAGE_OUTPUT_LIMIT) {
          const raw = response.text ? await response.text() : JSON.stringify(await response.json());
          if (Buffer.byteLength(raw, 'utf8') <= CLAUDE_USAGE_OUTPUT_LIMIT) {
            const transformed = transformClaudeProxyPayload(JSON.parse(raw) as unknown);
            if (transformed.ok) {
              return buildResult({
                providerId: 'claude',
                providerName: CLAUDE_PROVIDER_NAME,
                ok: true,
                configured: true,
                usage: transformed.usage,
                usageUpdatedAt: transformed.usageUpdatedAt,
              });
            }
            proxyError = transformed.error ?? proxyError;
          } else {
            proxyError = 'Claude quota proxy response exceeded the safe response limit.';
          }
        } else {
          proxyError = 'Claude quota proxy response exceeded the safe response limit.';
        }
      } else {
        proxyError = `Claude quota proxy returned HTTP ${response.status}.`;
      }
    } catch (error) {
      proxyError = error instanceof Error ? error.message : 'Failed to read the Claude quota proxy.';
    } finally {
      clearTimeout(timer);
    }
  } else if (options.claudeProxyBaseUrl) {
    proxyError = 'Claude quota proxy URL is not a safe loopback HTTP address.';
  }

  let cliResult: ReturnType<typeof parseClaudeCodeUsageOutput>;
  try {
    cliResult = await (options.fetchClaudeCodeUsage ?? fetchClaudeCodeUsage)();
  } catch (error) {
    cliResult = {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to read Claude Code usage.',
    };
  }
  if (cliResult.ok) {
    return buildResult({
      providerId: 'claude',
      providerName: CLAUDE_PROVIDER_NAME,
      ok: true,
      configured: true,
      usage: cliResult.usage,
      usageUpdatedAt: cliResult.usageUpdatedAt,
    });
  }
  const degraded = readDegradedClaudeStatus();
  return buildResult({
    providerId: 'claude',
    providerName: CLAUDE_PROVIDER_NAME,
    ok: false,
    configured: true,
    usage: degraded.usage,
    usageUpdatedAt: degraded.usageUpdatedAt,
    error: cliResult.error ?? proxyError ?? oauthError ?? 'Claude usage is unavailable.',
    errorCode: 'claude_code_usage_failed',
  });
};

const isCopilotTokenBasedBillingPayload = (payload: Record<string, unknown>) => (
  typeof payload.token_based_billing !== 'undefined'
  || payload.billing_model === 'usage_based'
  || payload.billing_model === 'token_based'
  || payload.usage_based_billing === true
);

const resolveCopilotResetAt = (payload: Record<string, unknown>) => (
  toTimestamp(payload.quota_reset_date_utc)
  ?? toTimestamp(payload.quota_reset_date)
);

const buildCopilotWindows = (payload: Record<string, unknown>) => {
  const quota = (payload.quota_snapshots as Record<string, unknown>) ?? {};
  const resetAt = resolveCopilotResetAt(payload);
  const isTokenBasedBilling = isCopilotTokenBasedBillingPayload(payload);
  const windows: Record<string, UsageWindow> = {};

  const addWindow = (
    label: string,
    snapshot?: Record<string, unknown>,
    options: { unit?: 'credits' | 'requests'; description?: string } = {},
  ) => {
    if (!snapshot) return;
    const entitlement = toNumber(snapshot.entitlement);
    const remaining = toNumber(snapshot.remaining) ?? toNumber(snapshot.quota_remaining);
    const percentRemaining = toNumber(snapshot.percent_remaining);
    const usedPercent = entitlement && remaining !== null
      ? Math.max(0, Math.min(100, 100 - (remaining / entitlement) * 100))
      : percentRemaining !== null
        ? Math.max(0, Math.min(100, 100 - percentRemaining))
      : null;
    const valueLabel = entitlement !== null && remaining !== null && options.unit
      ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} ${options.unit} left`
      : entitlement !== null && remaining !== null
        ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} left`
      : null;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel,
      description: options.description,
    });
  };

  if (isTokenBasedBilling) {
    addWindow(
      'ai-credits',
      (quota.premium_interactions ?? quota.ai_credits ?? quota.credits) as Record<string, unknown> | undefined,
      { unit: 'credits', description: COPILOT_AI_CREDITS_DESCRIPTION },
    );
    return windows;
  }

  addWindow('chat', quota.chat as Record<string, unknown> | undefined, { unit: 'requests' });
  addWindow('completions', quota.completions as Record<string, unknown> | undefined, { unit: 'requests' });
  addWindow('premium', quota.premium_interactions as Record<string, unknown> | undefined, { unit: 'requests' });

  return windows;
};

export const fetchCopilotQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const readAuth = options.readAuth ?? readAuthFile;
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

  if (!accessToken) {
    return buildResult({
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetchImpl('https://api.github.com/copilot_internal/user', {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    return buildResult({
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) },
    });
  } catch (error) {
    return buildResult({
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

export const fetchCopilotAddonQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const readAuth = options.readAuth ?? readAuthFile;
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

  if (!accessToken) {
    return buildResult({
      providerId: 'github-copilot-addon',
      providerName: 'GitHub Copilot Add-on',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetchImpl('https://api.github.com/copilot_internal/user', {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'github-copilot-addon',
        providerName: 'GitHub Copilot Add-on',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows = buildCopilotWindows(payload);
    const premium = windows['ai-credits']
      ? { 'ai-credits': windows['ai-credits'] }
      : windows.premium
        ? { premium: windows.premium }
        : windows;

    return buildResult({
      providerId: 'github-copilot-addon',
      providerName: 'GitHub Copilot Add-on',
      ok: true,
      configured: true,
      usage: { windows: premium },
    });
  } catch (error) {
    return buildResult({
      providerId: 'github-copilot-addon',
      providerName: 'GitHub Copilot Add-on',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

export const fetchKimiQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['kimi-for-coding', 'kimi'])) as Record<string, unknown> | null;
  return fetchKimiQuotaAdapter({
    credential: {
      apiKey: (entry?.key as string | undefined) ?? (entry?.token as string | undefined) ?? '',
    },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};

const fetchMiniMaxQuota = async (data: {
  providerId: 'minimax-coding-plan' | 'minimax-cn-coding-plan';
  providerName: string;
  endpoint: string;
  usageFieldsAreRemaining: boolean;
}): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, [data.providerId])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch(data.endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const baseResp = asObject(payload.base_resp);
    const statusCode = toNumber(baseResp?.status_code);
    if (baseResp && statusCode !== 0) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: asNonEmptyString(baseResp.status_msg) ?? `API error: ${statusCode}`,
      });
    }

    const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : [];
    const firstModel = asObject(modelRemains[0]);
    if (!firstModel) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: 'No model quota data available',
      });
    }

    const intervalTotal = toNumber(firstModel.current_interval_total_count);
    const intervalUsage = toNumber(firstModel.current_interval_usage_count);
    const intervalStartAt = toTimestamp(firstModel.start_time);
    const intervalResetAt = toTimestamp(firstModel.end_time);
    const weeklyTotal = toNumber(firstModel.current_weekly_total_count);
    const weeklyUsage = toNumber(firstModel.current_weekly_usage_count);
    const weeklyStartAt = toTimestamp(firstModel.weekly_start_time);
    const weeklyResetAt = toTimestamp(firstModel.weekly_end_time);

    const intervalUsed = data.usageFieldsAreRemaining && intervalTotal !== null && intervalUsage !== null
      ? intervalTotal - intervalUsage
      : intervalUsage;
    const weeklyUsed = data.usageFieldsAreRemaining && weeklyTotal !== null && weeklyUsage !== null
      ? weeklyTotal - weeklyUsage
      : weeklyUsage;

    const intervalUsedPercent = intervalTotal !== null && intervalTotal > 0 && intervalUsed !== null
      ? Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100))
      : null;
    const intervalWindowSeconds = intervalStartAt && intervalResetAt && intervalResetAt > intervalStartAt
      ? Math.floor((intervalResetAt - intervalStartAt) / 1000)
      : null;
    const weeklyUsedPercent = weeklyTotal !== null && weeklyTotal > 0 && weeklyUsed !== null
      ? Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100))
      : null;
    const weeklyWindowSeconds = weeklyStartAt && weeklyResetAt && weeklyResetAt > weeklyStartAt
      ? Math.floor((weeklyResetAt - weeklyStartAt) / 1000)
      : null;

    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          '5h': toUsageWindow({
            usedPercent: intervalUsedPercent,
            windowSeconds: intervalWindowSeconds,
            resetAt: intervalResetAt,
          }),
          weekly: toUsageWindow({
            usedPercent: weeklyUsedPercent,
            windowSeconds: weeklyWindowSeconds,
            resetAt: weeklyResetAt,
          }),
        },
      },
    });
  } catch (error) {
    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

export const fetchMiniMaxCodingPlanQuota = () => fetchMiniMaxQuota({
  providerId: 'minimax-coding-plan',
  providerName: 'MiniMax Coding Plan (minimax.io)',
  endpoint: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  usageFieldsAreRemaining: false,
});

export const fetchMiniMaxCnCodingPlanQuota = () => fetchMiniMaxQuota({
  providerId: 'minimax-cn-coding-plan',
  providerName: 'MiniMax Coding Plan (minimaxi.com)',
  endpoint: 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  usageFieldsAreRemaining: true,
});

export const parseOllamaSettingsHtml = (html: string) => {
  const windows: Record<string, UsageWindow> = {};
  const sessionMatch = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
  if (sessionMatch) {
    windows.session = toUsageWindow({
      usedPercent: toNumber(sessionMatch[1]),
      windowSeconds: null,
      resetAt: null,
    });
  }

  const weeklyMatch = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
  if (weeklyMatch) {
    windows.weekly = toUsageWindow({
      usedPercent: toNumber(weeklyMatch[1]),
      windowSeconds: null,
      resetAt: null,
    });
  }

  const premiumMatch = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premiumMatch) {
    const used = toNumber(premiumMatch[1]);
    const total = toNumber(premiumMatch[2]);
    const usedPercent = total && used !== null ? Math.min(100, (used / total) * 100) : null;
    windows.premium = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${used ?? 0} / ${total ?? 0}`,
    });
  }

  return windows;
};

export const resolveOllamaCloudCredential = (options: FetchQuotaOptions = {}) => {
  const managed = (options.readManagedCredential ?? readManagedQuotaCredential)('ollama-cloud');
  const managedRecord = asObject(managed);
  const managedCookie = asNonEmptyString(managedRecord?.cookie);
  if (managedCookie) {
    return {
      credential: { cookie: managedCookie } satisfies OllamaCloudCredential,
      source: 'managed' as const,
    };
  }
  const legacyCookie = options.readLegacyOllamaCookie
    ? options.readLegacyOllamaCookie()
    : readTextFile(OLLAMA_CLOUD_COOKIE_PATH);
  return legacyCookie
    ? {
        credential: { cookie: legacyCookie } satisfies OllamaCloudCredential,
        source: 'legacy' as const,
      }
    : { credential: null, source: null };
};

export const validateOllamaCloudQuotaCredential = async (
  credential: OllamaCloudCredential,
  fetchImpl: QuotaFetch = fetch,
) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: {
      Cookie: credential.cookie,
      'User-Agent': 'DevRyan quota provider',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  if (typeof response.text !== 'function') throw new Error('Ollama Cloud response did not include HTML content');
  const windows = parseOllamaSettingsHtml(await response.text());
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

export const fetchOllamaCloudQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const { credential } = resolveOllamaCloudCredential(options);

  if (!credential) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: true,
      configured: true,
      usage: { windows: await validateOllamaCloudQuotaCredential(credential, options.fetchImpl ?? fetch) },
    });
  } catch (error) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

export const fetchOpenRouterQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['openrouter'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/credits', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const credits = payload.data as Record<string, unknown> | undefined;
    const totalCredits = toNumber(credits?.total_credits);
    const totalUsage = toNumber(credits?.total_usage);
    const remaining = totalCredits !== null && totalUsage !== null
      ? Math.max(0, totalCredits - totalUsage)
      : null;
    let valueLabel: string | null = null;
    if (remaining !== null && totalUsage !== null) {
      valueLabel = `$${formatMoney(remaining)} left · $${formatMoney(totalUsage)} spent`;
    }

    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: true,
      configured: true,
      usage: {
        windows: {
          credits: toUsageWindow({
            usedPercent: null,
            windowSeconds: null,
            resetAt: null,
            valueLabel,
          }),
        },
      },
    });
  } catch (error) {
    return buildResult({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};


const normalizeTimestamp = (value: unknown) => {
  if (typeof value !== 'number') return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const resolveWindowSeconds = (limit: Record<string, unknown> | undefined) => {
  if (!limit || typeof limit.number !== 'number') return null;
  const unitSeconds = ZAI_TOKEN_WINDOW_SECONDS[Number(limit.unit)];
  if (!unitSeconds) return null;
  return unitSeconds * limit.number;
};

export const fetchZaiQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai'])) as Record<string, unknown> | null;
  return fetchZaiQuotaAdapter({
    credential: {
      apiKey: (entry?.key as string | undefined) ?? (entry?.token as string | undefined) ?? '',
    },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
  });
};

export const fetchZhipuaiCodingPlanQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'zhipuai-coding-plan',
        providerName: 'Zhipu AI Coding Plan',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as ZhipuaiPayload;
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];

    const tokensLimit = limits.find((limit): limit is ZhipuaiTokensLimit => limit?.type === 'TOKENS_LIMIT');
    const mcpToolsTimeLimit = limits.find((limit): limit is ZhipuaiMcpTimeLimit => limit?.type === 'TIME_LIMIT');

    const windows: Record<string, UsageWindow> = {};

    // Handle TOKENS_LIMIT (5-hour window for token usage)
    if (tokensLimit) {
      const windowSeconds = resolveWindowSeconds(tokensLimit);
      const resetAt = tokensLimit?.nextResetTime ? normalizeTimestamp(tokensLimit.nextResetTime) : null;
      const usedPercent = typeof tokensLimit?.percentage === 'number' ? tokensLimit.percentage : null;

      windows['Tokens'] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
      });
    }

    // Handle TIME_LIMIT (MCP tools monthly window)
    if (mcpToolsTimeLimit) {
      // TIME_LIMIT unit=5 means 1 month (30 days)
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = typeof mcpToolsTimeLimit?.percentage === 'number' ? mcpToolsTimeLimit.percentage : null;

      windows['MCP Tools'] = toUsageWindow({
        usedPercent,
        windowSeconds: monthSeconds,
        resetAt,
      });
    }

    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const NANO_GPT_DAILY_WINDOW_SECONDS = 86400;

export const fetchNanoGptQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'nano-gpt',
      providerName: 'NanoGPT',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://nano-gpt.com/api/subscription/v1/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'nano-gpt',
        providerName: 'NanoGPT',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows: Record<string, UsageWindow> = {};
    const period = payload.period as Record<string, unknown> | undefined;
    const daily = payload.daily as Record<string, unknown> | undefined;
    const monthly = payload.monthly as Record<string, unknown> | undefined;
    const state = (payload.state as string) ?? 'active';

    if (daily) {
      let usedPercent: number | null = null;
      const percentUsed = daily.percentUsed as number | undefined;
      if (typeof percentUsed === 'number') {
        usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
      } else {
        const used = toNumber(daily.used);
        const limit = toNumber((daily.limit as number | undefined) ?? (daily.limits as Record<string, unknown>)?.daily);
        if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      const resetAt = toTimestamp(daily.resetAt);
      const valueLabel = state !== 'active' ? `(${state})` : null;
      windows['daily'] = toUsageWindow({
        usedPercent,
        windowSeconds: NANO_GPT_DAILY_WINDOW_SECONDS,
        resetAt,
        valueLabel,
      });
    }

    if (monthly) {
      let usedPercent: number | null = null;
      const percentUsed = monthly.percentUsed as number | undefined;
      if (typeof percentUsed === 'number') {
        usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
      } else {
        const used = toNumber(monthly.used);
        const limit = toNumber((monthly.limit as number | undefined) ?? (monthly.limits as Record<string, unknown>)?.monthly);
        if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      const resetAt = toTimestamp((monthly.resetAt as string | number | undefined) ?? (period as Record<string, unknown>)?.currentPeriodEnd);
      const valueLabel = state !== 'active' ? `(${state})` : null;
      windows['monthly'] = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt,
        valueLabel,
      });
    }

    return buildResult({
      providerId: 'nano-gpt',
      providerName: 'NanoGPT',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'nano-gpt',
      providerName: 'NanoGPT',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

export const fetchQuotaForProvider = async (providerId: string, options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  switch (providerId) {
    case 'claude':
      return fetchClaudeQuota(options);
    case 'codex':
      return fetchCodexQuota(options);
    case 'xai':
    case 'grok':
    case 'xai-oauth':
      return fetchXaiQuota(options);
    case 'opencode':
    case 'zen':
    case 'opencode-zen':
      return fetchOpenCodeZenQuota(options);
    case 'opencode-go':
      return fetchOpenCodeGoQuota(options);
    case 'cursor-acp':
    case 'cursor':
      return fetchCursorAcpQuota(options);
    case 'deepseek':
      return fetchDeepSeekQuota(options);
    case 'github-copilot':
      return fetchCopilotQuota(options);
    case 'github-copilot-addon':
      return fetchCopilotAddonQuota(options);
    case 'google':
      return fetchGoogleQuota();
    case 'antigravity':
      return fetchAntigravityQuota();
    case 'kimi-for-coding':
      return fetchKimiQuota(options);
    case 'nano-gpt':
      return fetchNanoGptQuota();
    case 'minimax-coding-plan':
      return fetchMiniMaxCodingPlanQuota();
    case 'minimax-cn-coding-plan':
      return fetchMiniMaxCnCodingPlanQuota();
    case 'ollama-cloud':
      return fetchOllamaCloudQuota(options);
    case 'openrouter':
      return fetchOpenRouterQuota();
    case 'zai-coding-plan':
      return fetchZaiQuota(options);
    case 'zhipuai-coding-plan':
      return fetchZhipuaiCodingPlanQuota();
    default:
      return buildResult({
        providerId,
        providerName: providerId,
        ok: false,
        configured: false,
        error: 'Unsupported provider',
      });
  }
};
