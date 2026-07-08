import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
}>;

type FetchQuotaOptions = {
  readAuth?: () => AuthFile;
  fetchImpl?: QuotaFetch;
};

type OpenAiUsagePayload = {
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    };
    secondary_window?: {
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    };
  };
  credits?: {
    balance?: number | string;
    unlimited?: boolean;
  };
  rate_limit_reset_credits?: {
    available_count?: number | string;
    total_earned_count?: number | string;
  };
  rateLimitResetCredits?: {
    availableCount?: number | string;
    totalEarnedCount?: number | string;
  };
};

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

type ZaiLimit = {
  type?: string;
  number?: number;
  unit?: number;
  nextResetTime?: number;
  percentage?: number;
};

type ZaiPayload = {
  data?: {
    limits?: ZaiLimit[];
  };
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
  error?: string;
};

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');
const OLLAMA_CLOUD_COOKIE_PATH = path.join(os.homedir(), '.config', 'ollama-quota', 'cookie');
const CURSOR_CURRENT_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard?tab=spending';
const CURSOR_AUTO_COMPOSER_DESCRIPTION = 'Additional usage beyond limits consumes API quota or on-demand spend.';
const CURSOR_API_DESCRIPTION = 'Additional usage beyond limits consumes on-demand spend.';
const COPILOT_AI_CREDITS_DESCRIPTION = 'AI Credits are consumed from token usage, including input, output, and cached tokens.';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';


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
const OPENCODE_GO_WORKSPACE_ID_PATTERN = /^wrk_[a-zA-Z0-9]+$/;
const OPENCODE_GO_DASHBOARD_USAGE_ERROR = 'OpenCode Go usage tracking requires OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE, or usageWorkspaceId and usageAuthCookie in auth["opencode-go"].';
const OPENCODE_GO_AUTH_COOKIE_ERROR = 'OpenCode Go dashboard authentication failed. Update OPENCODE_GO_AUTH_COOKIE or auth["opencode-go"].usageAuthCookie.';
const OPENCODE_GO_WINDOW_DEFINITIONS = {
  rolling: {
    label: 'rolling',
    windowSeconds: 5 * 60 * 60,
    description: '$12 of usage every 5 hours.',
  },
  weekly: {
    label: 'weekly',
    windowSeconds: 7 * 24 * 60 * 60,
    description: '$30 of usage per week.',
  },
  monthly: {
    label: 'monthly',
    windowSeconds: 30 * 24 * 60 * 60,
    description: '$60 of usage per month.',
  },
} as const;

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
}): ProviderResult => ({
  providerId: data.providerId,
  providerName: data.providerName,
  ok: data.ok,
  configured: data.configured,
  usage: data.usage ?? null,
  ...(data.error ? { error: data.error } : {}),
  fetchedAt: Date.now(),
});

const formatMoney = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};

const durationToLabel = (duration?: number, unit?: string) => {
  if (!duration || !unit) return 'limit';
  if (unit === 'TIME_UNIT_MINUTE') return `${duration}m`;
  if (unit === 'TIME_UNIT_HOUR') return `${duration}h`;
  if (unit === 'TIME_UNIT_DAY') return `${duration}d`;
  return 'limit';
};

const durationToSeconds = (duration?: number, unit?: string) => {
  if (!duration || !unit) return null;
  if (unit === 'TIME_UNIT_MINUTE') return duration * 60;
  if (unit === 'TIME_UNIT_HOUR') return duration * 3600;
  if (unit === 'TIME_UNIT_DAY') return duration * 86400;
  return null;
};

