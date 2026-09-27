import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "@opencode-ai/sdk/v2";
import {
  buildAgentConfigPayload,
  buildAgentModelOverridePayload,
  buildAgentRuntimeSettingsPayload,
  buildSettingsAgentCatalog,
  filterVisibleAgentSelectorOptions,
  filterVisibleSettingsAgents,
  normalizeAgentForSettings,
  normalizeAgentRuntimeSettings,
  useAgentsStore,
  type AgentRuntimeSettings,
} from "./useAgentsStore";
import { useConfigStore } from "./useConfigStore";
import { useSelectionStore } from "@/sync/selection-store";
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';

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
  let clientDirectory: string | undefined;
  let directoryState: ReturnType<typeof useDirectoryStore.getState>;
  let projectsState: ReturnType<typeof useProjectsStore.getState>;
  beforeEach(() => {
    clientDirectory = opencodeClient.getDirectory();
    directoryState = useDirectoryStore.getState();
    projectsState = useProjectsStore.getState();
    opencodeClient.setDirectory(undefined);
    useDirectoryStore.setState({ currentDirectory: '' });
    useProjectsStore.setState({ projects: [], activeProjectId: null });
  });
  afterEach(() => {
    opencodeClient.setDirectory(clientDirectory);
    useDirectoryStore.setState(directoryState);
    useProjectsStore.setState(projectsState);
  });

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
    const originalConfigState = useConfigStore.getState();
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
      activeDirectoryKey: '__global__',
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
      useConfigStore.setState(originalConfigState);
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
      draftPlanModeSelections: new Map(),
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

