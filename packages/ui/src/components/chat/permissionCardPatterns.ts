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

/** Upper bound of the MCP input shown on an approval card (characters). */
export const MCP_PERMISSION_INPUT_MAX = 16_000;

export interface McpPermissionDetails {
  /** The reviewed server name, when the host stamped it. */
  readonly server: string | null;
  readonly tool: string;
  /** Pretty JSON of the call input, cut at {@link MCP_PERMISSION_INPUT_MAX}. */
  readonly input: string;
  readonly truncated: boolean;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringifyInput = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
};

/**
 * An MCP tool approval (OpenCode asserts `metadata.input` since 2.0.30;
 * DevRyan's host adds `metadata.mcp {server, tool}`). A permission whose only
 * metadata is `input` is shown the same way, under its permission name.
 */
export function getMcpPermissionDetails(toolName: string, metadata: Readonly<Record<string, unknown>> | undefined): McpPermissionDetails | null {
  if (!metadata || !Object.hasOwn(metadata, 'input')) return null;
  const mcp = isPlainRecord(metadata.mcp) ? metadata.mcp : undefined;
  const stamped = typeof mcp?.server === 'string' && mcp.server && typeof mcp.tool === 'string' && mcp.tool
    ? { server: mcp.server, tool: mcp.tool } : null;
  if (!stamped && Object.keys(metadata).some((key) => key !== 'input')) return null;
  const json = stringifyInput(metadata.input);
  const truncated = json.length > MCP_PERMISSION_INPUT_MAX;
  return {
    server: stamped?.server ?? null,
    tool: stamped?.tool ?? toolName,
    input: truncated ? json.slice(0, MCP_PERMISSION_INPUT_MAX) : json,
    truncated,
  };
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
