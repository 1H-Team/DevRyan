import {helperPluginContext} from './native-helper-context.js';
import { SdkPlugins } from '@opencode/core/plugin/sdk';
import { Location } from '@opencode/core/location';
import type { Plugin } from '@opencode/plugin/effect/plugin';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { Effect, Layer } from 'effect';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { RegistrationOriginRef, provideRegistrationOrigin, type RegistrationOrigin } from './registration-origin.js';

export interface ReviewedPlugin { readonly plugin: Plugin; readonly origin: RegistrationOrigin }

/** SDK registrations are an embedder capability; IDs alone confer no authority. */
export function trustedPluginOverride(options: {
  readonly plugins: readonly ReviewedPlugin[];
  readonly additionalOrigins: readonly RegistrationOrigin[];
  readonly nativePlugins: ReadonlyMap<string, RegistrationOrigin>;
}): LayerNode.Replacement {
  const origins = new Map<string, RegistrationOrigin>();
  for (const origin of [...options.plugins.map((entry) => entry.origin), ...options.additionalOrigins]) {
    if (origin.kind !== 'plugin' || !/^[a-f0-9]{64}$/.test(origin.manifestDigest)
      || !origin.id || options.nativePlugins.has(origin.id) || origins.has(origin.id)) {
      throw new Error('Invalid or duplicate reviewed native plugin origin');
    }
    origins.set(origin.id, Object.freeze({ ...origin, capabilities: Object.freeze([...origin.capabilities]) }));
  }
  for (const entry of options.plugins) {
    if (entry.plugin.id !== entry.origin.id) throw new Error('Reviewed plugin identity mismatch');
  }
  const sameOrigin = (left: RegistrationOrigin, right: RegistrationOrigin) => left.kind === right.kind
    && left.id === right.id && left.manifestDigest === right.manifestDigest
    && left.capabilities.length === right.capabilities.length
    && left.capabilities.every((capability) => right.capabilities.includes(capability));
  const decorated = SdkPlugins.node.mapLayer((layer) => Layer.effect(SdkPlugins.Service, Effect.gen(function* () {
    const inner = yield* SdkPlugins.Service;
    const service: SdkPlugins.Interface = {
      all: () => inner.all(),
      register: (plugin) => Effect.gen(function* () {
        const origin = yield* RegistrationOriginRef;
        const reviewed = origins.get(plugin.id);
        if (!origin || !reviewed || !sameOrigin(origin, reviewed)) {
          return yield* refuseHost(new HostRefusal('unreviewed_plugin', 403, 'plugin.register'));
        }
        yield* inner.register({ id: plugin.id, effect: (context) => {
          // Native SDK activation clears services, but its host already owns
          // this exact location. Capture it before reviewed registration runs.
          const location = Object.freeze({ ...context.location,
            project: Object.freeze({ ...context.location.project }) });
          return provideRegistrationOrigin(reviewed, plugin.effect(helperPluginContext(context)))
            .pipe(Effect.provideService(Location.Service, location));
        } });
      }),
    };
    for (const entry of options.plugins) {
      yield* provideRegistrationOrigin(entry.origin, service.register(entry.plugin));
    }
    return service;
  })).pipe(Layer.provide(layer)));
  return SdkPlugins.node.replace(decorated);
}
