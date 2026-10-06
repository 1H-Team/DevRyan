import { CHATGPT_SIWC_METHOD_ID, hasSiwcPlanUsage } from './chatgpt-siwc.js';

/** Account discovery establishes availability; bundled catalogs cannot grant it. */
export const annotateOpenAIModelAvailability = (payload, authEntry, options = {}) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.providers)) return payload;
  const authType = ['api', 'key'].includes(authEntry?.type) ? 'api' : authEntry?.type === 'oauth' ? 'oauth' : undefined;
  if (!authType && !options.unavailable) return payload;
  const siwc = authEntry?.methodID === CHATGPT_SIWC_METHOD_ID;
  const permitted = siwc && hasSiwcPlanUsage(authEntry.scopes ?? authEntry.metadata?.scopes);
  const accountModels = Array.isArray(options.accountModels) ? options.accountModels
    : options.accountModels instanceof Set ? [...options.accountModels].map(slug => ({ slug, displayName: slug })) : null;
  return { ...payload, providers: payload.providers.map(provider => {
    if (provider?.id !== 'openai') return provider;
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
    if (authType === 'api') return { ...provider, authType };
    const reason = !authType ? 'account_models_unavailable' : !siwc ? 'reauthorization_required' : !permitted ? 'plan_usage_disabled' : 'account_models_unavailable';
    if (!permitted || !accountModels) return { ...provider, authType, accountModelsStatus: 'unavailable',
      models: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { ...model, available: false, unavailableReason: reason }])) };
    const next = {};
    for (const { slug, displayName } of accountModels) {
      if (Object.hasOwn(next, slug)) continue;
      const model = models[slug];
      next[slug] = model ? { ...model, name: displayName, available: true }
        : { id: slug, name: displayName, available: false, unavailableReason: 'runtime_unsupported' };
    }
    for (const [id, model] of Object.entries(models)) {
      if (!Object.hasOwn(next, id)) next[id] = { ...model, available: false, unavailableReason: 'auth_type_unsupported', requiredAuthType: 'api' };
    }
    return { ...provider, authType, accountModelsStatus: 'available', models: next };
  }) };
};
