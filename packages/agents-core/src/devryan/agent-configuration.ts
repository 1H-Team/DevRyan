// DevRyan: resolves the effective agents for one location from the host's
// frozen configuration and host agent map. This is the agent part of the
// upstream v1 plugin's `config` hook (index.ts) — registry finalization,
// default-agent selection and the managed agent merge — without its telemetry,
// fallback-chain, MCP-injection or command side effects. Host fields win over
// Slim's (mergeHostAgentConfigs), so DevRyan's prompts and permissions stay
// authoritative; Slim contributes model routing and the roles DevRyan lacks.
import path from 'node:path';
import { createAgents, getAgentConfigsFromDefinitions, isSubagent } from '../agents';
import { buildResolvedAgentRegistry, type RegistryHostSnapshot } from '../agents/registry';
import { loadPluginConfig } from '../config/loader';
import { RuntimeConfig } from '../config/runtime';
import { normalizeAgentName } from '../utils/agent-variant';
import { bindReviewedSlimConfiguration, type CapturedAgentPrompt, reviewedSlimAgentData } from './owners';

export interface ReviewedSlimAgentData {
  readonly directory: string;
  readonly configuration: Record<string, unknown>;
  readonly hostConfiguration: Record<string, unknown>;
  readonly prompts: Record<string, CapturedAgentPrompt>;
  readonly localSkills: readonly string[];
  readonly activePreset?: string;
}

export interface ReviewedSlimAgentResolution {
  readonly agents: Record<string, unknown>;
  readonly defaultAgent?: string;
  readonly runtimeChains: Readonly<Record<string, readonly string[]>>;
  readonly modelArrays: Readonly<Record<string, readonly { id: string; variant?: string }[]>>;
  readonly fallback: Readonly<Record<string, unknown>>;
  readonly backgroundJobs: Readonly<Record<string, unknown>>;
}

const HOST_FLAVOR = 'v2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveReviewedSlimAgents(input: ReviewedSlimAgentData): ReviewedSlimAgentResolution {
  if (
    !input ||
    typeof input.directory !== 'string' ||
    !path.isAbsolute(input.directory) ||
    !isRecord(input.configuration) ||
    !isRecord(input.hostConfiguration) ||
    !isRecord(input.prompts) ||
    !Array.isArray(input.localSkills) ||
    input.localSkills.some((name) => typeof name !== 'string')
  )
    throw new Error('reviewed_slim_agent_data_invalid');
  const captured = structuredClone(input);
  return reviewedSlimAgentData.run({ prompts: captured.prompts }, () => {
    // The saved configuration passes through the original loader pipeline
    // (schemas, v2 defaults, preset inheritance) under a temporary binding.
    const release = bindReviewedSlimConfiguration({
      directory: captured.directory,
      configuration: captured.configuration,
      ...(captured.activePreset ? { activePreset: captured.activePreset } : {}),
    });
    let pluginConfig: ReturnType<typeof loadPluginConfig>;
    try {
      pluginConfig = loadPluginConfig(captured.directory, { hostFlavor: HOST_FLAVOR, silent: true });
    } finally {
      release();
    }
    const runtime = RuntimeConfig.createDetached(captured.directory, pluginConfig, HOST_FLAVOR, {
      localSkillNames: captured.localSkills,
    });
    const hostSnapshot = structuredClone(captured.hostConfiguration) as RegistryHostSnapshot;
    runtime.captureHostConfig(hostSnapshot);
    const definitions = createAgents(runtime, { projectDirectory: captured.directory, hostFlavor: HOST_FLAVOR });
    const baseline = getAgentConfigsFromDefinitions(runtime, definitions);
    const registry = buildResolvedAgentRegistry(runtime, {
      hostSnapshot,
      definitions,
      projectDirectory: captured.directory,
      hostFlavor: HOST_FLAVOR,
      // DevRyan owns MCP: no Slim built-in servers are injected.
      pluginMcps: {},
      nativePermissionsByAgent: {},
      onHostModelSelected: (agentName) => runtime.everModelSwitched(agentName),
    });
    const opencodeConfig = structuredClone(captured.hostConfiguration) as Record<string, unknown> & {
      default_agent?: string;
      agent?: Record<string, unknown>;
    };
    if (runtime.setDefaultAgent) {
      const existing = opencodeConfig.default_agent;
      if (!existing || isSubagent(existing)) {
        const orchestrator = baseline.orchestrator as { displayName?: string; hidden?: boolean } | undefined;
        opencodeConfig.default_agent =
          orchestrator?.hidden && orchestrator.displayName
            ? normalizeAgentName(orchestrator.displayName)
            : 'orchestrator';
      }
    }
    opencodeConfig.agent = {
      ...(isRecord(opencodeConfig.agent) ? opencodeConfig.agent : {}),
      ...structuredClone(registry.managedAgentConfig),
    };
    return {
      agents: opencodeConfig.agent,
      runtimeChains: structuredClone(runtime.runtimeChains),
      modelArrays: structuredClone(runtime.modelArrays),
      fallback: structuredClone(runtime.fallback ?? {}),
      backgroundJobs: structuredClone(runtime.backgroundJobs ?? {}),
      ...(opencodeConfig.default_agent === undefined ? {} : { defaultAgent: opencodeConfig.default_agent }),
    };
  });
}
