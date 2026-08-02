export type OpenCodeSupportStatus = 'supported' | 'older' | 'newer' | 'unknown';

export type OpenCodeUpdateInfo = {
  currentVersion: string | null;
  latestVersion: string;
  supportedVersion: string;
  updateAvailable: boolean | null;
  supportStatus: OpenCodeSupportStatus;
};

export type OpenCodeUpdateInput = {
  currentVersion: string | null | undefined;
  supportedVersion: string;
};

export type OpenCodeUpdateRuntime = {
  checkForUpdates: (input: OpenCodeUpdateInput) => Promise<OpenCodeUpdateInfo>;
  fetchLatestVersion: () => Promise<string>;
};

export function normalizeOpenCodeVersion(value: unknown): string | null;
export function compareOpenCodeVersions(left: unknown, right: unknown): number | null;
export function buildOpenCodeUpdateInfo(input: {
  currentVersion: unknown;
  latestVersion: unknown;
  supportedVersion: unknown;
}): OpenCodeUpdateInfo;
export function createOpenCodeUpdateRuntime(options?: {
  fetchImpl?: typeof fetch;
  releaseUrl?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  createTimeoutSignal?: (durationMs: number) => AbortSignal;
}): OpenCodeUpdateRuntime;
