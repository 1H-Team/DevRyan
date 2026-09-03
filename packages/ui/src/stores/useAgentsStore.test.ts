import { describe, expect, test } from "bun:test";
import type { Agent } from "@opencode-ai/sdk/v2";
import {
  buildAgentConfigPayload,
  buildAgentModelOverridePayload,
  buildSettingsAgentCatalog,
  filterVisibleAgentSelectorOptions,
  filterVisibleSettingsAgents,
  normalizeAgentForSettings,
  useAgentsStore,
} from "./useAgentsStore";
import { useConfigStore } from "./useConfigStore";
import { useSelectionStore } from "@/sync/selection-store";

const makeAgent = (agent: Partial<Agent> & { name: string }): Agent => agent as Agent;
const originalFetch = globalThis.fetch;

describe("filterVisibleAgentSelectorOptions", () => {
  test("keeps the legacy build agent when no builder agent exists", () => {
    const agents = [
      makeAgent({ name: "build", description: "The default agent.", mode: "primary" }),
      makeAgent({ name: "council", mode: "primary" }),
    ];

    expect(filterVisibleAgentSelectorOptions(agents).map((agent) => agent.name)).toEqual([
      "build",
      "council",
    ]);
  });

  test("keeps the builder agent when no build agent exists", () => {
    const agents = [
      makeAgent({ name: "builder", description: "General-purpose coding agent.", mode: "primary" }),
      makeAgent({ name: "council", mode: "primary" }),
    ];

    expect(filterVisibleAgentSelectorOptions(agents).map((agent) => agent.name)).toEqual([
      "builder",
      "council",
    ]);
  });

  test("dedupes build and builder by preferring the canonical builder agent", () => {
    const agents = [
      makeAgent({ name: "build", description: "The default agent.", mode: "primary" }),
      makeAgent({ name: "builder", description: "General-purpose coding agent.", mode: "primary" }),
      makeAgent({ name: "council", mode: "primary" }),
    ];

    const visibleNames = filterVisibleAgentSelectorOptions(agents).map((agent) => agent.name);

    expect(visibleNames).toEqual(["builder", "council"]);
  });
});

describe("filterVisibleSettingsAgents", () => {
  test("hides the plan agent from settings without removing other visible agents", () => {
    const agents = [
      makeAgent({ name: "builder", description: "General-purpose coding agent.", mode: "primary" }),
      makeAgent({ name: "plan", description: "Plan mode rules.", mode: "primary" }),
      makeAgent({ name: "reviewer", mode: "subagent" }),
    ];

    expect(filterVisibleSettingsAgents(agents).map((agent) => agent.name)).toEqual([
      "builder",
      "reviewer",
    ]);
  });
});

describe("Council agent model config serialization", () => {
  test("serializes multiple Council models as scalar model plus ordered modelRefs", () => {
    const payload = buildAgentConfigPayload({
      name: "council",
      mode: "all",
      model: "openai/gpt-5.5",
      modelRefs: ["openai/gpt-5.5", "opencode-go/kimi-k2.6", "opencode-go/deepseek-v4-pro"],
      variant: "medium",
    });

    expect(payload.model).toBe("openai/gpt-5.5");
    expect(payload.modelRefs).toEqual([
      "openai/gpt-5.5",
      "opencode-go/kimi-k2.6",
      "opencode-go/deepseek-v4-pro",
    ]);
  });

  test("normalizes OpenCode options.modelRefs for Settings round-tripping", () => {
    const agent = normalizeAgentForSettings({
      name: "council",
      mode: "all",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      options: {
        modelRefs: ["openai/gpt-5.5", "opencode-go/kimi-k2.6"],
      },
    } as unknown as Agent);

    expect((agent as Agent & { modelRefs?: string[] }).modelRefs).toEqual([
      "openai/gpt-5.5",
      "opencode-go/kimi-k2.6",
    ]);
  });

  test("serializes Council user overrides with ordered councillor variants", () => {
    const payload = buildAgentModelOverridePayload({
      name: "council",
      model: "openai/gpt-5.5",
      variant: "medium",
      modelRefs: ["openai/gpt-5.3-codex", "opencode-go/kimi-k2.6"],
      councillors: [
        { model: "openai/gpt-5.3-codex", variant: "high" },
        { model: "opencode-go/kimi-k2.6", variant: undefined },
      ],
      description: "Ignored inherited description",
      prompt: "Ignored inherited prompt",
    });

    expect(payload).toEqual({
      model: "openai/gpt-5.5",
      variant: "medium",
      councillors: [
        { model: "openai/gpt-5.3-codex", variant: "high" },
        { model: "opencode-go/kimi-k2.6", variant: null },
      ],
    });
  });

  test("serializes an explicit default thinking override as null", () => {
    const payload = buildAgentModelOverridePayload({
      name: "builder",
      model: "openai/gpt-5.5",
      variant: undefined,
    });

    expect(payload).toEqual({
      model: "openai/gpt-5.5",
      variant: null,
    });
  });
});

