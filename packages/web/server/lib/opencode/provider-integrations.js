export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';
export const GITHUB_COPILOT_PROVIDER_NAME = 'GitHub Copilot';
export const GITHUB_COPILOT_PROVIDER_ALIASES = [GITHUB_COPILOT_PROVIDER_ID, 'copilot'];

const GITHUB_COPILOT_FALLBACK_MODELS = {
  'gpt-5.1-codex': { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const normalizeProviderId = (providerId) => (
  typeof providerId === 'string' ? providerId.trim().toLowerCase() : ''
);

export const isGitHubCopilotProviderId = (providerId) => (
  GITHUB_COPILOT_PROVIDER_ALIASES.includes(normalizeProviderId(providerId))
);

export const getProviderIntegrationLookupIds = (providerId) => (
  isGitHubCopilotProviderId(providerId)
    ? GITHUB_COPILOT_PROVIDER_ALIASES
    : [normalizeProviderId(providerId)].filter(Boolean)
);

const normalizeGitHubCopilotProvider = (provider, { useFallbackModels = false } = {}) => {
  const models = isPlainObject(provider?.models) && Object.keys(provider.models).length > 0
    ? provider.models
    : useFallbackModels
      ? GITHUB_COPILOT_FALLBACK_MODELS
      : {};

  return {
    ...(isPlainObject(provider) ? provider : {}),
    id: GITHUB_COPILOT_PROVIDER_ID,
    name: GITHUB_COPILOT_PROVIDER_NAME,
    models,
  };
};

export const mergeGitHubCopilotProvider = (payload, { configured = false } = {}) => {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const defaults = isPlainObject(payload?.default) ? payload.default : {};
  const nextDefaults = { ...defaults };
  const nextProviders = [];
  let foundGitHubCopilot = false;

  for (const provider of providers) {
    if (!isGitHubCopilotProviderId(provider?.id)) {
      nextProviders.push(provider);
      continue;
    }

    if (!foundGitHubCopilot) {
      nextProviders.push(normalizeGitHubCopilotProvider(provider, { useFallbackModels: configured }));
      foundGitHubCopilot = true;
    }

    const defaultModel = defaults?.[provider.id];
    if (typeof defaultModel === 'string' && defaultModel.trim()) {
      nextDefaults[GITHUB_COPILOT_PROVIDER_ID] = defaultModel;
    }
    if (provider.id !== GITHUB_COPILOT_PROVIDER_ID) {
      delete nextDefaults[provider.id];
    }
  }

  if (!foundGitHubCopilot && configured) {
    nextProviders.push(normalizeGitHubCopilotProvider({}, { useFallbackModels: true }));
  }

  return {
    ...(isPlainObject(payload) ? payload : {}),
    providers: nextProviders,
    default: nextDefaults,
  };
};
