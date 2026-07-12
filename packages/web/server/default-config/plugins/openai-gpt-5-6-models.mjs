const PROVIDER_ID = "openai";
const MAX_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
]);
const ULTRA_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
]);
const VISIBLE_GPT_56_MODEL_IDS = MAX_MODEL_IDS;

const isPlainObject = (value) => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
);

const isInvalidOAuthGpt56Model = (modelId) => (
  (modelId === "gpt-5.6" || modelId.startsWith("gpt-5.6-"))
  && !VISIBLE_GPT_56_MODEL_IDS.has(modelId)
);

const buildReasoningVariant = (variants, effort) => {
  const template = variants.xhigh ?? variants.high ?? variants.medium ?? {};
  return {
    ...(isPlainObject(template) ? template : {}),
    reasoningEffort: effort,
  };
};

export const normalizeOpenAIOAuthGpt56Models = (models) => {
  if (!isPlainObject(models)) return {};

  const normalized = {};
  for (const [modelId, model] of Object.entries(models)) {
    if (isInvalidOAuthGpt56Model(modelId)) continue;
    if (!MAX_MODEL_IDS.has(modelId) || !isPlainObject(model)) {
      normalized[modelId] = model;
      continue;
    }

    const variants = isPlainObject(model.variants) ? { ...model.variants } : {};
    variants.max = buildReasoningVariant(variants, "max");
    if (ULTRA_MODEL_IDS.has(modelId)) {
      variants.ultra = buildReasoningVariant(variants, "ultra");
    }
    normalized[modelId] = { ...model, variants };
  }
  return normalized;
};

export const OpenAIGpt56ModelsPlugin = async () => ({
  provider: {
    id: PROVIDER_ID,
    async models(provider, ctx) {
      const models = provider?.models ?? {};
      if (ctx?.auth?.type !== "oauth") return models;
      return normalizeOpenAIOAuthGpt56Models(models);
    },
  },
});

export default OpenAIGpt56ModelsPlugin;
