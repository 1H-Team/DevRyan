import OpenAIGpt56ModelsPlugin from "./openai-gpt-5-6-models.mjs";

const { describe, expect, test } = process.env.VITEST
  ? await import("vitest")
  : await import("bun:test");

const model = (id, variants = {
  none: { reasoningEffort: "none" },
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  xhigh: { reasoningEffort: "xhigh" },
}) => ({
  id,
  name: id,
  variants,
});

describe("OpenAI GPT-5.6 provider model normalization", () => {
  test("keeps only real OAuth rows and adds the exact Max and Ultra matrix", async () => {
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
        "gpt-5.6-luna": model("gpt-5.6-luna"),
        "gpt-5.6-luna-fast": model("gpt-5.6-luna-fast"),
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
    expect(models["gpt-5.6-sol-fast"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-sol-fast"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(models["gpt-5.6-terra"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-terra"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(models["gpt-5.6-luna"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-luna"].variants.ultra).toBeUndefined();
    expect(models["gpt-5.6-luna-fast"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-luna-fast"].variants.ultra).toBeUndefined();
    expect(Object.keys(models["gpt-5.6-sol"].variants)).toEqual([
      "none",
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

  test("leaves API-key catalogs provider-driven", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const input = {
      "gpt-5.6": model("gpt-5.6"),
      "gpt-5.6-sol": model("gpt-5.6-sol"),
    };
    const models = await hooks.provider.models({ models: input }, { auth: { type: "api" } });

    expect(models).toBe(input);
  });
});