describe("agent model override persistence", () => {
  test("saves an agent model override through the override route", async () => {
    let fetchCalls = 0;
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      expect(String(input).startsWith("/api/config/agents/builder/override")).toBe(true);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "openai/gpt-5.5",
        variant: "high",
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentModelOverride("builder", {
        model: "openai/gpt-5.5",
        variant: "high",
      });

      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps saved model and thinking override in the settings store when the response omits agent config", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        modelRefs: ["anthropic/claude-sonnet-4-5"],
        variant: "low",
      } as Partial<Agent> & { name: string })],
    });

    let requestBody: unknown = null;
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentModelOverride("builder", {
        model: "openai/gpt-5.5",
        variant: "high",
      });

      expect(requestBody).toEqual({ model: "openai/gpt-5.5", variant: "high" });
      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "builder") as Agent & { modelRefs?: string[]; variant?: string };
      expect(savedAgent.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
      expect(savedAgent.modelRefs).toEqual(["openai/gpt-5.5"]);
      expect(savedAgent.variant).toBe("high");
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents });
    }
  });

  test("returns runtime warning metadata while keeping the saved model locally", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "fixer",
        mode: "subagent",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        modelRefs: ["openai/gpt-5.5"],
        variant: "high",
      } as Partial<Agent> & { name: string })],
    });

    const fetchMock = async () => new Response(JSON.stringify({
      success: true,
      runtimeApplied: false,
      reloadFailed: true,
      warning: 'Agent "fixer" loaded with model "openai/gpt-5.5"; expected "cursor-acp/composer-2.5"',
    }), { status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await useAgentsStore.getState().saveAgentModelOverride("fixer", {
        model: "cursor-acp/composer-2.5",
        variant: undefined,
      });

      expect((result as Record<string, unknown>)?.runtimeApplied).toBe(false);
      expect((result as Record<string, unknown>)?.reloadFailed).toBe(true);
      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "fixer") as Agent & { modelRefs?: string[]; variant?: string };
      expect(savedAgent.model).toEqual({ providerID: "cursor-acp", modelID: "composer-2.5" });
      expect(savedAgent.modelRefs).toEqual(["cursor-acp/composer-2.5"]);
      expect(savedAgent.variant).toBe(undefined);
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents });
    }
  });

  test("sends null when saving the default thinking level and clears local variant", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        modelRefs: ["anthropic/claude-sonnet-4-5"],
        variant: "high",
      } as Partial<Agent> & { name: string })],
    });

    let requestBody: unknown = null;
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentModelOverride("builder", {
        model: "openai/gpt-5.5",
        variant: undefined,
      });

      expect(requestBody).toEqual({ model: "openai/gpt-5.5", variant: null });
      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "builder") as Agent & { modelRefs?: string[]; variant?: string };
      expect(savedAgent.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
      expect(savedAgent.modelRefs).toEqual(["openai/gpt-5.5"]);
      expect(savedAgent.variant).toBe(undefined);
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents });
    }
  });

  test("does not let a stale in-flight agents load overwrite a saved override", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        modelRefs: ["anthropic/claude-sonnet-4-5"],
        variant: "low",
      } as Partial<Agent> & { name: string })],
    });

    let resolveAgentsResponse!: (response: Response) => void;
    const agentsResponse = new Promise<Response>((resolve) => {
      resolveAgentsResponse = resolve;
    });
    let agentsListRequested!: () => void;
    const agentsListRequestStarted = new Promise<void>((resolve) => {
      agentsListRequested = resolve;
    });

    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/config/agents/builder/override")) {
        expect(init?.method).toBe("PUT");
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      if (url.startsWith("/api/config/agents/builder")) {
        return new Response(JSON.stringify({ scope: "packaged" }), { status: 200 });
      }

      if (url.startsWith("/api/config/agents")) {
        agentsListRequested();
        return agentsResponse;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const loadPromise = useAgentsStore.getState().loadAgents();
      await agentsListRequestStarted;

      await useAgentsStore.getState().saveAgentModelOverride("builder", {
        model: "openai/gpt-5.5",
        variant: "high",
      });

      resolveAgentsResponse(new Response(JSON.stringify({
        agents: [{
          name: "builder",
          mode: "primary",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          modelRefs: ["anthropic/claude-sonnet-4-5"],
          variant: "low",
        }],
      }), { status: 200 }));
      await loadPromise;

      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "builder") as Agent & { modelRefs?: string[]; variant?: string };
      expect(savedAgent.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
      expect(savedAgent.modelRefs).toEqual(["openai/gpt-5.5"]);
      expect(savedAgent.variant).toBe("high");
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents, isLoading: false });
    }
  });

  test("resets an agent model override through the override route", async () => {
    let fetchCalls = 0;
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      expect(String(input).startsWith("/api/config/agents/builder/override")).toBe(true);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ success: true, deleted: true }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().resetAgentModelOverride("builder");

      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("saves a backup model through the backup-model route and reconciles the local record from the response", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        modelRefs: ["anthropic/claude-sonnet-4-5"],
        variant: "low",
      } as Partial<Agent> & { name: string })],
    });

    let fetchCalls = 0;
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      expect(String(input).startsWith("/api/config/agents/builder/backup-model")).toBe(true);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ model: "openai/gpt-5.5", variant: "high" });
      return new Response(JSON.stringify({
        success: true,
        backupModel: { model: "openai/gpt-5.5", variant: "high" },
        agent: {
          source: "md",
          scope: "project",
          config: {
            name: "builder",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            modelRefs: ["anthropic/claude-sonnet-4-5"],
            variant: "low",
            backupModel: { providerID: "openai", modelID: "gpt-5.5", variant: "high" },
          },
        },
      }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentBackupModel("builder", { model: "openai/gpt-5.5", variant: "high" });

      expect(fetchCalls).toBe(1);
      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "builder") as Agent & {
        backupModel?: { providerID: string; modelID: string; variant: string | null } | null;
        variant?: string;
      };
      expect(savedAgent.backupModel).toEqual({ providerID: "openai", modelID: "gpt-5.5", variant: "high" });
      expect(savedAgent.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
      expect(savedAgent.variant).toBe("low");
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents });
    }
  });

  test("sends a null backup variant and reconciles from the request when the response omits agent config", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "builder",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      } as Partial<Agent> & { name: string })],
    });

    let requestBody: unknown = null;
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentBackupModel("builder", { model: "openai/gpt-5.5", variant: "  " });

      expect(requestBody).toEqual({ model: "openai/gpt-5.5", variant: null });
      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "builder") as Agent & {
        backupModel?: { providerID: string; modelID: string; variant: string | null } | null;
      };
      expect(savedAgent.backupModel).toEqual({ providerID: "openai", modelID: "gpt-5.5", variant: null });
      expect(savedAgent.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents });
    }
  });

  test("rejects a malformed backup model ref before calling the host and surfaces host errors", async () => {
    let fetchCalls = 0;
    const fetchMock = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: "Agent backup model must differ from the primary model" }), { status: 400 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(useAgentsStore.getState().saveAgentBackupModel("builder", { model: "   " })).rejects.toThrow(/provider\/model/);
      expect(fetchCalls).toBe(0);

      await expect(useAgentsStore.getState().saveAgentBackupModel("builder", { model: "anthropic/claude-sonnet-4-5" }))
        .rejects.toThrow("Agent backup model must differ from the primary model");
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("clears a backup model through the backup-model route and nulls the local record", async () => {
    const originalAgents = useAgentsStore.getState().agents;
    useAgentsStore.setState({
      agents: [makeAgent({
        name: "builder",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        backupModel: { providerID: "openai", modelID: "gpt-5.5", variant: "high" },
      } as Partial<Agent> & { name: string })],
    });

    let fetchCalls = 0;
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      expect(String(input).startsWith("/api/config/agents/builder/backup-model")).toBe(true);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ success: true, deleted: true, backupModel: null }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().resetAgentBackupModel("builder");

      expect(fetchCalls).toBe(1);
      const savedAgent = useAgentsStore.getState().agents.find((agent) => agent.name === "builder") as Agent & {
        backupModel?: unknown;
      };
      expect(savedAgent.backupModel).toBeNull();
      expect(savedAgent.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalAgents });
    }
  });

  test("syncs saved override agent config into the chat config store", async () => {
    const originalAgents = useConfigStore.getState().agents;
    const originalSettingsAgents = useAgentsStore.getState().agents;
    const nextAgent = makeAgent({
      name: "builder",
      mode: "primary",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      variant: "high",
    });
    useAgentsStore.setState({
      agents: [makeAgent({ name: "builder", mode: "primary", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })],
    });
    useConfigStore.setState({
      agents: [makeAgent({ name: "builder", mode: "primary", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })],
      directoryScoped: {},
    });

    let fetchCalls = 0;
    const fetchMock = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        agent: {
          config: nextAgent,
        },
      }), { status: 200 });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentModelOverride("builder", {
        model: "openai/gpt-5.5",
        variant: "high",
      });

      expect(fetchCalls).toBe(1);
      expect(useAgentsStore.getState().agents[0]).toEqual({
        ...nextAgent,
        modelRefs: ["openai/gpt-5.5"],
      });
      expect(useConfigStore.getState().agents[0]).toEqual({
        ...nextAgent,
        modelRefs: ["openai/gpt-5.5"],
      });
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalSettingsAgents });
      useConfigStore.setState({ agents: originalAgents, directoryScoped: {} });
    }
  });

  test("clears stale session selections and reapplies the current agent model after saving an override", async () => {
    const originalConfigState = useConfigStore.getState();
    const originalSettingsAgents = useAgentsStore.getState().agents;
    const originalSelectionState = useSelectionStore.getState();
    const nextAgent = makeAgent({
      name: "builder",
      mode: "primary",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      variant: "high",
    });

    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionPlanModeSelections: new Map(),
      defaultPlanModeSelection: false,
      draftPlanModeSelection: false,
      sessionAgentModelSelections: new Map([
        ["session-1", new Map([["builder", { providerId: "anthropic", modelId: "claude-sonnet-4-5" }]])],
      ]),
      lastUsedProvider: null,
    });
    useAgentsStore.setState({
      agents: [makeAgent({ name: "builder", mode: "primary", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, variant: "low" })],
    });
    useConfigStore.setState({
      activeDirectoryKey: "__global__",
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          options: {},
          env: [],
          models: [{ id: "gpt-5.5", name: "gpt-5.5", providerID: "openai", variants: { high: {} } }],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          source: "custom",
          options: {},
          env: [],
          models: [{ id: "claude-sonnet-4-5", name: "claude-sonnet-4-5", providerID: "anthropic", variants: { low: {} } }],
        },
      ] as never,
      agents: [makeAgent({ name: "builder", mode: "primary", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, variant: "low" })],
      currentAgentName: "builder",
      currentProviderId: "anthropic",
      currentModelId: "claude-sonnet-4-5",
      currentVariant: "low",
      selectedProviderId: "anthropic",
      directoryScoped: {},
    });

    const fetchMock = async () => new Response(JSON.stringify({
      success: true,
      agent: {
        config: nextAgent,
      },
    }), { status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await useAgentsStore.getState().saveAgentModelOverride("builder", {
        model: "openai/gpt-5.5",
        variant: "high",
      });

      expect(useSelectionStore.getState().getAgentModelForSession("session-1", "builder")).toBe(null);
      expect(useConfigStore.getState().currentProviderId).toBe("openai");
      expect(useConfigStore.getState().currentModelId).toBe("gpt-5.5");
      expect(useConfigStore.getState().currentVariant).toBe("high");
    } finally {
      globalThis.fetch = originalFetch;
      useAgentsStore.setState({ agents: originalSettingsAgents });
      useConfigStore.setState(originalConfigState);
      useSelectionStore.setState(originalSelectionState);
    }
  });
});

describe("buildSettingsAgentCatalog", () => {
  test("uses config-backed packaged and project agents as the settings catalog", () => {
    const catalog = buildSettingsAgentCatalog([
      makeAgent({ name: "orchestrator", mode: "primary", description: "Packaged orchestrator" }),
    ], []);

    expect(catalog.map((agent) => agent.name)).toEqual(["orchestrator"]);
  });

  test("does not include runtime-only agents in settings", () => {
    const catalog = buildSettingsAgentCatalog(
      [makeAgent({ name: "orchestrator", mode: "primary", description: "Project override" })],
      [
        makeAgent({ name: "orchestrator", mode: "primary", description: "Packaged orchestrator" }),
        makeAgent({ name: "builder", mode: "primary", description: "Packaged builder" }),
      ],
    );

    expect(catalog.map((agent) => agent.name)).toEqual(["orchestrator"]);
    expect(catalog.find((agent) => agent.name === "orchestrator")?.description).toBe("Project override");
  });
});
