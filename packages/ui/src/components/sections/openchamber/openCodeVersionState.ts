export type BundledRuntimeVersion = { version: string; ready: boolean };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only the server's verified bundle metadata identifies the bundled runtime. */
export const parseBundledRuntimeVersion = (value: unknown): BundledRuntimeVersion | null => {
  if (!record(value) || value.source !== 'verified-native-bundle' || typeof value.targetVersion !== 'string'
    || !/^2\.\d+\.\d+$/.test(value.targetVersion)) return null;
  return { version: value.targetVersion, ready: value.detectedVersion === value.targetVersion };
};
