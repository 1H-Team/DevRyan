export type OpenCodeDataDirectoryOptions = {
  openCodeDataDirectory?: string;
  env?: Record<string, string | undefined>;
  homeDirectory?: string;
};

export function getOpenCodeDataDirectory(options?: OpenCodeDataDirectoryOptions): string;

export function resolveActiveProjectWorktreeContainer(
  workingDirectory?: string | null,
  options?: OpenCodeDataDirectoryOptions,
): string | null;
