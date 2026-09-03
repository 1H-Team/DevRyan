// Provider ids that route through Anthropic/Meridian (a Claude CLI spawn per
// request). Shared so the OpenCode routes and the session-title runtime agree
// on which sessions must not pay that cost for auxiliary requests.
const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

export const ANTHROPIC_PROVIDER_IDS = new Set(['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude']);

export const isAnthropicProviderId = (providerID) => (
  ANTHROPIC_PROVIDER_IDS.has(trimString(providerID).toLowerCase())
);