export const listConfiguredQuotaProviders = () => {
  const auth = readAuthFile();
  const configured = new Set<string>();

  const anthropicAuth = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude']));
  if (anthropicAuth && ((anthropicAuth as Record<string, unknown>).access || (anthropicAuth as Record<string, unknown>).token)) {
    configured.add('claude');
  }

  const openaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt']));
  if (openaiAuth && ((openaiAuth as Record<string, unknown>).access || (openaiAuth as Record<string, unknown>).token)) {
    configured.add('codex');
  }

  const opencodeGoAuth = normalizeAuthEntry(getAuthEntry(auth, OPENCODE_GO_ALIASES));
  if (
    opencodeGoAuth &&
    (
      (opencodeGoAuth as Record<string, unknown>).key ||
      (opencodeGoAuth as Record<string, unknown>).token ||
      (opencodeGoAuth as Record<string, unknown>).access ||
      (
        (opencodeGoAuth as Record<string, unknown>).usageWorkspaceId &&
        (opencodeGoAuth as Record<string, unknown>).usageAuthCookie
      )
    )
  ) {
    configured.add('opencode-go');
  } else if (process.env.OPENCODE_GO_WORKSPACE_ID && process.env.OPENCODE_GO_AUTH_COOKIE) {
    configured.add('opencode-go');
  }

  if (getCursorUsageSessionToken(auth)) {
    configured.add('cursor-acp');
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

  const minimaxAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-coding-plan']));
  if (minimaxAuth && ((minimaxAuth as Record<string, unknown>).key || (minimaxAuth as Record<string, unknown>).token)) {
    configured.add('minimax-coding-plan');
  }

  const minimaxCnAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-cn-coding-plan']));
  if (minimaxCnAuth && ((minimaxCnAuth as Record<string, unknown>).key || (minimaxCnAuth as Record<string, unknown>).token)) {
    configured.add('minimax-cn-coding-plan');
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

  if (readTextFile(OLLAMA_CLOUD_COOKIE_PATH)) {
    configured.add('ollama-cloud');
  }

  return Array.from(configured);
};

const buildCodexHeaders = (accessToken: string, accountId?: string, extraHeaders: Record<string, string> = {}) => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  ...extraHeaders,
});

const normalizeResetCredit = (value: unknown, index: number): UsageResetCredit | null => {
  const credit = asObject(value);
  if (!credit) return null;

  const grantedAt = toTimestamp(credit.granted_at ?? credit.grantedAt);
  const expiresAt = toTimestamp(credit.expires_at ?? credit.expiresAt);
  return {
    id: asNonEmptyString(credit.id) ?? `reset-credit-${index}`,
    status: asNonEmptyString(credit.status) ?? 'available',
    resetType: asNonEmptyString(credit.reset_type ?? credit.resetType),
    grantedAt,
    grantedAtFormatted: grantedAt ? formatResetTime(grantedAt) : null,
    expiresAt,
    expiresAtFormatted: expiresAt ? formatResetTime(expiresAt) : null,
  };
};

const normalizeResetCreditsPayload = (payload: unknown, source: UsageResetCredits['source']): UsageResetCredits | null => {
  const data = asObject(payload);
  if (!data) return null;

  const credits = Array.isArray(data.credits)
    ? data.credits.map(normalizeResetCredit).filter((credit): credit is UsageResetCredit => Boolean(credit))
    : [];
  const availableCount = toNumber(data.available_count ?? data.availableCount);
  const totalEarnedCount = toNumber(data.total_earned_count ?? data.totalEarnedCount);

  if (availableCount === null && totalEarnedCount === null && credits.length === 0) {
    return null;
  }

  return {
    availableCount,
    totalEarnedCount,
    credits,
    source,
  };
};

const fetchDedicatedResetCredits = async (
  fetchImpl: QuotaFetch,
  accessToken: string,
  accountId?: string,
): Promise<UsageResetCredits | null> => {
  try {
    const response = await fetchImpl(CODEX_RESET_CREDITS_URL, {
      method: 'GET',
      headers: buildCodexHeaders(accessToken, accountId, {
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop',
      }),
    });
    if (!response.ok) return null;
    return normalizeResetCreditsPayload(await response.json(), 'dedicated');
  } catch {
    return null;
  }
};

const getFallbackResetCredits = (payload: OpenAiUsagePayload): UsageResetCredits | null => {
  const fallback = payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits;
  return normalizeResetCreditsPayload(fallback, 'usage');
};

