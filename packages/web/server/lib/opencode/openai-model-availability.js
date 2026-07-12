const OPENAI_PROVIDER_ID = 'openai';
const OPENAI_OAUTH_GPT_56_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-sol-fast',
  'gpt-5.6-terra',
  'gpt-5.6-terra-fast',
  'gpt-5.6-luna',
  'gpt-5.6-luna-fast',
]);
const isOpenAIOAuthUnsupportedModel = (modelID) => (
  (modelID === 'gpt-5.6' || modelID.startsWith('gpt-5.6-'))
  && !OPENAI_OAUTH_GPT_56_MODEL_IDS.has(modelID)
);

const normalizeAuthType = (authEntry) => {
  const type = typeof authEntry?.type === 'string' ? authEntry.type.trim().toLowerCase() : '';
  if (type === 'oauth') return 'oauth';
  if (type === 'api') return 'api';
  return undefined;
};

export const annotateOpenAIModelAvailability = (payload, authEntry) => {
  const authType = normalizeAuthType(authEntry);
  if (!authType || !payload || typeof payload !== 'object' || !Array.isArray(payload.providers)) {
    return payload;
  }

  return {
    ...payload,
    providers: payload.providers.map((provider) => {
      if (provider?.id !== OPENAI_PROVIDER_ID) return provider;

      const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
      const nextModels = Object.fromEntries(Object.entries(models).map(([modelID, model]) => {
        if (authType !== 'oauth' || !isOpenAIOAuthUnsupportedModel(modelID)) {
          return [modelID, model];
        }

        return [modelID, {
          ...model,
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        }];
      }));

      return {
        ...provider,
        authType,
        models: nextModels,
      };
    }),
  };
};
