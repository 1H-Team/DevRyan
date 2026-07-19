import type { McpStatus } from '@opencode-ai/sdk/v2';
import type { McpIssueKind } from '@/stores/useMcpStore';

type McpStatusMap = Record<string, McpStatus>;
type NamedMcpConfig = { name?: string | null };

export type McpIndicatorState = {
  tone: 'success' | 'warning' | 'idle';
  status: 'connected' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'disabled' | 'unknown';
  error?: string;
  remembered: boolean;
};

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

export const getMcpIndicatorState = ({
  enabled,
  status,
  issueKind,
}: {
  enabled: boolean;
  status: McpStatus | undefined;
  issueKind: McpIssueKind | undefined;
}): McpIndicatorState => {
  if (status?.status === 'connected') {
    return { tone: 'success', status: 'connected', remembered: false };
  }

  if (status?.status === 'failed') {
    return {
      tone: 'warning',
      status: 'failed',
      error: status.error,
      remembered: false,
    };
  }

  if (status?.status === 'needs_auth' || status?.status === 'needs_client_registration') {
    return {
      tone: 'warning',
      status: status.status,
      error: status.status === 'needs_client_registration' ? status.error : undefined,
      remembered: false,
    };
  }

  if (issueKind) {
    return {
      tone: 'warning',
      status: issueKind,
      remembered: true,
    };
  }

  if (!enabled || status?.status === 'disabled') {
    return { tone: 'idle', status: 'disabled', remembered: false };
  }

  return { tone: 'idle', status: 'unknown', remembered: false };
};

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
