import type { EnvironmentRecord } from './legacy-environment.js';

type FileSystemProbe = {
  lstatSync?: (target: string) => { isDirectory(): boolean; isSymbolicLink(): boolean };
  realpathSync?: (target: string) => string;
};

export const DATA_ROOT_NAME: 'devryan';
export const LEGACY_DATA_ROOT_NAME: 'openchamber';
export function defaultDataRootPaths(home?: string): Readonly<{ root: string; legacy: string }>;
export function explicitDataRoot(env?: EnvironmentRecord, home?: string): string | null;
export function isLegacyDataRootInPlace(home?: string, probe?: FileSystemProbe): boolean;
export function resolveDevRyanDataRoot(options?: { env?: EnvironmentRecord; home?: string } & FileSystemProbe): string;
