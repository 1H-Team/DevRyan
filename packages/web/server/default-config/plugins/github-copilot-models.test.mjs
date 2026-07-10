import GitHubCopilotModelsPlugin, {
  selectGitHubCopilotRemoteModels,
} from "./github-copilot-models.mjs";

const { describe, expect, test } = process.env.VITEST
  ? await import("vitest")
  : await import("bun:test");

const usable = (id, overrides = {}) => ({
  id,
  name: id,
  model_picker_enabled: false,
  version: `${id}-2026-01-01`,
  capabilities: {
    family: "gpt",
    limits: {
      max_context_window_tokens: 128000,
      max_output_tokens: 16384,
      max_prompt_tokens: 120000,
    },
    supports: {
      tool_calls: true,
      streaming: true,
    },
  },
  ...overrides,
});

describe("github-copilot-models plugin selection", () => {
  test("prefers picker-enabled models when any exist", () => {
    const models = selectGitHubCopilotRemoteModels([
      usable("gpt-hidden"),
      usable("gpt-visible", { model_picker_enabled: true }),
      usable("embed-model", {
        id: "text-embedding-3-small",
        model_picker_enabled: true,
      }),
    ]);

    expect(Object.keys(models)).toEqual(["gpt-visible"]);
    expect(models["gpt-visible"].api).toEqual({
      id: "gpt-visible",
      url: "https://api.githubcopilot.com",
      npm: "@ai-sdk/github-copilot",
    });
  });

  test("falls back to all usable models when picker flags are all false", () => {
    const models = selectGitHubCopilotRemoteModels([
      usable("gpt-5.3-codex"),
      usable("gpt-5.4-mini"),
      usable("text-embedding-3-small"),
      usable("incomplete", {
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 100 },
          supports: {},
        },
      }),
      usable("disabled", { policy: { state: "disabled" } }),
    ]);

    expect(Object.keys(models).sort()).toEqual(["gpt-5.3-codex", "gpt-5.4-mini"]);
    expect(models["gpt-5.3-codex"].providerID).toBe("github-copilot");
    expect(models["gpt-5.3-codex"].capabilities.toolcall).toBe(true);
  });

  test("uses anthropic npm + messages endpoint for /v1/messages models", () => {
    const models = selectGitHubCopilotRemoteModels([
      usable("claude-sonnet-4.6", {
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
      }),
    ]);

    expect(models["claude-sonnet-4.6"].api).toEqual({
      id: "claude-sonnet-4.6",
      url: "https://api.githubcopilot.com/v1",
      npm: "@ai-sdk/anthropic",
      endpoint: "messages",
    });
  });
});

describe("github-copilot-models plugin hook", () => {
  test("oauth path uses picker fallback when GitHub returns no picker-enabled models", async () => {
    const hooks = await GitHubCopilotModelsPlugin();
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        data: [
          usable("gpt-5.3-codex"),
          usable("gpt-5.4-mini"),
        ],
      }),
    });

    // Patch fetch for this call by temporarily replacing globalThis.fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const models = await hooks.provider.models(
        { models: {} },
        { auth: { type: "oauth", refresh: "token", access: "token" } },
      );
      expect(Object.keys(models).sort()).toEqual(["gpt-5.3-codex", "gpt-5.4-mini"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("non-oauth path fixes configured models with runnable api metadata", async () => {
    const hooks = await GitHubCopilotModelsPlugin();
    const models = await hooks.provider.models(
      {
        models: {
          "gpt-5.3-codex": { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
        },
      },
      { auth: { type: "api" } },
    );

    expect(models["gpt-5.3-codex"].api).toEqual({
      id: "gpt-5.3-codex",
      url: "https://api.githubcopilot.com",
      npm: "@ai-sdk/github-copilot",
    });
  });
});
