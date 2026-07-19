const PROVIDER_ID = "openai";
const MAX_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
]);
const ULTRA_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
]);
const VISIBLE_GPT_56_MODEL_IDS = new Set([
  ...MAX_MODEL_IDS,
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
]);
const LUNA_MODEL_IDS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
]);
const LUNA_API_MODEL_ID = "gpt-5.6-luna";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0 (OpenCode)";

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

const normalizeReasoningSummary = (options) => {
  if (
    !isPlainObject(options)
    || !("reasoningEffort" in options)
    || options.reasoningEffort === "none"
    || (options.reasoningSummary !== undefined && options.reasoningSummary !== "auto")
  ) {
    return options;
  }

  return { ...options, reasoningSummary: "detailed" };
};

const normalizeReasoningSummaries = (models) => {
  if (!isPlainObject(models)) return {};

  let normalized = models;
  for (const [modelId, model] of Object.entries(models)) {
    if (!isPlainObject(model)) continue;

    const options = normalizeReasoningSummary(model.options);
    let variants = model.variants;
    if (isPlainObject(variants)) {
      for (const [variantId, variant] of Object.entries(variants)) {
        const normalizedVariant = normalizeReasoningSummary(variant);
        if (normalizedVariant === variant) continue;
        if (variants === model.variants) variants = { ...model.variants };
        variants[variantId] = normalizedVariant;
      }
    }

    if (options === model.options && variants === model.variants) continue;
    if (normalized === models) normalized = { ...models };
    normalized[modelId] = {
      ...model,
      ...(options === model.options ? {} : { options }),
      ...(variants === model.variants ? {} : { variants }),
    };
  }

  return normalized;
};

const removeNoneReasoningVariants = (models) => {
  if (!isPlainObject(models)) return {};

  let normalized = models;
  for (const [modelId, model] of Object.entries(models)) {
    if (!isPlainObject(model) || !isPlainObject(model.variants) || !("none" in model.variants)) {
      continue;
    }

    if (normalized === models) normalized = { ...models };
    const variants = { ...model.variants };
    delete variants.none;
    normalized[modelId] = { ...model, variants };
  }

  return normalized;
};

const enforceDetailedOpenAIReasoningSummary = (input, output) => {
  const model = input?.model;
  if (model?.providerID !== PROVIDER_ID || !isPlainObject(output)) return;

  const options = isPlainObject(output.options) ? output.options : {};
  const reasoningEffort = options.reasoningEffort;
  if (reasoningEffort === "none") return;

  const isReasoningCapable = reasoningEffort !== undefined || model?.capabilities?.reasoning === true;
  if (!isReasoningCapable) return;

  output.options = {
    ...options,
    reasoningSummary: "detailed",
  };
};

export const normalizeOpenAIOAuthGpt56Models = (models) => {
  if (!isPlainObject(models)) return {};

  const normalized = {};
  for (const [modelId, model] of Object.entries(models)) {
    if (isInvalidOAuthGpt56Model(modelId)) continue;
    if (LUNA_MODEL_IDS.has(modelId) && isPlainObject(model)) {
      const variants = isPlainObject(model.variants) ? { ...model.variants } : {};
      delete variants.ultra;
      normalized[modelId] = { ...model, variants };
      continue;
    }
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

export const OpenAIGpt56ModelsPlugin = async () => {
  let openAIOAuthActive = false;

  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const models = removeNoneReasoningVariants(provider?.models ?? {});
        openAIOAuthActive = ctx?.auth?.type === "oauth";
        const normalizedModels = openAIOAuthActive
          ? normalizeOpenAIOAuthGpt56Models(models)
          : models;
        return normalizeReasoningSummaries(normalizedModels);
      },
    },
    "chat.headers": async (input, output) => {
      const model = input?.model;
      if (
        !openAIOAuthActive
        || model?.providerID !== PROVIDER_ID
        || model?.api?.id !== LUNA_API_MODEL_ID
      ) {
        return;
      }

      output.headers.originator = CODEX_ORIGINATOR;
      output.headers["User-Agent"] = CODEX_USER_AGENT;
    },
    "chat.params": async (input, output) => {
      enforceDetailedOpenAIReasoningSummary(input, output);
    },
  };
};

export default OpenAIGpt56ModelsPlugin;
