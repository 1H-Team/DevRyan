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

/**
 * The human name of a skill permission ask. Reviewed skills are asked by their
 * hashed id (the permission resource); the host adds `metadata.name` for display.
 */
export function getSkillPermissionName(toolName: string, metadata: Readonly<Record<string, unknown>> | undefined): string | null {
  if (toolName.trim().toLowerCase() !== 'skill') return null;
  const name = metadata?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

export function filterPermissionCardPatterns({
  toolName,
  patterns,
  command,
  metadata,
}: {
  toolName: string;
  patterns: readonly string[];
  command: string;
  metadata?: Readonly<Record<string, unknown>>;
}) {
  const skillName = getSkillPermissionName(toolName, metadata);
  if (skillName) return [skillName];
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
