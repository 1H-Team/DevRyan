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
  ctx_search: true,
  ctx_stats: true,
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

  let providerOverrides;
  if (isCopilot && isOrchestrator) providerOverrides = COPILOT_ORCHESTRATOR_PROMPT_TOOL_OVERRIDES;
  else if (isCopilot) providerOverrides = COPILOT_PROMPT_TOOL_OVERRIDES;
  else if (isOrchestrator) providerOverrides = ORCHESTRATOR_PROMPT_TOOL_OVERRIDES;

  if (options.readOnly !== true) return providerOverrides;
  return {
    ...providerOverrides,
    ...READ_ONLY_PROMPT_TOOL_OVERRIDES,
  };
};
