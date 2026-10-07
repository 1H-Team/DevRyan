import { Context, Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { httpClient } from '@opencode/util/effect/app-node-platform';
import { makeGlobalNode } from '@opencode/util/effect/app-node';
import { SdkPlugins } from '@opencode/core/plugin/sdk';
import { SimulationNetwork } from '@opencode/simulation/backend/network';
import { SimulationOpenAI } from '@opencode/simulation/backend/openai';
import { SimulatedProvider } from '@opencode/simulation/backend/simulated-provider';
import { provideRegistrationOrigin, type RegistrationOrigin } from '../../packages/web/server/lib/opencode/runtime-host/registration-origin.ts';

// Construction registers the simulation backend's plugin. Provenance must be
// present during layer build, rather than inferred later from that plugin's ID.
export const makeNativeSimulation = (endpoint: string, origin: RegistrationOrigin) => {
  if (origin.kind !== 'plugin' || origin.id !== 'opencode.simulation.tools'
    || !origin.capabilities.includes('provider')) throw new Error('Reviewed simulation origin required');
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw new Error('Simulation endpoint must be loopback');
  const providerLayer = Layer.effect(SimulatedProvider.Service,
    provideRegistrationOrigin(origin, Effect.gen(function* () {
      const context = yield* Layer.build(SimulatedProvider.layerDrive({ endpoint, version: '2.0.24' }));
      return Context.get(context, SimulatedProvider.Service);
    })));
  const networkLayer = Layer.effect(HttpClient.HttpClient, Effect.gen(function* () {
    const provider = yield* SimulatedProvider.Service;
    const network = yield* SimulationNetwork.make([
      SimulationOpenAI.route(provider),
      SimulationNetwork.json('GET', 'https://models.opencode.ai/api.json', {}),
    ]);
    return network.client;
  })).pipe(Layer.provide(providerLayer), Layer.orDie);
  const node = makeGlobalNode({ service: HttpClient.HttpClient, layer: networkLayer, deps: [SdkPlugins.node] });
  return { endpoint, overrides: [httpClient.replace(node)] };
};
