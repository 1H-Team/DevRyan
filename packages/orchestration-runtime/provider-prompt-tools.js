const COPILOT_PROMPT_TOOL_OVERRIDES = Object.freeze({
  'resend_*': false,
  'mcp__resend__*': false,
});
const ORCHESTRATOR_PROMPT_TOOL_OVERRIDES = Object.freeze({
  task: false,
  invalid: false,
  'mcp__*': false,
  'resend_*': false,
});
const COPILOT_ORCHESTRATOR_PROMPT_TOOL_OVERRIDES = Object.freeze({
  ...COPILOT_PROMPT_TOOL_OVERRIDES,
  ...ORCHESTRATOR_PROMPT_TOOL_OVERRIDES,
});

const normalize = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

/**
 * Return the smallest provider-specific tool override needed for a prompt.
 *
 * GitHub Copilot rejects requests with more than 128 tools. OpenCode composes
 * the core tools with every enabled MCP server. Orchestrator delegates ambient
 * integrations to managed subtasks, so its root prompt retains only the core
 * harness tools and omits invalid/provider-native task/MCP surfaces.
 */
export const resolveProviderPromptTools = (providerId, agent) => {
  const normalizedProviderId = normalize(providerId);
  const isCopilot = normalizedProviderId === 'github-copilot' || normalizedProviderId === 'copilot';
  const isOrchestrator = normalize(agent) === 'orchestrator';

  if (isCopilot && isOrchestrator) return COPILOT_ORCHESTRATOR_PROMPT_TOOL_OVERRIDES;
  if (isCopilot) return COPILOT_PROMPT_TOOL_OVERRIDES;
  if (isOrchestrator) return ORCHESTRATOR_PROMPT_TOOL_OVERRIDES;
  return undefined;
};
