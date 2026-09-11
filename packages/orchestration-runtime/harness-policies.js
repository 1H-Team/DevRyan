// Independent, default-off rollout switches. These affect behavior, never
// native permissions or launch admission. Hosts pass the same resolved values
// to the private bridge, provisioned plugins, preflight and evaluation reports.
export const HARNESS_POLICY_ENV = Object.freeze({
  readOverlap: 'DEVRYAN_MANAGED_READ_OVERLAP',
  waitAny: 'DEVRYAN_MANAGED_WAIT_ANY',
  compactResults: 'DEVRYAN_COMPACT_MANAGED_RESULTS',
  contextProjection: 'DEVRYAN_TASK_CONTEXT_PROJECTION',
});

export const resolveHarnessPolicies = (environment = {}) => Object.fromEntries(
  Object.entries(HARNESS_POLICY_ENV).map(([key, name]) => [key, environment[name] === '1']),
);

// This is an authorization list, intentionally separate from change-capture
// classification. No arbitrary execution, delegation, or MCP annotations.
export const MANAGED_OVERLAP_READ_TOOLS = Object.freeze([
  'read', 'glob', 'grep', 'webfetch',
  'ctx_search', 'ctx_stats', 'ctx_fetch_and_index',
  'context-mode_ctx_search', 'context-mode_ctx_stats', 'context-mode_ctx_fetch_and_index',
  'mcp__context_mode__ctx_search', 'mcp__context_mode__ctx_stats', 'mcp__context_mode__ctx_fetch_and_index',
]);