export const fetchCodexQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const fetchImpl = options.fetchImpl ?? fetch;
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);
  const accountId = entry?.accountId as string | undefined;

  if (!accessToken) {
    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetchImpl(CODEX_USAGE_URL, {
      method: 'GET',
      headers: buildCodexHeaders(accessToken, accountId),
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'codex',
        providerName: 'Codex',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as OpenAiUsagePayload;
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;
    const resetCredits = await fetchDedicatedResetCredits(fetchImpl, accessToken, accountId)
      ?? getFallbackResetCredits(payload);

    const windows: Record<string, UsageWindow> = {};
    if (primary) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds: toNumber(primary.limit_window_seconds),
        resetAt: toTimestamp(primary.reset_at),
      });
    }
    if (secondary) {
      windows['weekly'] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds: toNumber(secondary.limit_window_seconds),
        resetAt: toTimestamp(secondary.reset_at),
      });
    }
    if (credits && !resetCredits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const valueLabel = unlimited
        ? 'Unlimited'
        : balance !== null
          ? `$${formatMoney(balance)} remaining`
          : null;
      windows.credits = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel,
      });
    }

    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: true,
      configured: true,
      usage: {
        windows,
        ...(resetCredits ? { resetCredits } : {}),
      },
    });
  } catch (error) {
    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const resolveOpenCodeGoCredentials = (options: FetchQuotaOptions = {}) => {
  const auth = options.readAuth?.() ?? readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, OPENCODE_GO_ALIASES)) as Record<string, unknown> | null;
  const apiKey = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token) ?? asNonEmptyString(entry?.access);
  const workspaceId = asNonEmptyString(process.env.OPENCODE_GO_WORKSPACE_ID)
    ?? asNonEmptyString(entry?.usageWorkspaceId);
  const authCookie = asNonEmptyString(process.env.OPENCODE_GO_AUTH_COOKIE)
    ?? asNonEmptyString(entry?.usageAuthCookie);

  return {
    apiConfigured: Boolean(apiKey),
    usageConfigured: Boolean(workspaceId && authCookie),
    workspaceId,
    authCookie,
  };
};

const extractBalancedObjectLiteral = (source: string, openBraceIndex: number): string | null => {
  let depth = 0;
  let stringQuote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (stringQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex, index + 1);
      }
    }
  }

  return null;
};

const parseObjectLiteral = (objectLiteral: string): Record<string, unknown> | null => {
  try {
    const jsonLike = objectLiteral.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
    return JSON.parse(jsonLike) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const extractOpenCodeGoUsageObject = (html: string, key: keyof typeof OPENCODE_GO_WINDOW_DEFINITIONS): Record<string, unknown> | null => {
  const pattern = new RegExp(`["']?${key}Usage["']?\\s*[:=]?\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{`, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const openBraceIndex = match.index + match[0].lastIndexOf('{');
    const objectLiteral = extractBalancedObjectLiteral(html, openBraceIndex);
    if (!objectLiteral) continue;

    const usage = parseObjectLiteral(objectLiteral);
    if (usage) return usage;
  }

  return null;
};

const buildOpenCodeGoUsage = (html: string): ProviderUsage => {
  const windows: Record<string, UsageWindow> = {};
  const now = Date.now();

  for (const [key, definition] of Object.entries(OPENCODE_GO_WINDOW_DEFINITIONS) as Array<[keyof typeof OPENCODE_GO_WINDOW_DEFINITIONS, typeof OPENCODE_GO_WINDOW_DEFINITIONS[keyof typeof OPENCODE_GO_WINDOW_DEFINITIONS]]>) {
    const usage = extractOpenCodeGoUsageObject(html, key);
    if (!usage) continue;

    const resetInSec = toNumber(usage.resetInSec);
    windows[definition.label] = toUsageWindow({
      usedPercent: toNumber(usage.usagePercent),
      windowSeconds: definition.windowSeconds,
      resetAt: resetInSec === null ? null : now + resetInSec * 1000,
      description: definition.description,
    });
  }

  if (Object.keys(windows).length === 0) {
    throw new Error('OpenCode Go dashboard usage fields were not found. The website structure may have changed.');
  }

  return { windows };
};

export const fetchOpenCodeGoQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = resolveOpenCodeGoCredentials(options);

  if (!credentials.apiConfigured && !credentials.usageConfigured) {
    return buildResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  if (!credentials.usageConfigured) {
    return buildResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: OPENCODE_GO_DASHBOARD_USAGE_ERROR,
    });
  }

  if (!credentials.workspaceId || !OPENCODE_GO_WORKSPACE_ID_PATTERN.test(credentials.workspaceId)) {
    return buildResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: 'Invalid OpenCode Go workspace ID format.',
    });
  }

  try {
    const response = await fetchImpl(`https://opencode.ai/workspace/${encodeURIComponent(credentials.workspaceId)}/go`, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: `auth=${credentials.authCookie}`,
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'opencode-go',
        providerName: 'OpenCode Go',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? OPENCODE_GO_AUTH_COOKIE_ERROR
          : `OpenCode Go dashboard request failed: ${response.status}`,
      });
    }

    if (typeof response.text !== 'function') {
      throw new Error('OpenCode Go dashboard response did not include HTML content.');
    }

    return buildResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: true,
      configured: true,
      usage: buildOpenCodeGoUsage(await response.text()),
    });
  } catch (error) {
    return buildResult({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const getCursorUsageSessionToken = (auth: AuthFile): string | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['cursor-acp']));
  return asNonEmptyString(entry?.usageSessionToken);
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
    description: CURSOR_AUTO_COMPOSER_DESCRIPTION,
  });
  windows.api = toUsageWindow({
    usedPercent: apiPercent,
    windowSeconds,
    resetAt: billingCycleEnd,
    description: CURSOR_API_DESCRIPTION,
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
    },
  },
];

