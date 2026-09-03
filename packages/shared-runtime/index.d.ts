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

export const COMMIT_DRAFT_DEADLINE_MS: 20000;
export const COMMIT_DRAFT_SUBJECT_MAX_LENGTH: 72;
export const COMMIT_DRAFT_DETAIL_MIN_COUNT: 2;
export const COMMIT_DRAFT_DETAIL_MAX_COUNT: 4;
export const COMMIT_DRAFT_DETAIL_MAX_LENGTH: 120;
export const COMMIT_DRAFT_MODEL_COOLDOWN_MS: number;
export const COMMIT_DRAFT_ALLOWED_TYPES: readonly string[];

export interface FreeZenModel {
  id: string;
  owned_by?: string;
}

export interface FreeZenModelCatalogSnapshot {
  models: FreeZenModel[];
  at: number;
  fresh: boolean;
}

export const FREE_ZEN_MODEL_CATALOG_TTL_MS: number;
export const FREE_ZEN_MODEL_CATALOG_TIMEOUT_MS: number;
export function normalizeFreeZenModels(zenPayload: unknown, metadataPayload: unknown): FreeZenModel[];
export function createFreeZenModelCatalog(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}): {
  fetchModels(options?: { force?: boolean }): Promise<FreeZenModel[]>;
  getCachedModels(options?: { allowStale?: boolean }): FreeZenModel[];
  getSnapshot(): FreeZenModelCatalogSnapshot | null;
  prewarm(): void;
};

export type FreeZenFailureReason =
  | 'rate_limited'
  | 'model_unavailable'
  | 'unauthorized'
  | 'upstream_error'
  | 'timeout'
  | 'empty_output'
  | 'invalid_output'
  | 'request_failed';

export function classifyFreeZenFailure(error: unknown): FreeZenFailureReason;

export const FREE_ZEN_LONG_COOLDOWN_MS: number;
export const FREE_ZEN_SHORT_COOLDOWN_MS: number;
export interface FreeZenCooldowns {
  isCoolingDown(model: FreeZenModel | string | null | undefined, at?: number): boolean;
  mark(
    model: FreeZenModel | string | null | undefined,
    reason?: FreeZenFailureReason | string,
    options?: { at?: number; cooldownMs?: number },
  ): number | null;
  reset(): void;
  durationFor(reason?: string): number;
  snapshot(at?: number): Array<{ model: string; reason: string; until: number }>;
}
export function createFreeZenCooldowns(options?: {
  now?: () => number;
  longMs?: number;
  shortMs?: number;
}): FreeZenCooldowns;
export const sharedFreeZenCooldowns: FreeZenCooldowns;