describe("agent runtime settings", () => {
  const known = (lsp: boolean, appliedLsp = true): AgentRuntimeSettings => ({
    lsp, appliesOnRestart: true, runtimeMode: 'managed', appliedLsp, restartRequired: lsp !== appliedLsp,
  });
  const unknown = (lsp: boolean): AgentRuntimeSettings => ({
    lsp, appliesOnRestart: true, runtimeMode: 'unknown', appliedLsp: null, restartRequired: null,
  });
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const restore = () => {
    globalThis.fetch = originalFetch;
    useAgentsStore.setState({ agentRuntimeSettings: null, isSavingAgentRuntimeSettings: false });
  };
  const deferredResponse = () => {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    return { promise, resolve };
  };

  test("loads authoritative restart state, including after renderer state is discarded", async () => {
    let requested: { url: string; method: string | undefined } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = { url: String(input), method: init?.method };
      return jsonResponse(known(false));
    }) as typeof fetch;
    try {
      const settings = await useAgentsStore.getState().getAgentRuntimeSettings();
      expect(requested).toEqual({ url: "/api/config/agent-runtime", method: "GET" });
      expect(settings).toEqual(known(false));
      useAgentsStore.setState({ agentRuntimeSettings: null });
      await useAgentsStore.getState().getAgentRuntimeSettings();
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(false));
    } finally { restore(); }
  });

  test("reads missing routes as unsupported and preserves errors without storing them", async () => {
    try {
      for (const status of [404, 501]) {
        useAgentsStore.setState({ agentRuntimeSettings: known(true) });
        globalThis.fetch = (async () => jsonResponse({ error: "Not here" }, status)) as typeof fetch;
        await expect(useAgentsStore.getState().getAgentRuntimeSettings()).resolves.toBeNull();
        expect(useAgentsStore.getState().agentRuntimeSettings).toBeNull();
      }
      for (const [body, status, message] of [
        [{ lsp: "yes" }, 200, "Failed to load agent runtime settings"],
        [{ error: "Agent runtime settings are not available for this user" }, 403, "not available for this user"],
      ] as const) {
        globalThis.fetch = (async () => jsonResponse(body, status)) as typeof fetch;
        await expect(useAgentsStore.getState().getAgentRuntimeSettings()).rejects.toThrow(message);
        expect(useAgentsStore.getState().agentRuntimeSettings).toBeNull();
      }
    } finally { restore(); }
  });

  test("keeps confirmed values while saving, and accepts server reconciliation on repeated saves and revert", async () => {
    useAgentsStore.setState({ agentRuntimeSettings: known(true) });
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(useAgentsStore.getState().isSavingAgentRuntimeSettings).toBe(true);
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return jsonResponse(known(body.lsp));
    }) as typeof fetch;
    try {
      const saving = useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: false });
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(true));
      expect(await saving).toEqual(known(false));
      expect(await useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: false })).toEqual(known(false));
      expect(await useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: true })).toEqual(known(true));
      expect(bodies).toEqual([{ lsp: false }, { lsp: false }, { lsp: true }]);
      expect(useAgentsStore.getState().isSavingAgentRuntimeSettings).toBe(false);
    } finally { restore(); }
  });

  test("serializes queued writes and a failed first write cannot roll back the second", async () => {
    useAgentsStore.setState({ agentRuntimeSettings: known(false) });
    const firstResponse = deferredResponse();
    const started: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      started.push(JSON.parse(String(init?.body)));
      return started.length === 1 ? firstResponse.promise : jsonResponse(known(true));
    }) as typeof fetch;
    try {
      const first = useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: false }).catch((error: unknown) => error);
      const second = useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: true });
      await Promise.resolve();
      expect(started).toEqual([{ lsp: false }]);
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(false));
      firstResponse.resolve(jsonResponse({ error: "Write rejected" }, 500));
      expect(await first).toBeInstanceOf(Error);
      expect(await second).toEqual(known(true));
      expect(started).toEqual([{ lsp: false }, { lsp: true }]);
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(true));
      expect(useAgentsStore.getState().isSavingAgentRuntimeSettings).toBe(false);
    } finally { restore(); }
  });

  test("a delayed GET cannot replace a newer saved response", async () => {
    const response = deferredResponse();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "GET" ? response.promise : jsonResponse(known(false))
    )) as typeof fetch;
    try {
      const load = useAgentsStore.getState().getAgentRuntimeSettings();
      await Promise.resolve();
      await useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: false });
      response.resolve(jsonResponse(known(true)));
      await load;
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(false));
    } finally { restore(); }
  });

  test("a malformed successful PUT cannot replace confirmed settings", async () => {
    useAgentsStore.setState({ agentRuntimeSettings: known(false) });
    globalThis.fetch = (async () => jsonResponse({ lsp: "yes" })) as typeof fetch;
    try {
      await expect(useAgentsStore.getState().saveAgentRuntimeSettings({ lsp: true }))
        .rejects.toThrow("Failed to save agent runtime settings");
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(false));
    } finally { restore(); }
  });

  test("an older load cannot replace the latest status refresh", async () => {
    const firstResponse = deferredResponse();
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1 ? firstResponse.promise : jsonResponse(known(false, false))) as typeof fetch;
    try {
      const oldLoad = useAgentsStore.getState().getAgentRuntimeSettings();
      await Promise.resolve();
      await useAgentsStore.getState().getAgentRuntimeSettings();
      firstResponse.resolve(jsonResponse(known(false)));
      await oldLoad;
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(known(false, false));
    } finally { restore(); }
  });

  test("validates writes locally and represents unsupported application knowledge honestly", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as typeof fetch;
    try {
      await expect(useAgentsStore.getState().saveAgentRuntimeSettings({})).rejects.toThrow("Nothing to save");
      expect(calls).toBe(0);
      expect(buildAgentRuntimeSettingsPayload({ lsp: false })).toEqual({ lsp: false });
      expect(normalizeAgentRuntimeSettings({ lsp: true })).toEqual(unknown(true));
      expect(normalizeAgentRuntimeSettings({ ...known(false), runtimeMode: 'external' }))
        .toEqual({ ...unknown(false), runtimeMode: 'external' });
      expect(normalizeAgentRuntimeSettings({ lsp: 1 })).toBeNull();
      expect(normalizeAgentRuntimeSettings(null)).toBeNull();
    } finally { restore(); }
  });
});
