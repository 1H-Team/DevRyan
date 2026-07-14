import OpenAIGpt56ModelsPlugin from "./openai-gpt-5-6-models.mjs";

const { describe, expect, test } = process.env.VITEST
  ? await import("vitest")
  : await import("bun:test");

const reasoningVariant = (reasoningEffort) => ({
  reasoningEffort,
  reasoningSummary: "auto",
  include: ["reasoning.encrypted_content"],
});

const model = (id, variants = {
  none: reasoningVariant("none"),
  low: reasoningVariant("low"),
  medium: reasoningVariant("medium"),
  high: reasoningVariant("high"),
  xhigh: reasoningVariant("xhigh"),
}) => ({
  id,
  name: id,
  variants,
});

describe("OpenAI GPT-5.6 provider model normalization", () => {
  test("keeps only real OAuth rows and constrains Luna to its verified reasoning matrix", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const models = await hooks.provider.models({
      models: {
        "gpt-5.5": model("gpt-5.5"),
        "gpt-5.6": model("gpt-5.6"),
        "gpt-5.6-pro": model("gpt-5.6-pro"),
        "gpt-5.6-sol": model("gpt-5.6-sol"),
        "gpt-5.6-sol-fast": model("gpt-5.6-sol-fast"),
        "gpt-5.6-sol-pro": model("gpt-5.6-sol-pro"),
        "gpt-5.6-terra": model("gpt-5.6-terra"),
        "gpt-5.6-terra-fast": model("gpt-5.6-terra-fast"),
        "gpt-5.6-luna": model("gpt-5.6-luna", {
          ...model("template").variants,
          max: reasoningVariant("max"),
          ultra: reasoningVariant("ultra"),
        }),
        "gpt-5.6-luna-fast": model("gpt-5.6-luna-fast", {
          ...model("template").variants,
          max: reasoningVariant("max"),
          ultra: reasoningVariant("ultra"),
        }),
      },
    }, { auth: { type: "oauth" } });

    expect(Object.keys(models).sort()).toEqual([
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
    ]);
    expect(models["gpt-5.6-sol"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-sol"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(models["gpt-5.6-sol"].variants.max).toEqual(reasoningVariant("max"));
    expect(models["gpt-5.6-sol"].variants.ultra).toEqual(reasoningVariant("ultra"));
    expect(models["gpt-5.6-sol-fast"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-sol-fast"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(models["gpt-5.6-terra"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-terra"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(Object.keys(models["gpt-5.6-luna"].variants)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(Object.keys(models["gpt-5.6-luna-fast"].variants)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(Object.keys(models["gpt-5.6-sol"].variants)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  test("does not invent missing GPT-5.6 rows", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const models = await hooks.provider.models({
      models: {
        "gpt-5.6-sol": model("gpt-5.6-sol"),
      },
    }, { auth: { type: "oauth" } });

    expect(Object.keys(models)).toEqual(["gpt-5.6-sol"]);
    expect(models["gpt-5.6-terra"]).toBeUndefined();
    expect(models["gpt-5.6-luna"]).toBeUndefined();
  });

  test("removes none from API-key catalogs without changing other provider metadata", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const input = {
      "gpt-5.6": model("gpt-5.6"),
      "gpt-5.6-sol": model("gpt-5.6-sol"),
    };
    const models = await hooks.provider.models({ models: input }, { auth: { type: "api" } });

    expect(models["gpt-5.6"]).toEqual({
      ...input["gpt-5.6"],
      variants: {
        low: reasoningVariant("low"),
        medium: reasoningVariant("medium"),
        high: reasoningVariant("high"),
        xhigh: reasoningVariant("xhigh"),
      },
    });
    expect(models["gpt-5.6-sol"]).toEqual({
      ...input["gpt-5.6-sol"],
      variants: {
        low: reasoningVariant("low"),
        medium: reasoningVariant("medium"),
        high: reasoningVariant("high"),
        xhigh: reasoningVariant("xhigh"),
      },
    });
  });

  test("adds Codex identity headers to OAuth Luna requests", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.provider.models({ models: {} }, { auth: { type: "oauth" } });
    const output = { headers: {} };

    await hooks["chat.headers"]({
      model: {
        id: "gpt-5.6-luna",
        providerID: "openai",
        api: { id: "gpt-5.6-luna" },
      },
    }, output);

    expect(output.headers).toEqual({
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.0.0 (OpenCode)",
    });
  });

  test("adds Codex identity headers to OAuth Luna Fast requests", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.provider.models({ models: {} }, { auth: { type: "oauth" } });
    const output = { headers: {} };

    await hooks["chat.headers"]({
      model: {
        id: "gpt-5.6-luna-fast",
        providerID: "openai",
        api: { id: "gpt-5.6-luna" },
      },
    }, output);

    expect(output.headers).toEqual({
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.0.0 (OpenCode)",
    });
  });

  test("does not add Codex identity headers outside OpenAI OAuth Luna", async () => {
    const apiHooks = await OpenAIGpt56ModelsPlugin();
    await apiHooks.provider.models({ models: {} }, { auth: { type: "api" } });
    const apiOutput = { headers: { existing: "value" } };
    await apiHooks["chat.headers"]({
      model: { id: "gpt-5.6-luna", providerID: "openai", api: { id: "gpt-5.6-luna" } },
    }, apiOutput);

    const oauthHooks = await OpenAIGpt56ModelsPlugin();
    await oauthHooks.provider.models({ models: {} }, { auth: { type: "oauth" } });
    const solOutput = { headers: { existing: "value" } };
    await oauthHooks["chat.headers"]({
      model: { id: "gpt-5.6-sol", providerID: "openai", api: { id: "gpt-5.6-sol" } },
    }, solOutput);

    expect(apiOutput.headers).toEqual({ existing: "value" });
    expect(solOutput.headers).toEqual({ existing: "value" });
  });
});
