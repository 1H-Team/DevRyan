import type { spawn } from 'node:child_process';
import type { ClaudeAgentForkResult } from './claude-agent-protocol.js';

export interface ClaudeAgentUsageWindow { readonly utilization?: number; readonly resetsAt?: number; readonly status?: 'allowed' | 'allowed_warning' | 'rejected' }
export interface ClaudeAgentUsage {
  readonly version: 1;
  readonly updatedAt: number;
  readonly overage?: { readonly status: 'allowed' | 'allowed_warning' | 'rejected'; readonly using: boolean };
  readonly windows: Readonly<Partial<Record<'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage', ClaudeAgentUsageWindow>>>;
}
export interface ClaudeAgentSessions {
  readonly exists: (sessionID: string) => Promise<boolean>;
  readonly remove: (sessionID: string) => Promise<void>;
  readonly fork: (sessionID: string, messageID: string) => Promise<{ readonly sessionID: string; readonly messages: ReadonlyMap<string, string> } | undefined>;
}
export declare function assertClaudeAgentArgs(args: readonly string[]): readonly string[];
export declare function buildClaudeAgentEnvironment(requested: Readonly<Record<string, string>>, options?: {
  readonly hostEnv?: NodeJS.ProcessEnv; readonly home?: string; readonly accountHome?: string; readonly tmpdir?: string }): Record<string, string>;
export declare function resolveClaudeExecutable(options?: { readonly env?: NodeJS.ProcessEnv; readonly home?: string }): string | undefined;
export declare function claudeAgentUsageFromEvent(info: unknown, previous: ClaudeAgentUsage | undefined, now?: number): ClaudeAgentUsage | undefined;
export declare function readClaudeAgentUsage(usageFile: string | undefined): ClaudeAgentUsage | undefined;
export interface ClaudeAgentHost {
  readonly attach: (send: (value: unknown) => void) => void;
  readonly accept: (value: unknown) => void;
  readonly usage: () => ClaudeAgentUsage | undefined;
  readonly close: () => Promise<void>;
}
export declare function createClaudeAgentHost(options: {
  readonly usageFile?: string;
  readonly resolveExecutable?: () => string | undefined;
  readonly spawnImpl?: typeof spawn;
  readonly environment?: (requested: Readonly<Record<string, string>>) => Record<string, string>;
  readonly loadSessions?: () => Promise<ClaudeAgentSessions>;
  readonly onDiagnostic?: (detail: Record<string, unknown>) => void;
  readonly now?: () => number;
}): ClaudeAgentHost;
export type { ClaudeAgentForkResult };