export const fetchCursorAcpQuota = async (options: FetchQuotaOptions = {}): Promise<ProviderResult> => {
  const readAuth = options.readAuth ?? readAuthFile;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessionToken = getCursorUsageSessionToken(readAuth());

  if (!sessionToken) {
    return buildResult({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: false,
      configured: false,
      error: 'Cursor usage tracking is not configured.',
    });
  }

  try {
    let response: Awaited<ReturnType<QuotaFetch>> | null = null;
    for (const tokenCandidate of getCursorUsageSessionTokenCandidates(sessionToken)) {
      for (const request of buildCursorUsageRequests(tokenCandidate)) {
        response = await fetchImpl(request.url, request.init);
        if (response.ok) {
          break;
        }
      }
      if (response?.ok) {
        break;
      }
    }

    if (!response?.ok) {
      return buildResult({
        providerId: 'cursor-acp',
        providerName: 'Cursor',
        ok: false,
        configured: true,
        error: response?.status === 401
          ? 'Cursor session expired. Update the Cursor usage session token.'
          : `Cursor usage API error: ${response?.status ?? 'unknown'}`,
      });
    }

    return buildResult({
      providerId: 'cursor-acp',
      providerName: 'Cursor',
      ok: true,
      configured: true,
      usage: buildCursorUsage(await response.json()),
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

export const fetchClaudeQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

  if (!accessToken) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows: Record<string, UsageWindow> = {};
    const fiveHour = (payload as Record<string, unknown>).five_hour as Record<string, unknown> | undefined;
    const sevenDay = (payload as Record<string, unknown>).seven_day as Record<string, unknown> | undefined;
    const sevenDaySonnet = (payload as Record<string, unknown>).seven_day_sonnet as Record<string, unknown> | undefined;
    const sevenDayOpus = (payload as Record<string, unknown>).seven_day_opus as Record<string, unknown> | undefined;

    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(fiveHour.resets_at),
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDay.resets_at),
      });
    }
    if (sevenDaySonnet) {
      windows['7d-sonnet'] = toUsageWindow({
        usedPercent: toNumber(sevenDaySonnet.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDaySonnet.resets_at),
      });
    }
    if (sevenDayOpus) {
      windows['7d-opus'] = toUsageWindow({
        usedPercent: toNumber(sevenDayOpus.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDayOpus.resets_at),
      });
    }

    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
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

