const SHELL_PERMISSION_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'shell_command',
  'cmd',
  'terminal',
]);

export function isShellPermissionTool(toolName: string) {
  return SHELL_PERMISSION_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

export function filterPermissionCardPatterns({
  toolName,
  patterns,
  command,
}: {
  toolName: string;
  patterns: readonly string[];
  command: string;
}) {
  if (!isShellPermissionTool(toolName)) return patterns;

  const normalizedCommand = command.trim();
  const seen = new Set<string>();
  const filtered = patterns.filter((pattern) => {
    const normalizedPattern = pattern.trim();
    if (normalizedCommand && normalizedPattern === normalizedCommand) return false;
    if (seen.has(normalizedPattern)) return false;
    seen.add(normalizedPattern);
    return true;
  });

  return filtered.length === patterns.length ? patterns : filtered;
}
