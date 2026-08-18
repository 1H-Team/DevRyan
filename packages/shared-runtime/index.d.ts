export interface ArchiveLimits {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxPathBytes?: number;
  maxDepth?: number;
}

export type ArchiveRejectionCode =
  | 'ARCHIVE_DOWNLOAD_TOO_LARGE'
  | 'ARCHIVE_ENTRY_LIMIT'
  | 'ARCHIVE_INVALID_PATH'
  | 'ARCHIVE_PATH_COLLISION'
  | 'ARCHIVE_UNSAFE_ENTRY'
  | 'ARCHIVE_SIZE_LIMIT'
  | 'ARCHIVE_CORRUPT'
  | 'ARCHIVE_MISSING_SKILL_FILE'
  | 'ARCHIVE_DOWNLOAD_TIMEOUT';

export class ArchiveRejectionError extends Error {
  readonly code: ArchiveRejectionCode;
  constructor(code: ArchiveRejectionCode, message: string, options?: { cause?: unknown });
}

export function isArchiveRejectionError(error: unknown): error is ArchiveRejectionError;

export interface SafeArchiveEntry {
  name: string;
  isDirectory: boolean;
  declaredSize: number;
}

export interface SafeArchivePlan {
  archive: unknown;
  entries: SafeArchiveEntry[];
  totalDeclaredBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<Required<ArchiveLimits>>;

export function downloadArchive(
  url: string | URL,
  options?: {
    fetchImpl?: typeof fetch;
    headers?: HeadersInit;
    allowedOrigins?: Iterable<string>;
    timeoutMs?: number;
    maxRedirects?: number;
    maxArchiveBytes?: number;
    signal?: AbortSignal;
  },
): Promise<Buffer>;

export function preflightSkillArchive(
  archiveBuffer: Buffer | Uint8Array | ArrayBuffer,
  limits?: ArchiveLimits,
): SafeArchivePlan;

export function installSkillArchive(options: {
  archiveBuffer: Buffer | Uint8Array | ArrayBuffer;
  targetDir: string;
  replace?: boolean;
  limits?: ArchiveLimits;
  requiredRootFile?: string;
  fsOps?: Record<string, unknown>;
}): Promise<{ installedPath: string; files: number; bytes: number }>;

export type ConfigApplyScope = 'agents' | 'providers' | 'commands' | 'skills' | 'mcp' | 'behavior' | 'runtime';
export type ConfigApplyReasonCode =
  | 'CONFIG_AGENTS_CHANGED'
  | 'CONFIG_PROVIDERS_CHANGED'
  | 'CONFIG_COMMANDS_CHANGED'
  | 'CONFIG_SKILLS_CHANGED'
  | 'CONFIG_MCP_CHANGED'
  | 'CONFIG_BEHAVIOR_CHANGED'
  | 'CONFIG_RUNTIME_CHANGED';
export type ConfigApplyState = 'clean' | 'pending' | 'waiting_for_idle' | 'applying' | 'failed' | 'external_restart_required';

export interface ConfigApplyStatus {
  revision: number;
  appliedRevision: number;
  state: ConfigApplyState;
  pending: boolean;
  scopes: ConfigApplyScope[];
  reasonCodes: ConfigApplyReasonCode[];
  changedAt?: string;
  activeSessionCount: number;
  runtimeMode: 'managed' | 'external';
  canApplyWhenIdle: boolean;
  canForceRestart: boolean;
  lastError?: { code: string; message: string };
}

export interface ConfigApplyMutationResponse {
  requiresApply: boolean;
  applyRevision: number;
  applyScopes: ConfigApplyScope[];
  applyStatus: ConfigApplyStatus;
  requiresReload: false;
}

export interface ConfigApplyResult {
  status: ConfigApplyStatus;
  appliedRevision: number;
  appliedScopes: ConfigApplyScope[];
  userConfirmed: boolean;
}

export class ConfigApplyError extends Error {
  code: string;
  statusCode: number;
  status: ConfigApplyStatus | null;
}

export const CONFIG_APPLY_SCOPES: readonly ConfigApplyScope[];
export const CONFIG_APPLY_REASON_CODES: readonly ConfigApplyReasonCode[];
export function classifyConfigChange(reason: unknown): {
  scope: ConfigApplyScope;
  reasonCode: ConfigApplyReasonCode;
};

export function createConfigApplyCoordinator(options: {
  getRuntimeMode?: () => 'managed' | 'external';
  getActiveSessionCount?: () => number;
  getAuthoritativeActiveSessionCount?: () => Promise<number>;
  applyChanges: (input: {
    revision: number;
    scopes: ConfigApplyScope[];
    changes: Array<{ revision: number; scope: ConfigApplyScope; reasonCode: ConfigApplyReasonCode; metadata: unknown }>;
    force: boolean;
  }) => Promise<void>;
  refreshExternalCatalogs?: (input: { revision: number; scopes: ConfigApplyScope[] }) => Promise<void>;
  pollIntervalMs?: number;
  forceAbortTimeoutMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): {
  getStatus(options?: { canForceRestart?: boolean }): ConfigApplyStatus;
  markChanged(input: {
    scope: ConfigApplyScope;
    reasonCode: ConfigApplyReasonCode;
    changed?: boolean;
    metadata?: unknown;
    canForceRestart?: boolean;
  }): ConfigApplyMutationResponse;
  apply(expectedRevision: number, mode: 'when-idle' | 'force', options?: {
    canForceRestart?: boolean;
    onForceRestart?: (input: { revision: number; activeSessionCount: number }) => Promise<void> | void;
    abortActiveSessions?: (input: { revision: number; activeSessionCount: number }) => Promise<void> | void;
  }): Promise<ConfigApplyResult>;
  acknowledgeExternal(expectedRevision: number, options?: { canForceRestart?: boolean }): Promise<ConfigApplyResult>;
  dispose(): void;
};

export function createConfigChangeMarker(options: {
  coordinator: ReturnType<typeof createConfigApplyCoordinator>;
  getCanForceRestart?: () => boolean;
}): (
  reason: string,
  metadata?: unknown,
  changed?: boolean,
) => Promise<ConfigApplyMutationResponse & { runtimeApplied: false; runtimeMessage: string }>;

export interface SharedUsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string;
  description?: string;
}

export interface SharedUsageResetCredit {
  id: string;
  status: string;
  resetType: string | null;
  grantedAt: number | null;
  grantedAtFormatted: string | null;
  expiresAt: number | null;
  expiresAtFormatted: string | null;
}

export interface SharedUsageResetCredits {
  availableCount: number | null;
  totalEarnedCount: number | null;
  credits: SharedUsageResetCredit[];
  source: 'dedicated' | 'usage';
}

export interface SharedProviderUsage {
  windows: Record<string, SharedUsageWindow>;
  models?: Record<string, SharedProviderUsage>;
  resetCredits?: SharedUsageResetCredits;
}

export interface SharedQuotaProviderResult {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: SharedProviderUsage | null;
  fetchedAt: number;
  usageUpdatedAt?: number;
  error?: string;
  errorCode?: string;
  warnings?: string[];
}

export type SharedQuotaFetch = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

export interface SharedQuotaAdapterOptions<TCredential> {
  credential?: TCredential | null;
  fetchImpl?: SharedQuotaFetch;
  now?: () => number;
}

export const ZAI_QUOTA_URL: string;
export const KIMI_QUOTA_URL: string;
export const CODEX_USAGE_URL: string;
export const CODEX_RESET_CREDITS_URL: string;
export const XAI_BILLING_URL: string;
export const XAI_BILLING_HOST: string;
export const XAI_CLIENT_VERSION: string;
export const XAI_OAUTH_TOKEN_URL: string;
export const XAI_OAUTH_CLIENT_ID: string;
export const DEEPSEEK_BALANCE_URL: string;

export function toQuotaNumber(value: unknown): number | null;
export function toQuotaTimestamp(value: unknown): number | null;
export function toSharedUsageWindow(input: {
  usedPercent: unknown;
  windowSeconds: unknown;
  resetAt: unknown;
  valueLabel?: string | null;
  description?: string | null;
  now?: number;
}): SharedUsageWindow;
export function buildSharedQuotaResult(input: {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage?: SharedProviderUsage | null;
  error?: string | null;
  errorCode?: string | null;
  warnings?: string[];
  usageUpdatedAt?: number;
  now?: number;
}): SharedQuotaProviderResult;

export function fetchZaiQuotaAdapter(options?: SharedQuotaAdapterOptions<{
  apiKey: string;
}>): Promise<SharedQuotaProviderResult>;

export function fetchKimiQuotaAdapter(options?: SharedQuotaAdapterOptions<{
  apiKey: string;
}>): Promise<SharedQuotaProviderResult>;

export function fetchCodexQuotaAdapter(options?: SharedQuotaAdapterOptions<{
  accessToken: string;
  accountId?: string | null;
}>): Promise<SharedQuotaProviderResult>;

export function fetchXaiQuotaAdapter(options?: SharedQuotaAdapterOptions<{
  accessToken: string;
  refreshToken?: string | null;
}> & {
  refreshAccessToken?: (credential: {
    accessToken: string;
    refreshToken: string;
  }) => Promise<{
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
  } | null>;
}): Promise<SharedQuotaProviderResult>;

export function refreshXaiOAuthToken(options: {
  refreshToken: string;
  fetchImpl?: SharedQuotaFetch;
  now?: () => number;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}>;

export function fetchDeepSeekQuotaAdapter(options?: SharedQuotaAdapterOptions<{
  apiKey: string;
}>): Promise<SharedQuotaProviderResult>;