export type FreeZenSkipReason = 'cooling_down' | 'max_models' | 'deadline';
export function runFreeZenModelRotation<TInput = unknown, TOutput = TInput>(options: {
  models: Array<FreeZenModel | string>;
  timeoutMs: number;
  request: (input: { model: string; timeoutMs: number }) => Promise<TInput> | TInput;
  accept?: (value: TInput, input: { model: string; attempt: number }) => Promise<TOutput | null> | TOutput | null;
  onAttempt?: (input: {
    model: string;
    attempt: number;
    durationMs: number;
    outcome: 'complete' | 'failed';
    reason?: FreeZenFailureReason;
    status?: number;
  }) => void;
  cooldowns?: FreeZenCooldowns | null;
  maxModels?: number;
  deadlineMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): Promise<{
  ok: boolean;
  value: TOutput | null;
  model: string | null;
  attempts: number;
  failures: Array<{
    model: string;
    attempt: number;
    durationMs: number;
    reason: FreeZenFailureReason;
    status?: number;
  }>;
  skipped: Array<{ model: string; reason: FreeZenSkipReason }>;
  deadlineExceeded: boolean;
}>;

export interface GeneratedPullRequestDraft {
  title: string;
  body: string;
}
export const PULL_REQUEST_TITLE_MAX_LENGTH: number;
export function shortenPullRequestTitle(value: unknown, maxLength?: number): string;
export function normalizePullRequestDraft(
  value: unknown,
  options?: { maxTitleLength?: number },
): GeneratedPullRequestDraft | null;

export const PULL_REQUEST_DIFF_MAX_CHARS: number;
export interface PullRequestDiffContext {
  text: string;
  truncated: boolean;
  totalChars: number;
  includedChars: number;
  fileCount: number;
  skippedBinary: string[];
  omitted: string[];
}
export function buildPullRequestDiffContext(input?: {
  diff?: string | null;
  stat?: string | null;
  maxChars?: number;
}): PullRequestDiffContext;

export interface SharedCommitDraftFileContext {
  path: string;
  index?: string;
  workingDir?: string;
  insertions?: number;
  deletions?: number;
  diff?: string;
  diffNote?: string;
}

export interface SharedCommitDraftContext {
  branch?: string;
  tracking?: string | null;
  scope?: string;
  stagedOnly?: boolean;
  selectedFiles: SharedCommitDraftFileContext[];
  recentCommitSubjects?: string[];
  patch?: string;
  patchNote?: string;
  contextWarning?: string;
}

export interface SharedCommitDraftMessage {
  subject: string;
  highlights: string[];
}

export type SharedCommitDraftSource = 'ai' | 'repaired_ai' | 'local_fallback';

export function createDeterministicCommitDraft(context: SharedCommitDraftContext): SharedCommitDraftMessage;
export function normalizeGeneratedCommitDraft(value: unknown, context: SharedCommitDraftContext): {
  message: SharedCommitDraftMessage;
  source: SharedCommitDraftSource;
};
export function buildCommitDraftPrompt(context: SharedCommitDraftContext, guidance?: string): string;
export function generateCommitDraftWithDeadline(options: {
  context: SharedCommitDraftContext;
  guidance?: string;
  requestText?: (input: { prompt: string; timeoutMs: number }) => Promise<unknown> | unknown;
  deadlineAt?: number;
  now?: () => number;
  reserveMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): Promise<{
  message: SharedCommitDraftMessage;
  source: SharedCommitDraftSource;
  warning: string | null;
  providerOutcome: 'complete' | 'deadline' | 'invalid' | 'error';
  error?: unknown;
}>;
export function createCommitModelCooldowns(options?: { now?: () => number; cooldownMs?: number }): {
  select(primary?: string | null, fallback?: string | null): string;
  markUnhealthy(model?: string | null): void;
  isCoolingDown(model?: string | null): boolean;
};

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
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
  url?: string;
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
export const XAI_RESET_BANK_URL: string;
export const XAI_RESET_BANK_MAX_RESPONSE_BYTES: number;
export const XAI_OAUTH_TOKEN_URL: string;
export const XAI_OAUTH_CLIENT_ID: string;
export const DEEPSEEK_BALANCE_URL: string;
export const OPENCODE_GO_USAGE_URL: string;
export const OPENCODE_ZEN_BILLING_ORIGIN: string;
export const OPENCODE_ZEN_MAX_RESPONSE_BYTES: number;

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

export function fetchOpenCodeGoQuotaAdapter(options?: SharedQuotaAdapterOptions<{
  apiKey: string;
}>): Promise<SharedQuotaProviderResult>;

export interface OpenCodeZenCredential {
  workspaceId: string;
  authCookie: string;
}

export interface OpenCodeZenBillingSnapshot {
  balanceMicrocents: number;
  monthlyLimitDollars: number | null;
  monthlyUsageMicrocents: number;
  usageUpdatedAt: number | null;
  reloadEnabled: boolean;
  reloadAmountDollars: number;
  reloadTriggerDollars: number;
}

export function normalizeOpenCodeZenCredential(value: unknown): OpenCodeZenCredential | null;
export function parseOpenCodeZenBillingHtml(
  html: string,
  workspaceId: string,
  now?: number,
): OpenCodeZenBillingSnapshot | null;
export function fetchOpenCodeZenQuotaAdapter(options?: SharedQuotaAdapterOptions<OpenCodeZenCredential>): Promise<SharedQuotaProviderResult>;

export type AssistantImageReferenceKind = 'markdown-image' | 'markdown-link' | 'reference-image';

export interface AssistantImageReference {
  source: string;
  caption: string;
  kind: AssistantImageReferenceKind;
  start: number;
  end: number;
}

export function canonicalizeAssistantImageSource(value: unknown): string | null;
export function isSupportedAssistantImageSource(value: unknown): boolean;
export function extractAssistantImageReferences(markdown: string): AssistantImageReference[];
export function stripAssistantImageMarkdown(markdown: string): string;
export const SUPPORTED_IMAGE_EXTENSIONS: Set<string>;
