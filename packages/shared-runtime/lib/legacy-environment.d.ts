export type EnvironmentRecord = Record<string, string | undefined>;

export const ENVIRONMENT_PREFIX: 'DEVRYAN_';
export const LEGACY_ENVIRONMENT_PREFIX: 'OPENCHAMBER_';
export function devRyanEnvironmentName(name: string): string;
export function legacyEnvironmentName(name: string): string;
export function canonicalEnvironmentName(name: string): string;
export function readDevRyanEnv(env: EnvironmentRecord | undefined | null, name: string): string | undefined;
export function adoptLegacyEnvironment(env: EnvironmentRecord): string[];
export function setDevRyanEnv<T extends EnvironmentRecord>(env: T, name: string, value: string | undefined): T;
