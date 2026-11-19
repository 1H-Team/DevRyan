// Types for scripts/test-isolation-guard.mjs (imported by type-checked .ts tests).
export const ISOLATION_ROOT_VARIABLE: 'DEVRYAN_TEST_ISOLATION_ROOT';
export const ISOLATION_MARKER: 'isolation.json';
export const ISOLATION_PRELOAD: string;
export const NODE_ISOLATION_ARGS: readonly string[];
export const GUARDED_BUN_TEST: string;
export const REFUSAL_HEADLINE: string;
export type TestEnvironment = Record<string, string | undefined>;
export interface IsolationMarker { readonly root: string; readonly realHomes: readonly string[] }
export interface TestIsolation {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly owned: boolean;
  cleanup(status?: 'passed' | 'failed' | 'interrupted'): void;
}
export function realDataRoots(home: string): string[];
export function readIsolationMarker(environment?: TestEnvironment): IsolationMarker | null;
export function isolatedEnvironment(options: { root: string; home: string; realHome: string }, environment?: TestEnvironment): Record<string, string>;
export function createTestIsolation(options?: { environment?: TestEnvironment; parent?: string }): TestIsolation;
export function isolationProblems(options?: { env?: TestEnvironment; home?: string; selectors?: boolean }): string[];
export function refusalMessage(problems: readonly string[], options?: { cwd?: string }): string;
export function assertTestIsolation(options?: { env?: TestEnvironment; home?: string; selectors?: boolean }): IsolationMarker;
export interface IsolationCanaryReport {
  readonly root: string;
  readonly gitIdentity: string | null;
  readonly realHomes: readonly string[];
  readonly roots: Readonly<Record<string, string>>;
}
export function isolationCanary(options?: { env?: TestEnvironment }): Promise<IsolationCanaryReport>;
export function canaryProblems(report: IsolationCanaryReport): string[];
export function withTestIsolationSync(callback: (env: Record<string, string>) => number, options?: { environment?: TestEnvironment }): number;
export function runIsolated(command: string, args: readonly string[], options?: { environment?: TestEnvironment; cwd?: string }): Promise<number>;
export const XDG: Readonly<{ XDG_CONFIG_HOME: string; XDG_DATA_HOME: string; XDG_STATE_HOME: string; XDG_CACHE_HOME: string }>;
export const NAMED_SELECTORS: ReadonlySet<string>;
export const PASSED_THROUGH: Readonly<Record<string, string>>;
export function isStrippedVariable(key: string): boolean;
export function singleFileCommands(cwd?: string): { directory: string | null; commands: string[] };
export function isolateCurrentProcess(): TestIsolation;
export function spawnStatus(result: { readonly status: number | null; readonly signal: NodeJS.Signals | null }): number;
