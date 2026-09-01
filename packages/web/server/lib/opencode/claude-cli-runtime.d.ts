export type ClaudeCodeLaunch = {
  executable: string;
  pathValue: string;
  source: 'explicit' | 'managed' | 'path';
};

export function searchPathForClaudeCode(pathValue: string, options?: Record<string, unknown>): string | null;
export function resolveClaudeCodeLaunch(options?: {
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  configDirectory?: string;
  fsApi?: typeof import('node:fs');
  homedir?: () => string;
  pathApi?: typeof import('node:path');
  platform?: NodeJS.Platform;
}): ClaudeCodeLaunch | null;
