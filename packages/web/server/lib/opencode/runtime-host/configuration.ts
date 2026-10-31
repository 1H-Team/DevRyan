import { Config } from '@opencode/core/config';
import { Location } from '@opencode/core/location';
import { ConfigPluginSource } from '@opencode/core/config/plugin/source';
import { InstructionDiscovery } from '@opencode/core/instruction-discovery';
import { InstructionBuiltIns } from '@opencode/core/instructions/builtins';
import type { Instructions } from '@opencode/core/instructions/index';
import { Config as ConfigSchema } from '@opencode/schema/config';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { makeLocationNode } from '@opencode/util/effect/app-node';
import { Effect, Layer, Schema, Stream } from 'effect';
import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import { decodeNativeConfigurationSnapshot } from './native-configuration.js';

// OpenCode's environment instruction tells the model to prefer global.tmp,
// which DevRyan protects; following it made every file-tool write there fail.
const GLOBAL_TMP_ADVICE = /^[ \t]*Prefer .* over generic system temporary directories[^\n]*$/m;
export const DEVRYAN_SCRATCH_ADVICE = '  Scratch files: use the shell\'s $DEVRYAN_SESSION_TMP (kept for the session) or $TMPDIR (per call). Both are shell-only; file tools read and write only inside the workspace.';
export const rewriteEnvironmentInstructions = (sources: Instructions.List): Instructions.List => sources.map(source => String(source.key) !== 'core/environment' ? source
  : { ...source, read: source.read.pipe(Effect.map(value => typeof value === 'string' ? value.replace(GLOBAL_TMP_ADVICE, DEVRYAN_SCRATCH_ADVICE) : value)) });
const environmentInstructions = InstructionBuiltIns.node.replace(InstructionBuiltIns.node.mapLayer(layer => Layer.effect(InstructionBuiltIns.Service,
  Effect.gen(function* () {
    const inner = yield* InstructionBuiltIns.Service;
    return InstructionBuiltIns.Service.of({ load: () => inner.load().pipe(Effect.map(rewriteEnvironmentInstructions)) });
  })).pipe(Layer.provide(layer))));

/** Configuration is an explicit document, never a search of HOME or ancestors. */
export function configurationOverrides(input: unknown): LayerNode.Replacements {
  const info = Schema.decodeUnknownSync(ConfigSchema.Info)(input, { onExcessProperty: 'error' });
  if (info.plugins?.length) throw new Error('Native plugins require reviewed programmatic registration');
  // Native skill discovery follows symlinks and accepts URLs. Reviewed assets
  // must be supplied by the host's registrations, never reopened by config.
  if (info.instructions?.length || info.skills?.length || Object.keys(info.references ?? {}).length) {
    throw new Error('Native context resources require reviewed host registration');
  }
  if (Object.keys(info.mcp?.servers ?? {}).length) throw new Error('Native MCP requires an owned host adapter');
  if (info.snapshots === true) throw new Error('DevRyan owns file snapshots');
  if (info.warming !== undefined && info.warming !== false) throw new Error('Native warming is not qualified');
  const document = new ConfigSchema.Document({ type: 'document', info: new ConfigSchema.Info({
    ...info, snapshots: false, warming: false, update: 'disable', share: 'disabled', plugins: [],
  }) });
  const service: Config.Interface = {
    entries: () => Effect.succeed([document]),
    compatibility: () => Effect.succeed({ claude: [], agents: [] }),
    changes: () => Stream.empty,
  };
  return [
    Config.node.replace(Layer.succeed(Config.Service, service)),
    ConfigPluginSource.node.replace(ConfigPluginSource.empty),
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
    environmentInstructions,
  ];
}

/** Recomposition freezes one settings revision; each native location sees only its document. */
export function configurationOverridesForSnapshot(snapshot: NativeConfigurationSnapshot): LayerNode.Replacements {
  const locations = decodeNativeConfigurationSnapshot(snapshot);
  for (const location of locations) {
    const info = location.configuration;
    if (info.plugins?.length || info.instructions?.length || info.skills?.length || Object.keys(info.references ?? {}).length
      || Object.keys(info.mcp?.servers ?? {}).length || info.snapshots === true || info.warming !== undefined && info.warming !== false) {
      throw new Error('Snapshot discovery requires its reviewed native owner');
    }
  }
  const service = Layer.effect(Config.Service, Effect.gen(function* () {
    const location = yield* Location.Service;
    const selected = locations.find(value => value.directory === location.directory);
    if (!selected) return yield* Effect.die(new Error('native_configuration_location_unreviewed'));
    const document = new ConfigSchema.Document({ type: 'document', info: selected.configuration });
    const configuration: Config.Interface = { entries: () => Effect.succeed([document]),
      compatibility: () => Effect.succeed({ claude: [], agents: [] }), changes: () => Stream.empty };
    return configuration;
  }));
  const provider = makeLocationNode({ service: Config.Service, layer: service, deps: [Location.node] });
  return [Config.node.replace(provider), ConfigPluginSource.node.replace(ConfigPluginSource.empty),
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })), environmentInstructions];
}
