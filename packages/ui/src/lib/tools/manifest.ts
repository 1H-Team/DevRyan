import type { ToolManifest, ToolManifestEntry } from '../api/types';

export const TOOL_PERMISSION_ALIAS_GROUPS: string[][] = [
  ['edit', 'write', 'patch', 'apply_patch'],
  ['read'],
  ['bash'],
  ['task'],
  ['skill'],
  ['question', 'ask', 'input', 'clarification'],
  ['webfetch'],
];

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normalizeToolIds = (toolIds: unknown[]): string[] => {
  const normalized = toolIds.flatMap((tool) => {
    if (typeof tool !== 'string') return [];
    const trimmed = tool.trim();
    return trimmed && trimmed !== 'invalid' ? [trimmed] : [];
  });
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
};

export const getToolPermissionAliases = (toolId: string): string[] => {
  const group = TOOL_PERMISSION_ALIAS_GROUPS.find((aliases) => aliases.includes(toolId));
  return group ? [...group] : [toolId];
};

export const buildToolManifest = ({
  toolIds,
  sourceRuntime,
  directory,
}: {
  toolIds: unknown[];
  sourceRuntime: ToolManifestEntry['sourceRuntime'];
  directory?: string | null;
}): ToolManifest => {
  const normalizedDirectory = normalizeDirectory(directory);
  const tools = normalizeToolIds(toolIds).map((id) => ({
    id,
    aliases: getToolPermissionAliases(id),
    sourceRuntime,
    directory: normalizedDirectory,
  }));

  return {
    tools,
    aliases: Object.fromEntries(tools.map((tool) => [tool.id, tool.aliases])),
    sourceRuntime,
    directory: normalizedDirectory,
  };
};
