import { GITHUB_COPILOT_FALLBACK_MODELS } from './github-copilot-models.js';

export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';
export const GITHUB_COPILOT_UPSTREAM_PROVIDER_ID = 'copilot';
export const GITHUB_COPILOT_PROVIDER_NAME = 'GitHub Copilot';
export const GITHUB_COPILOT_PROVIDER_ALIASES = [GITHUB_COPILOT_PROVIDER_ID, GITHUB_COPILOT_UPSTREAM_PROVIDER_ID];

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

export const mergeGitHubCopilotAuthAliases = (auth) => {
  if (!isPlainObject(auth)) {
    return auth;
  }

  const canonical = auth[GITHUB_COPILOT_PROVIDER_ID];
  const upstream = auth[GITHUB_COPILOT_UPSTREAM_PROVIDER_ID];
  if (isPlainObject(canonical) && !isPlainObject(upstream)) {
    return {
      ...auth,
      [GITHUB_COPILOT_UPSTREAM_PROVIDER_ID]: { ...canonical },
    };
  }
  if (isPlainObject(upstream) && !isPlainObject(canonical)) {
    return {
      ...auth,
      [GITHUB_COPILOT_PROVIDER_ID]: { ...upstream },
    };
  }
  return auth;
};

export const syncGitHubCopilotAuthAliases = ({ readAuthFile, writeAuthFile }) => {
  const auth = readAuthFile();
  const next = mergeGitHubCopilotAuthAliases(auth);
  if (next === auth) {
    return false;
  }
  writeAuthFile(next);
  return true;
};

export const getProviderIntegrationLookupIds = (providerId) => (
  isGitHubCopilotProviderId(providerId)
    ? GITHUB_COPILOT_PROVIDER_ALIASES
    : [normalizeProviderId(providerId)].filter(Boolean)
);

export const hasGitHubCopilotProviderModels = (payload) => {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  return providers.some((provider) => (
    isGitHubCopilotProviderId(provider?.id)
    && isPlainObject(provider?.models)
    && Object.keys(provider.models).length > 0
  ));
};

const normalizeGitHubCopilotProvider = (provider, { useFallbackModels = false, models: discoveredModels } = {}) => {
  const models = isPlainObject(provider?.models) && Object.keys(provider.models).length > 0
    ? provider.models
    : isPlainObject(discoveredModels) && Object.keys(discoveredModels).length > 0
      ? discoveredModels
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

export const mergeGitHubCopilotProvider = (payload, { configured = false, models } = {}) => {
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
      nextProviders.push(normalizeGitHubCopilotProvider(provider, { useFallbackModels: configured, models }));
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
    nextProviders.push(normalizeGitHubCopilotProvider({}, { useFallbackModels: true, models }));
  }

  return {
    ...(isPlainObject(payload) ? payload : {}),
    providers: nextProviders,
    default: nextDefaults,
  };
};
