const COPILOT_PROMPT_TOOL_OVERRIDES = Object.freeze({
  'resend_*': false,
  'mcp__resend__*': false,
});

/**
 * Return the smallest provider-specific tool override needed for a prompt.
 *
 * GitHub Copilot rejects requests with more than 128 tools. OpenCode composes
 * the core tools with every enabled MCP server. Disable both OpenCode naming
 * forms for the optional Resend namespace so aliases cannot bypass the cap.
 */
export const resolveProviderPromptTools = (providerId) => {
  const normalizedProviderId = typeof providerId === 'string'
    ? providerId.trim().toLowerCase()
    : '';
  if (normalizedProviderId === 'github-copilot' || normalizedProviderId === 'copilot') {
    return COPILOT_PROMPT_TOOL_OVERRIDES;
  }
  return undefined;
};
