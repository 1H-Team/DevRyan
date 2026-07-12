const ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_PREFIXES = [
  '@rama_nigg/open-cursor',
  'opencode-antigravity-auth',
];

const ALLOWED_MANAGED_RUNTIME_PLUGIN_SPECS = new Set([
  'cursor-acp',
  'oh-my-opencode-slim',
  'opencode-with-claude',
  './plugins/devryan-oh-my-opencode-slim.mjs',
]);

const BLOCKED_MANAGED_RUNTIME_MCP_NAMES = [
  'context7',
  'ghgrep',
  'gh-grep',
  'gh_grep',
  'grep-app',
  'grep_app',
];

const FORBIDDEN_MANAGED_RUNTIME_TOOL_PREFIXES = [
  'context7_',
  'ghgrep_',
  'grep_app_',
];

const normalizeSpec = (value) => (
  typeof value === 'string' ? value.trim() : ''
);

const pluginEntrySpec = (entry) => {
  if (typeof entry === 'string') {
    return normalizeSpec(entry);
  }
  if (Array.isArray(entry)) {
    return normalizeSpec(entry[0]);
  }
  return '';
};

const isAllowedManagedRuntimePluginSpec = (spec) => {
  const normalized = normalizeSpec(spec);
  if (!normalized) {
    return false;
  }
  if (ALLOWED_MANAGED_RUNTIME_PLUGIN_SPECS.has(normalized)) {
    return true;
  }
  return ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const filterManagedRuntimePluginEntries = (entries) => (
  Array.isArray(entries)
    ? entries.filter((entry) => isAllowedManagedRuntimePluginSpec(pluginEntrySpec(entry)))
    : []
);

const isBlockedManagedRuntimeMcpName = (name) => (
  typeof name === 'string'
  && BLOCKED_MANAGED_RUNTIME_MCP_NAMES.includes(name.trim())
);

const buildBlockedManagedRuntimeMcpOverlay = (configs = []) => {
  const explicitlyConfiguredNames = new Set(
    Array.isArray(configs)
      ? configs
        .map((config) => (typeof config?.name === 'string' ? config.name.trim() : ''))
        .filter(Boolean)
      : [],
  );
  const mcp = {};
  for (const name of BLOCKED_MANAGED_RUNTIME_MCP_NAMES) {
    if (explicitlyConfiguredNames.has(name)) {
      continue;
    }
    mcp[name] = { enabled: false };
  }
  return Object.keys(mcp).length > 0 ? { mcp } : null;
};

const isForbiddenManagedRuntimeToolId = (toolId) => {
  const normalized = typeof toolId === 'string' ? toolId.trim() : '';
  if (!normalized) {
    return false;
  }
  if (normalized === 'invalid') {
    return true;
  }
  return FORBIDDEN_MANAGED_RUNTIME_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

export {
  BLOCKED_MANAGED_RUNTIME_MCP_NAMES,
  buildBlockedManagedRuntimeMcpOverlay,
  filterManagedRuntimePluginEntries,
  isAllowedManagedRuntimePluginSpec,
  isBlockedManagedRuntimeMcpName,
  isForbiddenManagedRuntimeToolId,
};
