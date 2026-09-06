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

const detailedReasoningVariant = (reasoningEffort) => ({
  ...reasoningVariant(reasoningEffort),
  reasoningSummary: "detailed",
});

const codexCatalogModel = (id, limit = {}) => ({
  ...model(id),
  limit: {
    context: 1_000_000,
    input: 900_000,
    output: 128_000,
    providerMetadata: "preserve-limit-metadata",
    ...limit,
  },
  providerMetadata: "preserve-model-metadata",
});

describe("OpenAI GPT-5.6 provider model normalization", () => {
  for (const authType of ["oauth", "api"]) {
    test(`omits unsupported Spark summaries from ${authType} catalog options and variants without lowering effort`, async () => {
      const hooks = await OpenAIGpt56ModelsPlugin();
      const ids = ["gpt-5.3-codex-spark", "gpt-5.3-codex-spark-fast", "custom-spark-alias"];
      const source = Object.fromEntries(ids.map(id => [id, {
        ...model(id, {
          high: { ...reasoningVariant("high"), reasoningSummary: "detailed" },
          low: { ...reasoningVariant("low"), reasoningSummary: "concise" },
          inherited: { reasoningSummary: "auto", providerMetadata: "preserve-variant" },
        }),
        ...(id === "custom-spark-alias" ? { api: { id: "gpt-5.3-codex-spark" } } : {}),
        options: { reasoningSummary: "auto", providerMetadata: "preserve-options" },
      }]));
      const normalized = await hooks.provider.models({ models: source }, { auth: { type: authType } });

      for (const id of ids) {
        expect(normalized[id].options).toEqual({ providerMetadata: "preserve-options" });
        expect(normalized[id].variants.high).toEqual({ reasoningEffort: "high", include: ["reasoning.encrypted_content"] });
        expect(normalized[id].variants.low).toEqual({ reasoningEffort: "low", include: ["reasoning.encrypted_content"] });
        expect(normalized[id].variants.inherited).toEqual({ providerMetadata: "preserve-variant" });
        expect(source[id].options.reasoningSummary).toBe("auto");
        expect(source[id].variants.high.reasoningSummary).toBe("detailed");
      }
    });
  }

  test("removes a reintroduced summary at the final Spark request hook for exact IDs and API aliases", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const identities = [
      { id: "gpt-5.3-codex-spark" },
      { id: "gpt-5.3-codex-spark-fast" },
      { id: "custom-spark-alias", api: { id: "gpt-5.3-codex-spark" } },
      { id: "custom-fast-alias", api: { id: "gpt-5.3-codex-spark-fast" } },
    ];
    for (const identity of identities) {
      for (const reasoningSummary of ["auto", "concise", "detailed", null, undefined]) {
        const options = { reasoningEffort: "high", reasoningSummary,
          include: ["reasoning.encrypted_content"], providerMetadata: "preserve-request" };
        const output = { options };
        await hooks["chat.params"]({ model: { ...identity, providerID: "openai", capabilities: { reasoning: true } } }, output);
        expect(output.options).toEqual({ reasoningEffort: "high",
          include: ["reasoning.encrypted_content"], providerMetadata: "preserve-request" });
        expect(Object.hasOwn(output.options, "reasoningSummary")).toBe(false);
        expect(Object.hasOwn(options, "reasoningSummary")).toBe(true);
        expect(options.reasoningSummary).toBe(reasoningSummary);
      }
    }
  });

  test("omits Spark summaries even when effort is inherited or disabled", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    for (const options of [{ reasoningSummary: "detailed" }, { reasoningEffort: "none", reasoningSummary: "auto" }]) {
      const output = { options };
      await hooks["chat.params"]({ model: { id: "gpt-5.3-codex-spark", providerID: "openai", capabilities: { reasoning: true } } }, output);
      expect(Object.hasOwn(output.options, "reasoningSummary")).toBe(false);
      expect(output.options.reasoningEffort).toBe(options.reasoningEffort);
    }
  });

  test("preserves references when Spark summaries are already absent and ignores other providers", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const options = { reasoningEffort: "high", include: ["reasoning.encrypted_content"] };
    const spark = { id: "gpt-5.3-codex-spark", options, variants: { high: options } };
    const source = { [spark.id]: spark };
    expect(await hooks.provider.models({ models: source }, { auth: { type: "api" } })).toBe(source);
    const output = { options };
    await hooks["chat.params"]({ model: { ...spark, providerID: "openai", capabilities: { reasoning: true } } }, output);
    expect(output.options).toBe(options);
    const empty = {};
    await hooks["chat.params"]({ model: { ...spark, providerID: "openai", capabilities: { reasoning: true } } }, empty);
    expect(empty).toEqual({});

    const otherOptions = { reasoningEffort: "high", reasoningSummary: "auto" };
    const otherOutput = { options: otherOptions };
    await hooks["chat.params"]({ model: { ...spark, providerID: "other", capabilities: { reasoning: true } } }, otherOutput);
    expect(otherOutput.options).toBe(otherOptions);
  });

  test("keeps supported model summaries detailed at low, high and inherited effort using the actual API identity", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    for (const identity of [
      { id: "gpt-5.6-sol" },
      { id: "gpt-5.3-codex" },
      { id: "gpt-5.3-codex-spark", api: { id: "gpt-5.6-sol" } },
    ]) {
      for (const reasoningEffort of ["low", "high", undefined]) {
        const output = { options: { ...(reasoningEffort ? { reasoningEffort } : {}), reasoningSummary: "auto", keep: true } };
        await hooks["chat.params"]({ model: { ...identity, providerID: "openai", capabilities: { reasoning: true } } }, output);
        expect(output.options).toEqual({ ...(reasoningEffort ? { reasoningEffort } : {}), reasoningSummary: "detailed", keep: true });
      }
    }
    const detailed = { reasoningEffort: "high", reasoningSummary: "detailed" };
    const output = { options: detailed };
    await hooks["chat.params"]({ model: { id: "gpt-5.6-sol", providerID: "openai", capabilities: { reasoning: true } } }, output);
    expect(output.options).toBe(detailed);
  });

  test("pins official Codex OAuth context windows and 256k compaction for supported models and fast rows", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.config({});
    const ids = [
      "gpt-5.4",
      "gpt-5.4-fast",
      "gpt-5.4-mini",
      "gpt-5.4-mini-fast",
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
    ];
    const models = await hooks.provider.models({
      models: Object.fromEntries(ids.map((id) => [id, codexCatalogModel(id)])),
    }, { auth: { type: "oauth" } });

    for (const id of ids) {
      const expectedContext = id.startsWith("gpt-5.4-mini") ? 400_000 : 1_050_000;
      expect(models[id].limit).toEqual({
        context: expectedContext,
        input: 276_000,
        output: 128_000,
        providerMetadata: "preserve-limit-metadata",
      });
      expect(models[id].providerMetadata).toBe("preserve-model-metadata");
      expect(models[id].limit.input - 20_000).toBe(256_000);
    }
  });

  test("incorporates an explicit OpenCode reservation without moving the 256k threshold", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.config({ compaction: { reserved: 7_500 } });
    const models = await hooks.provider.models({
      models: {
        "gpt-5.4": codexCatalogModel("gpt-5.4"),
        "gpt-5.4-mini": codexCatalogModel("gpt-5.4-mini"),
      },
    }, { auth: { type: "oauth" } });

    expect(models["gpt-5.4"].limit.context).toBe(1_050_000);
    expect(models["gpt-5.4-mini"].limit.context).toBe(400_000);
    for (const id of ["gpt-5.4", "gpt-5.4-mini"]) {
      expect(models[id].limit.input).toBe(263_500);
      expect(models[id].limit.input - 7_500).toBe(256_000);
    }
  });

  test("pins Codex Spark limits and incorporates an explicit OpenCode reservation", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.config({ compaction: { reserved: 7_500 } });
    const models = await hooks.provider.models({
      models: {
        "gpt-5.3-codex-spark": codexCatalogModel("gpt-5.3-codex-spark"),
        "gpt-5.3-codex-spark-fast": codexCatalogModel("gpt-5.3-codex-spark-fast"),
      },
    }, { auth: { type: "oauth" } });

    for (const id of ["gpt-5.3-codex-spark", "gpt-5.3-codex-spark-fast"]) {
      expect(models[id].limit.context).toBe(121_600);
      expect(models[id].limit.input).toBe(122_700);
      expect(models[id].limit.input - 7_500).toBe(115_200);
      expect(models[id].limit.output).toBe(128_000);
    }
  });

  test("uses OpenCode's output-aware default reservation and leaves unknown OAuth rows unchanged", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.config({ compaction: { reserved: -1 } });
    const unknown = codexCatalogModel("gpt-6", { output: 8_000 });
    const models = await hooks.provider.models({
      models: {
        "gpt-5.5": codexCatalogModel("gpt-5.5", { output: 8_000 }),
        "gpt-6": unknown,
      },
    }, { auth: { type: "oauth" } });

    expect(models["gpt-5.5"].limit.input).toBe(264_000);
    expect(models["gpt-5.5"].limit.input - 8_000).toBe(256_000);
    expect(models["gpt-6"]).toEqual({
      ...unknown,
      variants: {
        low: detailedReasoningVariant("low"),
        medium: detailedReasoningVariant("medium"),
        high: detailedReasoningVariant("high"),
        xhigh: detailedReasoningVariant("xhigh"),
      },
    });
  });

  test("preserves API-key context limits for models that receive OAuth parity", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    await hooks.config({ compaction: { reserved: 7_500 } });
    const input = codexCatalogModel("gpt-5.5");
    const models = await hooks.provider.models({
      models: { "gpt-5.5": input },
    }, { auth: { type: "api" } });

    expect(models["gpt-5.5"].limit).toEqual(input.limit);
  });

  test("uses detailed summaries for reasoning model options and variants", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const models = await hooks.provider.models({
      models: {
        "gpt-5.5": {
          ...model("gpt-5.5", {
            low: reasoningVariant("low"),
            concise: {
              ...reasoningVariant("medium"),
              reasoningSummary: "concise",
            },
            detailed: {
              ...reasoningVariant("high"),
              reasoningSummary: "detailed",
            },
            missing: {
              reasoningEffort: "xhigh",
              include: ["reasoning.encrypted_content"],
              providerMetadata: "preserve-missing-summary",
            },
            none: reasoningVariant("none"),
            nonreasoning: {
              reasoningSummary: "auto",
              providerMetadata: "leave-unchanged",
            },
          }),
          options: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
            providerMetadata: "preserve-model-options",
          },
        },
        "gpt-5.6-sol": {
          ...model("gpt-5.6-sol"),
          options: {
            reasoningEffort: "medium",
            include: ["reasoning.encrypted_content"],
            providerMetadata: "preserve-sol-options",
          },
        },
      },
    }, { auth: { type: "oauth" } });

    expect(models["gpt-5.5"].options).toEqual({
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      include: ["reasoning.encrypted_content"],
      providerMetadata: "preserve-model-options",
    });
    expect(models["gpt-5.5"].variants.low).toEqual(detailedReasoningVariant("low"));
    expect(models["gpt-5.5"].variants.concise.reasoningSummary).toBe("concise");
    expect(models["gpt-5.5"].variants.detailed.reasoningSummary).toBe("detailed");
    expect(models["gpt-5.5"].variants.missing).toEqual({
      reasoningEffort: "xhigh",
      reasoningSummary: "detailed",
      include: ["reasoning.encrypted_content"],
      providerMetadata: "preserve-missing-summary",
    });
    expect(models["gpt-5.5"].variants.nonreasoning).toEqual({
      reasoningSummary: "auto",
      providerMetadata: "leave-unchanged",
    });
    expect(models["gpt-5.6-sol"].options).toEqual({
      reasoningEffort: "medium",
      reasoningSummary: "detailed",
      include: ["reasoning.encrypted_content"],
      providerMetadata: "preserve-sol-options",
    });
    expect(models["gpt-5.6-sol"].variants.max).toEqual(detailedReasoningVariant("max"));
    expect(models["gpt-5.6-sol"].variants.ultra).toEqual(detailedReasoningVariant("ultra"));
  });

  test("keeps only real OAuth rows and preserves upstream Luna Max without Ultra", async () => {
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
          max: {
            ...reasoningVariant("max"),
            providerMetadata: "preserve-luna-max",
          },
          ultra: reasoningVariant("ultra"),
        }),
        "gpt-5.6-luna-fast": model("gpt-5.6-luna-fast", {
          ...model("template").variants,
          max: {
            ...reasoningVariant("max"),
            providerMetadata: "preserve-luna-fast-max",
          },
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
    expect(models["gpt-5.6-sol"].variants.max).toEqual(detailedReasoningVariant("max"));
    expect(models["gpt-5.6-sol"].variants.ultra).toEqual(detailedReasoningVariant("ultra"));
    expect(models["gpt-5.6-sol-fast"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-sol-fast"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(models["gpt-5.6-terra"].variants.max.reasoningEffort).toBe("max");
    expect(models["gpt-5.6-terra"].variants.ultra.reasoningEffort).toBe("ultra");
    expect(Object.keys(models["gpt-5.6-luna"].variants)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(Object.keys(models["gpt-5.6-luna-fast"].variants)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(models["gpt-5.6-luna"].variants.max).toEqual({
      ...detailedReasoningVariant("max"),
      providerMetadata: "preserve-luna-max",
    });
    expect(models["gpt-5.6-luna-fast"].variants.max).toEqual({
      ...detailedReasoningVariant("max"),
      providerMetadata: "preserve-luna-fast-max",
    });
    expect(models["gpt-5.6-luna"].variants.ultra).toBeUndefined();
    expect(models["gpt-5.6-luna-fast"].variants.ultra).toBeUndefined();
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

  test("does not synthesize Max when the upstream Luna rows omit it", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const models = await hooks.provider.models({
      models: {
        "gpt-5.6-luna": model("gpt-5.6-luna"),
        "gpt-5.6-luna-fast": model("gpt-5.6-luna-fast"),
      },
    }, { auth: { type: "oauth" } });

    expect(models["gpt-5.6-luna"].variants.max).toBeUndefined();
    expect(models["gpt-5.6-luna-fast"].variants.max).toBeUndefined();
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
        low: detailedReasoningVariant("low"),
        medium: detailedReasoningVariant("medium"),
        high: detailedReasoningVariant("high"),
        xhigh: detailedReasoningVariant("xhigh"),
      },
    });
    expect(models["gpt-5.6-sol"]).toEqual({
      ...input["gpt-5.6-sol"],
      variants: {
        low: detailedReasoningVariant("low"),
        medium: detailedReasoningVariant("medium"),
        high: detailedReasoningVariant("high"),
        xhigh: detailedReasoningVariant("xhigh"),
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

  test("enforces detailed summaries on every reasoning-capable OpenAI request", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const output = {
      options: {
        reasoningEffort: "high",
        reasoningSummary: "concise",
        include: ["reasoning.encrypted_content"],
        providerMetadata: "preserve-request-options",
      },
    };

    await hooks["chat.params"]({
      model: { providerID: "openai", capabilities: { reasoning: true } },
      agent: "orchestrator",
    }, output);

    expect(output.options).toEqual({
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      include: ["reasoning.encrypted_content"],
      providerMetadata: "preserve-request-options",
    });
  });

  test("uses model capability when an OpenAI override omits reasoning effort", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const output = { options: { providerMetadata: "preserve-override" } };

    await hooks["chat.params"]({
      model: { providerID: "openai", capabilities: { reasoning: true } },
    }, output);

    expect(output.options).toEqual({
      providerMetadata: "preserve-override",
      reasoningSummary: "detailed",
    });
  });

  test("preserves none, non-reasoning models, and non-OpenAI requests", async () => {
    const hooks = await OpenAIGpt56ModelsPlugin();
    const noneOutput = { options: { reasoningEffort: "none", reasoningSummary: "auto", keep: true } };
    const nonReasoningOutput = { options: { reasoningSummary: "auto", keep: true } };
    const anthropicOutput = { options: { reasoningEffort: "high", reasoningSummary: "concise", keep: true } };

    await hooks["chat.params"]({
      model: { providerID: "openai", capabilities: { reasoning: true } },
    }, noneOutput);
    await hooks["chat.params"]({
      model: { providerID: "openai", capabilities: { reasoning: false } },
    }, nonReasoningOutput);
    await hooks["chat.params"]({
      model: { providerID: "anthropic", capabilities: { reasoning: true } },
    }, anthropicOutput);

    expect(noneOutput.options).toEqual({ reasoningEffort: "none", reasoningSummary: "auto", keep: true });
    expect(nonReasoningOutput.options).toEqual({ reasoningSummary: "auto", keep: true });
    expect(anthropicOutput.options).toEqual({ reasoningEffort: "high", reasoningSummary: "concise", keep: true });
  });
});
