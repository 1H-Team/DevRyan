// GitHub Copilot models picker fallback (DevRyan-bundled OpenCode plugin)
//
// Problem: OpenCode's built-in Copilot plugin filters account models to those
// with `model_picker_enabled: true`. GitHub sometimes returns every model with
// that flag false, so OpenCode registers zero executable models. Prompts then
// fail asynchronously with ProviderModelNotFoundError after prompt_async accepts.
//
// Fix: register a later `provider.models` hook for `github-copilot` that:
// - prefers picker-enabled models when any exist (match upstream)
// - otherwise exposes only API-returned utility models that GitHub documents as
//   universally enabled, rather than guessing that every non-picker row is
//   manually selectable
// Packaged plugins load after built-ins, so this overwrites the empty list.

const PROVIDER_ID = "github-copilot";
const API_BASE = "https://api.githubcopilot.com";
const API_VERSION = "2026-06-01";
const COPILOT_NPM = "@ai-sdk/github-copilot";
const ANTHROPIC_NPM = "@ai-sdk/anthropic";
const UTILITY_MODEL_IDS = new Set([
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5.4-nano",
]);
const AUTO_MODEL = {
  id: "auto",
  name: "Auto",
  limit: {
    context: 128_000,
    input: 128_000,
    output: 16_384,
  },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
);

const isEmbeddingModel = (id) => /embedding/i.test(String(id || ""));

const isUsableRemoteModel = (row) => {
  if (!isPlainObject(row)) return false;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || isEmbeddingModel(id)) return false;
  if (row.policy?.state === "disabled") return false;
  const limits = row.capabilities?.limits;
  const supports = row.capabilities?.supports;
  if (!isPlainObject(limits) || !isPlainObject(supports)) return false;
  if (typeof limits.max_output_tokens !== "number") return false;
  if (typeof limits.max_prompt_tokens !== "number") return false;
  if (typeof supports.tool_calls !== "boolean") return false;
  return true;
};

const resolveEndpoint = (row) => {
  const endpoints = Array.isArray(row.supported_endpoints) ? row.supported_endpoints : [];
  if (endpoints.includes("/v1/messages")) return "messages";
  if (endpoints.includes("/responses")) return "responses";
  if (endpoints.includes("/chat/completions")) return "chat";
  return undefined;
};

const buildModel = (row, existing) => {
  const id = row.id.trim();
  const endpoint = resolveEndpoint(row);
  const isMsgApi = endpoint === "messages";
  const prev = isPlainObject(existing) ? existing : {};
  const prevApi = isPlainObject(prev.api) ? prev.api : {};
  const reasoning = Boolean(
    supportsFlag(row, "adaptive_thinking")
    || (Array.isArray(row.capabilities?.supports?.reasoning_effort)
      && row.capabilities.supports.reasoning_effort.length > 0)
    || row.capabilities?.supports?.max_thinking_budget !== undefined
    || row.capabilities?.supports?.min_thinking_budget !== undefined,
  );
  const vision = Boolean(
    row.capabilities?.supports?.vision
    || (row.capabilities?.limits?.vision?.supported_media_types || []).some((item) => (
      typeof item === "string" && item.startsWith("image/")
    )),
  );

  return {
    ...prev,
    id,
    providerID: PROVIDER_ID,
    name: typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : (typeof prev.name === "string" ? prev.name : id),
    status: "active",
    api: {
      ...prevApi,
      id,
      url: isMsgApi ? `${API_BASE}/v1` : API_BASE,
      npm: isMsgApi ? ANTHROPIC_NPM : COPILOT_NPM,
      ...(endpoint ? { endpoint } : {}),
    },
    limit: {
      context: row.capabilities?.limits?.max_context_window_tokens
        ?? row.capabilities?.limits?.max_prompt_tokens,
      input: row.capabilities?.limits?.max_prompt_tokens,
      output: row.capabilities?.limits?.max_output_tokens,
    },
    capabilities: {
      temperature: prev.capabilities?.temperature ?? true,
      reasoning: prev.capabilities?.reasoning ?? reasoning,
      attachment: prev.capabilities?.attachment ?? true,
      toolcall: row.capabilities?.supports?.tool_calls === true,
      input: {
        text: true,
        audio: false,
        image: vision,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
  };
};

const supportsFlag = (row, key) => Boolean(row.capabilities?.supports?.[key]);

const addAutoModel = (models) => ({
  auto: fixConfiguredModel(AUTO_MODEL, "auto"),
  ...models,
  auto: fixConfiguredModel(AUTO_MODEL, "auto"),
});

export const selectGitHubCopilotRemoteModels = (rows, existingModels = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const usable = list.filter(isUsableRemoteModel);
  const pickerEnabled = usable.filter((row) => row.model_picker_enabled === true);
  const selected = pickerEnabled.length > 0
    ? pickerEnabled
    : usable.filter((row) => UTILITY_MODEL_IDS.has(row.id.trim()));
  const models = {};
  for (const row of selected) {
    const id = row.id.trim();
    models[id] = buildModel(row, existingModels[id]);
  }
  return addAutoModel(models);
};

const fixConfiguredModel = (model, id) => {
  const prev = isPlainObject(model) ? model : {};
  const prevApi = isPlainObject(prev.api) ? prev.api : {};
  return {
    ...prev,
    id,
    providerID: PROVIDER_ID,
    api: {
      ...prevApi,
      id: typeof prevApi.id === "string" && prevApi.id.trim() ? prevApi.id : id,
      url: typeof prevApi.url === "string" && prevApi.url.trim() ? prevApi.url : API_BASE,
      npm: typeof prevApi.npm === "string" && prevApi.npm.trim() ? prevApi.npm : COPILOT_NPM,
    },
  };
};

const fetchAccountModels = async (auth, existingModels, fetchImpl = globalThis.fetch) => {
  const token = typeof auth?.refresh === "string" && auth.refresh.trim()
    ? auth.refresh.trim()
    : typeof auth?.access === "string" && auth.access.trim()
      ? auth.access.trim()
      : "";
  if (!token || typeof fetchImpl !== "function") {
    return null;
  }

  const response = await fetchImpl(`${API_BASE}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "opencode/devryan",
      "X-GitHub-Api-Version": API_VERSION,
    },
    ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? { signal: AbortSignal.timeout(5_000) }
      : {}),
  });
  if (!response?.ok) {
    throw new Error(`GitHub Copilot models request failed (${response?.status || "unknown"})`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return selectGitHubCopilotRemoteModels(rows, existingModels);
};

export const GitHubCopilotModelsPlugin = async () => {
  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const existing = isPlainObject(provider?.models) ? provider.models : {};
        if (ctx.auth?.type !== "oauth") {
          return addAutoModel(Object.fromEntries(
            Object.entries(existing).map(([id, model]) => [id, fixConfiguredModel(model, id)]),
          ));
        }

        try {
          const next = await fetchAccountModels(ctx.auth, existing);
          if (next && Object.keys(next).length > 0) {
            return next;
          }
        } catch {
          // Fall through to configured models so overlay/config backups remain usable.
        }

        return addAutoModel(Object.fromEntries(
          Object.entries(existing).map(([id, model]) => [id, fixConfiguredModel(model, id)]),
        ));
      },
    },
  };
};

export default GitHubCopilotModelsPlugin;
