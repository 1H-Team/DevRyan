import type { McpStatus } from '@opencode-ai/sdk/v2';

type McpStatusMap = Record<string, McpStatus>;
type NamedMcpConfig = { name?: string | null };

const AMBIENT_MCP_NAMES = new Set([
  'context7',
  'ghgrep',
  'gh-grep',
  'gh_grep',
  'grep-app',
  'grep_app',
]);

const getConfiguredMcpNames = (configs: NamedMcpConfig[]): Set<string> => (
  new Set(configs.flatMap((config) => config.name ? [config.name] : []))
);

export const getVisibleMcpServerNames = (
  status: McpStatusMap,
  configs: NamedMcpConfig[],
): string[] => {
  const configuredNames = getConfiguredMcpNames(configs);
  const names = new Set(configuredNames);

  for (const name of Object.keys(status)) {
    if (!AMBIENT_MCP_NAMES.has(name) || configuredNames.has(name)) {
      names.add(name);
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
};

export const getVisibleMcpStatus = (
  status: McpStatusMap,
  configs: NamedMcpConfig[],
): McpStatusMap => {
  const visibleNames = new Set(getVisibleMcpServerNames(status, configs));
  return Object.fromEntries(
    Object.entries(status).filter(([name]) => visibleNames.has(name)),
  );
};
