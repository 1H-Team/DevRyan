const COPILOT_PROMPT_TOOL_OVERRIDES = Object.freeze({
  'resend_*': false,
  'mcp__resend__*': false,
});
const ORCHESTRATOR_PROMPT_TOOL_OVERRIDES = Object.freeze({
  task: false,
  invalid: false,
});
const COPILOT_ORCHESTRATOR_PROMPT_TOOL_OVERRIDES = Object.freeze({
  ...COPILOT_PROMPT_TOOL_OVERRIDES,
  ...ORCHESTRATOR_PROMPT_TOOL_OVERRIDES,
});
const CONTEXT_MODE_SAFE_READ_ONLY_TOOL_OVERRIDES = Object.freeze({
  ctx_search: true,
  mcp__context_mode__ctx_search: true,
  ctx_stats: true,
  mcp__context_mode__ctx_stats: true,
  ctx_fetch_and_index: true,
  mcp__context_mode__ctx_fetch_and_index: true,
});
const CONTEXT_MODE_WRITABLE_TOOL_OVERRIDES = Object.freeze({
  ctx_execute: true,
  mcp__context_mode__ctx_execute: true,
  ctx_execute_file: true,
  mcp__context_mode__ctx_execute_file: true,
  ctx_batch_execute: true,
  mcp__context_mode__ctx_batch_execute: true,
  ...CONTEXT_MODE_SAFE_READ_ONLY_TOOL_OVERRIDES,
});
const CONTEXT_MODE_INDEX_TOOL_OVERRIDES = Object.freeze({
  ctx_index: true,
  mcp__context_mode__ctx_index: true,
});
const CONTEXT_MODE_ADMIN_TOOL_OVERRIDES = Object.freeze({
  ctx_purge: false,
  mcp__context_mode__ctx_purge: false,
  ctx_upgrade: false,
  mcp__context_mode__ctx_upgrade: false,
  ctx_insight: false,
  mcp__context_mode__ctx_insight: false,
});
const CONTEXT_MODE_PLAN_TOOL_OVERRIDES = Object.freeze({
  // UI Plan Mode keeps the parent agent's existing inspection, question,
  // skill, and delegation tools. Restrict only Context Mode's execution and
  // administration surfaces, then explicitly reopen the read-only subset.
  ctx_execute: false,
  mcp__context_mode__ctx_execute: false,
  ctx_execute_file: false,
  mcp__context_mode__ctx_execute_file: false,
  ctx_batch_execute: false,
  mcp__context_mode__ctx_batch_execute: false,
  ctx_doctor: false,
  mcp__context_mode__ctx_doctor: false,
  ...CONTEXT_MODE_ADMIN_TOOL_OVERRIDES,
  ctx_search: false,
  mcp__context_mode__ctx_search: false,
  ctx_stats: false,
  mcp__context_mode__ctx_stats: false,
  ctx_fetch_and_index: false,
  mcp__context_mode__ctx_fetch_and_index: false,
  // Fail closed until /api/health verifies that this is a provisioned,
  // project-bound managed Context Mode runtime.
  ctx_index: false,
  mcp__context_mode__ctx_index: false,
});
const READ_ONLY_PROMPT_TOOL_OVERRIDES = Object.freeze({
  // Managed plan-mode work must fail closed. OpenCode can discover custom
  // tools after this runtime ships, so enumerating today's mutation aliases
  // (write, oc_write, shell, rm, ast_grep_replace, and so on) is not a durable
  // boundary. Disable every tool first, then reopen only inspection surfaces.
  '*': false,
  read: true,
  oc_read: true,
  glob: true,
  oc_glob: true,
  grep: true,
  ls: true,
  oc_ls: true,
  stat: true,
  oc_stat: true,
  ast_grep_search: true,
  webfetch: true,
  websearch: true,
  google_search: true,
});

const normalize = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

/**
 * Return the smallest provider-specific tool override needed for a prompt.
 *
 * GitHub Copilot rejects requests with more than 128 tools. OpenCode composes
 * the core tools with every enabled MCP server. Orchestrator retains installed
 * plugin and MCP surfaces while provider-native task remains disabled so
 * DevRyan's managed scheduler continues to own delegation.
 */
export const resolveProviderPromptTools = (providerId, agent, options = {}) => {
  const normalizedProviderId = normalize(providerId);
  const isCopilot = normalizedProviderId === 'github-copilot' || normalizedProviderId === 'copilot';
  const isOrchestrator = normalize(agent) === 'orchestrator';
  const contextModeAvailable = normalizedProviderId !== 'cursor-acp'
    && (options.contextModeAvailable === true || options.contextModeReadOnlyIndexing === true);

  let providerOverrides;
  if (isCopilot && isOrchestrator) providerOverrides = COPILOT_ORCHESTRATOR_PROMPT_TOOL_OVERRIDES;
  else if (isCopilot) providerOverrides = COPILOT_PROMPT_TOOL_OVERRIDES;
  else if (isOrchestrator) providerOverrides = ORCHESTRATOR_PROMPT_TOOL_OVERRIDES;

  if (options.readOnly === true) {
    return {
      ...providerOverrides,
      ...READ_ONLY_PROMPT_TOOL_OVERRIDES,
      ...(contextModeAvailable
        ? {
            ...CONTEXT_MODE_SAFE_READ_ONLY_TOOL_OVERRIDES,
            ...CONTEXT_MODE_INDEX_TOOL_OVERRIDES,
          }
        : undefined),
    };
  }

  if (options.planMode !== true) {
    return contextModeAvailable
      ? {
          ...providerOverrides,
          ...CONTEXT_MODE_WRITABLE_TOOL_OVERRIDES,
          ...CONTEXT_MODE_INDEX_TOOL_OVERRIDES,
          ...CONTEXT_MODE_ADMIN_TOOL_OVERRIDES,
        }
      : providerOverrides;
  }
  return {
    ...providerOverrides,
    ...CONTEXT_MODE_PLAN_TOOL_OVERRIDES,
    ...(contextModeAvailable
      ? {
          ...CONTEXT_MODE_SAFE_READ_ONLY_TOOL_OVERRIDES,
          ...CONTEXT_MODE_INDEX_TOOL_OVERRIDES,
        }
      : undefined),
  };
};