export const fetchKimiQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['kimi-for-coding', 'kimi'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'kimi-for-coding',
      providerName: 'Kimi for Coding',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://api.kimi.com/coding/v1/usages', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'kimi-for-coding',
        providerName: 'Kimi for Coding',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const windows: Record<string, UsageWindow> = {};
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (usage) {
      const limit = toNumber(usage.limit);
      const remaining = toNumber(usage.remaining);
      const usedPercent = limit && remaining !== null
        ? Math.max(0, Math.min(100, 100 - (remaining / limit) * 100))
        : null;
      windows.weekly = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt: toTimestamp(usage.resetTime),
      });
    }

    const limits = Array.isArray(payload.limits) ? payload.limits : [];
    for (const limit of limits) {
      const window = (limit as Record<string, unknown>)?.window as Record<string, unknown> | undefined;
      const detail = (limit as Record<string, unknown>)?.detail as Record<string, unknown> | undefined;
      const rawLabel = durationToLabel(window?.duration as number | undefined, window?.timeUnit as string | undefined);
      const windowSeconds = durationToSeconds(window?.duration as number | undefined, window?.timeUnit as string | undefined);
      const label = windowSeconds === 5 * 60 * 60 ? `Rate Limit (${rawLabel})` : rawLabel;
      const total = toNumber(detail?.limit);
      const remaining = toNumber(detail?.remaining);
      const usedPercent = total && remaining !== null
        ? Math.max(0, Math.min(100, 100 - (remaining / total) * 100))
        : null;
      windows[label] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt: toTimestamp(detail?.resetTime),
      });
    }

    return buildResult({
      providerId: 'kimi-for-coding',
      providerName: 'Kimi for Coding',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'kimi-for-coding',
      providerName: 'Kimi for Coding',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
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

const parseOllamaSettingsHtml = (html: string) => {
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

export const fetchOllamaCloudQuota = async (): Promise<ProviderResult> => {
  const cookie = readTextFile(OLLAMA_CLOUD_COOKIE_PATH);

  if (!cookie) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://ollama.com/settings', {
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'ollama-cloud',
        providerName: 'Ollama Cloud',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: true,
      configured: true,
      usage: { windows: parseOllamaSettingsHtml(await response.text()) },
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

const resolveWindowLabel = (windowSeconds: number | null) => {
  if (!windowSeconds) return 'tokens';
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400;
    return days === 7 ? 'weekly' : `${days}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }
  return `${windowSeconds}s`;
};

export const fetchZaiQuota = async (): Promise<ProviderResult> => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'zai-coding-plan',
        providerName: 'z.ai',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as ZaiPayload;
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];
    const tokensLimit = limits.find((limit: Record<string, unknown>) => limit?.type === 'TOKENS_LIMIT');
    const windowSeconds = resolveWindowSeconds(tokensLimit as Record<string, unknown> | undefined);
    const windowLabel = resolveWindowLabel(windowSeconds);
    const resetAt = tokensLimit?.nextResetTime ? normalizeTimestamp(tokensLimit.nextResetTime) : null;
    const usedPercent = typeof tokensLimit?.percentage === 'number' ? tokensLimit.percentage : null;

    const windows: Record<string, UsageWindow> = {};
    if (tokensLimit) {
      windows[windowLabel] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
      });
    }

    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'zai-coding-plan',
      providerName: 'z.ai',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
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
      return fetchClaudeQuota();
    case 'codex':
      return fetchCodexQuota(options);
    case 'opencode-go':
      return fetchOpenCodeGoQuota(options);
    case 'cursor-acp':
      return fetchCursorAcpQuota(options);
    case 'github-copilot':
      return fetchCopilotQuota(options);
    case 'github-copilot-addon':
      return fetchCopilotAddonQuota(options);
    case 'google':
      return fetchGoogleQuota();
    case 'antigravity':
      return fetchAntigravityQuota();
    case 'kimi-for-coding':
      return fetchKimiQuota();
    case 'nano-gpt':
      return fetchNanoGptQuota();
    case 'minimax-coding-plan':
      return fetchMiniMaxCodingPlanQuota();
    case 'minimax-cn-coding-plan':
      return fetchMiniMaxCnCodingPlanQuota();
    case 'ollama-cloud':
      return fetchOllamaCloudQuota();
    case 'openrouter':
      return fetchOpenRouterQuota();
    case 'zai-coding-plan':
      return fetchZaiQuota();
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
