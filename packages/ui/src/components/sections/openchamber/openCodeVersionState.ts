export type BundledRuntimeVersion = { version: string; ready: boolean };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only the server's verified bundle metadata identifies the bundled runtime. */
export const parseBundledRuntimeVersion = (value: unknown): BundledRuntimeVersion | null => {
  if (!record(value) || value.source !== 'verified-native-bundle' || typeof value.targetVersion !== 'string'
    || !/^2\.\d+\.\d+$/.test(value.targetVersion)) return null;
  return { version: value.targetVersion, ready: value.detectedVersion === value.targetVersion };
};

const STABLE_V2_VERSION = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Accepts only stable upstream OpenCode 2.x versions such as `2.0.26`. */
export const isStableOpenCodeV2Version = (value: unknown): value is string => typeof value === 'string' && STABLE_V2_VERSION.test(value);

/** Validates the `/api/config/opencode-update-check` success payload. */
export const parseLatestUpstreamVersion = (value: unknown): string | null =>
  record(value) && isStableOpenCodeV2Version(value.latestVersion) ? value.latestVersion : null;

export type UpstreamVersionComparison = 'update-available' | 'up-to-date' | 'unknown';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const numericParts = (value: string | null | undefined): [number, number, number] | null => {
  const match = typeof value === 'string' ? STABLE_VERSION.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
/** Compares numeric `major.minor.patch` components; never string order. */
export const compareUpstreamVersion = (current: string | null | undefined, latest: string | null | undefined): UpstreamVersionComparison => {
  const left = numericParts(current); const right = numericParts(latest);
  if (!left || !right) return 'unknown';
  for (let index = 0; index < 3; index += 1) {
    if (right[index] > left[index]) return 'update-available';
    if (right[index] < left[index]) return 'up-to-date';
  }
  return 'up-to-date';
};
