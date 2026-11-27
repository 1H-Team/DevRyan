// Types for scripts/test-isolation-check.mjs (imported by type-checked test setups).
export const ISOLATION_ROOT_VARIABLE: 'DEVRYAN_TEST_ISOLATION_ROOT';
export const ISOLATION_MARKER: 'isolation.json';
export const REFUSAL_HEADLINE: string;
export const XDG: Readonly<{ XDG_CONFIG_HOME: string; XDG_DATA_HOME: string; XDG_STATE_HOME: string; XDG_CACHE_HOME: string }>;
export const NAMED_SELECTORS: ReadonlySet<string>;
export type TestEnvironment = Record<string, string | undefined>;
export interface IsolationMarker { readonly root: string; readonly realHomes: readonly string[] }
export function isStrippedVariable(key: string): boolean;
export function inside(child: string, parent: string): boolean;
export function realDataRoots(home: string): string[];
export function readIsolationMarker(environment?: TestEnvironment): IsolationMarker | null;
export function isolationProblems(options?: { env?: TestEnvironment; home?: string; selectors?: boolean }): string[];
export function singleFileCommands(cwd?: string): { directory: string | null; commands: string[] };
export function refusalMessage(problems: readonly string[], options?: { cwd?: string }): string;
export function assertTestIsolation(options?: { env?: TestEnvironment; home?: string; selectors?: boolean }): IsolationMarker;
