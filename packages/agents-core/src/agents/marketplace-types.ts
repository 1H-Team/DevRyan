// DevRyan: the Slim marketplace is not part of DevRyan, so no package agent is
// ever activated. The agent registry still reads these shapes on its
// (never-populated) package paths; they are kept here, type-checked, without
// the marketplace store, registry client or activation planner.
import { createHash } from 'node:crypto';

export const MARKETPLACE_TOOL_NAMES = [
  'read',
  'glob',
  'grep',
  'ast_grep_search',
  'edit',
  'write',
  'apply_patch',
  'ast_grep_replace',
  'bash',
  'webfetch',
  'websearch',
] as const;

export interface MarketplaceAgentMetadata {
  readonly packageId: string;
  readonly runtimeName: string;
  readonly capabilities: {
    readonly tools: readonly string[];
    readonly skills: readonly string[];
    readonly mcps: readonly string[];
  };
  readonly modelPolicy: { readonly source: string };
  readonly extension?: {
    readonly builtin: string;
    readonly promptMode: 'append' | 'replace';
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/** Upstream marketplace/config-identity: hash of a finalized package projection. */
export function marketplaceConfigFingerprint(input: {
  readonly id: string;
  readonly runtimeName: string;
  readonly identity: string | undefined;
  readonly canonicalConfig: unknown;
  readonly visibleConfig: unknown;
  readonly canonicalPolicy: unknown;
  readonly visiblePolicy: unknown;
  readonly canonicalModelCandidates: unknown;
  readonly visibleModelCandidates: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          id: input.id,
          runtimeName: input.runtimeName,
          identity: input.identity,
          canonicalConfig: input.canonicalConfig,
          visibleConfig: input.visibleConfig,
          canonicalPolicy: input.canonicalPolicy,
          visiblePolicy: input.visiblePolicy,
          canonicalModelCandidates: input.canonicalModelCandidates,
          visibleModelCandidates: input.visibleModelCandidates,
        }),
      ),
    )
    .digest('hex');
}
