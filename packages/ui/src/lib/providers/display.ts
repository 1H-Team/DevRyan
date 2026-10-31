interface ProviderLike {
  id?: string;
  name?: string;
}

interface ProviderSourceInfo {
  exists: boolean;
}

interface ProviderSourcesLike {
  anthropicOAuth?: ProviderSourceInfo;
}

const ANTHROPIC_OAUTH_PROVIDER_IDS = new Set([
  'anthropic',
  'claude',
  'anthropic-oauth',
  'opencode-with-claude',
]);

export const isAnthropicOAuthProviderId = (providerId: string | null | undefined) => (
  ANTHROPIC_OAUTH_PROVIDER_IDS.has((providerId ?? '').trim().toLowerCase())
);

export const getProviderDisplayName = (
  provider: ProviderLike,
  sources?: ProviderSourcesLike
) => {
  if (provider.id === 'openai') {
    return 'ChatGPT';
  }
  if (isAnthropicOAuthProviderId(provider.id) || provider.id === 'claude-agent') {
    return 'Claude';
  }
  if (provider.id === 'cursor-acp') {
    return provider.name === 'Cursor ACP' ? 'Cursor' : provider.name || 'Cursor';
  }
  if (provider.id === 'opencode') {
    return 'OpenCode Zen';
  }
  return provider.name || provider.id || (sources?.anthropicOAuth?.exists ? 'Claude' : '');
};
