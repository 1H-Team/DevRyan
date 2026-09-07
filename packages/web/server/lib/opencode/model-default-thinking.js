// Display metadata only. Never merge this value into model options or prompts.
// OpenCode defaults verified against v1.18.29 provider/transform.ts:
// https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/transform.ts
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const level = value => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;

export function resolveModelDefaultThinking(provider, model) {
  if (!record(model)) return undefined;
  const variants = record(model.variants) ? model.variants : {};
  const supported = value => {
    const normalized = level(value);
    return normalized && Object.keys(variants).some(key => level(key) === normalized) ? normalized : undefined;
  };
  if (model.defaultThinkingLevel !== undefined) return supported(model.defaultThinkingLevel);
  const options = record(model.options) ? model.options : {};
  const npm = model.api?.npm;
  const apiId = typeof model.api?.id === 'string' ? model.api.id : '';
  // These are the actual adapter option contracts, not guesses based on the
  // ordering of a model's named variants. Explicit configuration wins.
  let configured;
  if (['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/azure', '@ai-sdk/github-copilot', '@ai-sdk/amazon-bedrock/mantle'].includes(npm)) {
    configured = options.reasoningEffort;
  } else if (['@ai-sdk/anthropic', '@ai-sdk/google-vertex/anthropic'].includes(npm)) {
    configured = options.effort;
  } else if (['@ai-sdk/google', '@ai-sdk/google-vertex'].includes(npm)) {
    configured = options.thinkingConfig?.thinkingLevel;
  } else if (['@openrouter/ai-sdk-provider', '@llmgateway/ai-sdk-provider'].includes(npm)) {
    configured = options.reasoning?.effort;
  }
  // An unrecognized explicit value must not fall through to a runtime default.
  if (configured !== undefined) return supported(configured);

  if (npm === '@ai-sdk/azure' && provider?.options?.useCompletionUrls) {
    const [, major, minor] = apiId.match(/gpt-(\d+)\.(\d+)/) ?? [];
    if (Number(major) > 5 || (Number(major) === 5 && Number(minor) >= 5)) return undefined;
    return supported('medium');
  }
  if (['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/azure', '@ai-sdk/github-copilot', '@ai-sdk/amazon-bedrock/mantle'].includes(npm)
    && apiId.includes('gpt-5') && !apiId.includes('gpt-5-chat') && !apiId.includes('gpt-5-pro')) {
    return supported('medium');
  }
  if (['@ai-sdk/google', '@ai-sdk/google-vertex', '@openrouter/ai-sdk-provider', '@llmgateway/ai-sdk-provider'].includes(npm)
    && model.capabilities?.reasoning && apiId.includes('gemini-3')) {
    return supported('high');
  }
  // Claude through Meridian can inherit SDK/profile settings independently of
  // the API catalog. Do not label that route with the raw API's default.
  return undefined;
}

export function annotateModelDefaultThinking(payload) {
  if (!Array.isArray(payload?.providers)) return payload;
  let changed = false;
  const providers = payload.providers.map(provider => {
    if (!record(provider?.models)) return provider;
    let providerChanged = false;
    const models = Object.fromEntries(Object.entries(provider.models).map(([id, model]) => {
      const defaultThinkingLevel = resolveModelDefaultThinking(provider, model);
      if (!defaultThinkingLevel || model.defaultThinkingLevel === defaultThinkingLevel) return [id, model];
      providerChanged = true;
      return [id, { ...model, defaultThinkingLevel }];
    }));
    if (!providerChanged) return provider;
    changed = true;
    return { ...provider, models };
  });
  return changed ? { ...payload, providers } : payload;
}
