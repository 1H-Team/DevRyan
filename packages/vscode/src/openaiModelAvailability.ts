const OPENAI_OAUTH_GPT_56_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-sol-fast',
  'gpt-5.6-terra',
  'gpt-5.6-terra-fast',
  'gpt-5.6-luna',
  'gpt-5.6-luna-fast',
]);

const isOpenAIOAuthUnsupportedModel = (modelID: string): boolean => (
  (modelID === 'gpt-5.6' || modelID.startsWith('gpt-5.6-'))
  && !OPENAI_OAUTH_GPT_56_MODEL_IDS.has(modelID)
);

type ProviderCatalog = {
  providers?: Array<Record<string, unknown> & { id?: string; models?: Record<string, Record<string, unknown>> }>;
  [key: string]: unknown;
};

export const annotateOpenAIModelAvailability = (
  payload: ProviderCatalog,
  authEntry: Record<string, unknown> | null | undefined,
): ProviderCatalog => {
  const rawAuthType = typeof authEntry?.type === 'string' ? authEntry.type.trim().toLowerCase() : '';
  const authType = rawAuthType === 'oauth' || rawAuthType === 'api' ? rawAuthType : undefined;
  if (!authType || !Array.isArray(payload.providers)) return payload;

  return {
    ...payload,
    providers: payload.providers.map((provider) => {
      if (provider.id !== 'openai') return provider;
      const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
      return {
        ...provider,
        authType,
        models: Object.fromEntries(Object.entries(models).map(([modelID, model]) => [
          modelID,
          authType === 'oauth' && isOpenAIOAuthUnsupportedModel(modelID)
            ? {
                ...model,
                available: false,
                unavailableReason: 'auth_type_unsupported',
                requiredAuthType: 'api',
              }
            : model,
        ])),
      };
    }),
  };
};
