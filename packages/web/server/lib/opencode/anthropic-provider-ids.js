// Provider ids Claude used before OpenCode's claude-agent provider. Routes keep
// refusing Anthropic API keys under them and answer their usage from claude-agent.
const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

export const ANTHROPIC_PROVIDER_IDS = new Set(['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude']);

export const isAnthropicProviderId = (providerID) => (
  ANTHROPIC_PROVIDER_IDS.has(trimString(providerID).toLowerCase())
);
