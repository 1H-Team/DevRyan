import { expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Command } from '@opencode/core/command';
import { Config } from '@opencode/core/config';
import { Config as ConfigSchema } from '@opencode/schema/config';
import { SessionSchema } from '@opencode/core/session/schema';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Global } from '@opencode/util/global';
import path from 'node:path';
import { createCommandDerivation } from '../../packages/web/server/lib/opencode/runtime-host/command-derivation.js';
import { provideRegistrationOrigin } from '../../packages/web/server/lib/opencode/runtime-host/registration-origin.js';
import { OperationPermitRef, type NativeAdmissionBridge } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { HostRefusal, runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';

// Real native Command state/transform/dispatch; the private bridge is the
// boundary under test, not a substitute native command implementation.
test('only a sealed configured executor receives derivation and its inner hooks see no marker', async () => {
  const token = 'c'.repeat(64), sessionID = SessionSchema.ID.make('ses_command');
  const requests: unknown[] = [];
  const bridge: NativeAdmissionBridge = {
    beginCommand: async input => { requests.push(input); return token; },
    awaitReady: async () => {}, authorize: async () => ({ token: 'a'.repeat(64), revision: 0 }),
    recheck: async () => {}, release: async () => {}, sealPrompt: async () => ({}), verifyAccepted: async () => {},
    registerShellJob: async () => {}, sealSynthetic: async () => ({}), deferContinuation: async () => {},
    hold: async () => {}, releaseHold: async () => {}, isHeld: async () => false,
  };
  const behaviorOrigin={kind:'plugin',id:'devryan.slim-commands',manifestDigest:'d'.repeat(64),capabilities:['control']} as const;
  const declaration={template:'Original behavior',description:'Exact description'};
  let beforeCommands=0;
  const derivation = createCommandDerivation({ bridge, checked: action => Effect.promise(action),beforeConfiguredCommand:input=>Effect.gen(function*(){
    expect(input).toEqual({directory:'/fixture/commands',name:'reviewed',invocation});expect(yield* derivation.requestMarker()).toBe(token);beforeCommands++;
  }),reviewedConfigurationForDirectory:directory=>directory==='/fixture/commands'?document.info:undefined,reviewedBehaviorCommands:
    ['deepwork','foreign','forged-description','override'].map(name=>({origin:behaviorOrigin,name,definition:declaration})) });
  const root = path.resolve('.cache/v2-validation/native-command-lock');
  const layer = LayerNode.compile(Command.node, { replacements: [
    Global.node.replace(Global.layerWith({ home: root, data: root, cache: root, config: root, state: root, tmp: root, bin: root, log: root, repos: root })),
    Command.node.replace(Command.node.mapLayer(inner => Layer.effect(Command.Service,
      Effect.map(Command.Service, inner=>derivation.decorate(inner,'/fixture/commands'))).pipe(Layer.provide(inner)))),
  ] });
  const nativeOrigin = { kind: 'native', id: 'opencode.config.command', manifestDigest: 'b'.repeat(64), capabilities: ['control'] } as const;
  const document = new ConfigSchema.Document({ type: 'document', info: new ConfigSchema.Info({ commands: {
    reviewed: { template: 'Reviewed $ARGUMENTS' }, forged: { template: 'Forged' },
    override:{template:'Saved custom command'},
  } }) });
  const config: Config.Interface = { entries: () => Effect.succeed([document]), compatibility: () => Effect.succeed({ agents: [], claude: [] }),
    changes: () => { throw new Error('unused config changes'); } };
  const invocation = { sessionID, prompt: { text: 'original' }, delivery: 'steer' } as const;
  let executed = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const commands = yield* Command.Service;
    yield* provideRegistrationOrigin(nativeOrigin, commands.transform(editor => editor.add({ name: 'reviewed', execute: () => Effect.gen(function* () {
      expect(yield* derivation.requestMarker()).toBe(token);
      // Same clearing used by production Session.prompt/switch* before calling
      // native services and their plugin hooks. A nested call has no marker.
      yield* derivation.clear(Effect.gen(function* () { expect(yield* derivation.requestMarker()).toBeUndefined(); }));
      expect(yield* derivation.requestMarker()).toBe(token); executed++;
    }) }))).pipe(Effect.provideService(Config.Service, config));
    yield* commands.transform(editor => editor.add({ name: 'forged', execute: () => Effect.sync(() => { executed++; }) }))
      .pipe(Effect.provideService(Config.Service, config));
    yield* commands.execute({ name: 'reviewed', invocation }).pipe(Effect.provideService(OperationPermitRef, { token: 'a'.repeat(64), revision: 0, sessionID }));
    expect(executed).toBe(1); expect(requests).toHaveLength(1);expect(beforeCommands).toBe(1);
    const denied = yield* Effect.promise(() => runWithHostRefusal(() => Effect.runPromise(commands.execute({ name: 'forged', invocation }))));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('Unsealed executor ran');
    expect(denied.refusal).toBeInstanceOf(HostRefusal); expect(denied.refusal.code).toBe('native_command_definition_unreviewed');
    expect(executed).toBe(1); expect(requests).toHaveLength(1);
    expect(yield* derivation.requestMarker()).toBeUndefined();
    for(const name of ['deepwork','foreign','forged-description','override']){
      const origin=name==='foreign'?{...behaviorOrigin,manifestDigest:'e'.repeat(64)}:behaviorOrigin;
      const registration=provideRegistrationOrigin(origin,commands.transform(editor=>editor.add({name,description:name==='forged-description'?'Forged':'Exact description',execute:()=>Effect.gen(function*(){expect(yield* derivation.requestMarker()).toBe(token);executed++;})})));
      // A plugin-provided empty Config cannot hide the saved custom override.
      yield* name==='override' ? registration.pipe(Effect.provideService(Config.Service,{...config,entries:()=>Effect.succeed([])})) : registration;
    }
    yield* commands.execute({name:'deepwork',invocation}).pipe(Effect.provideService(OperationPermitRef,{token:'a'.repeat(64),revision:0,sessionID}));
    expect(executed).toBe(2);expect(requests).toHaveLength(2);expect(beforeCommands).toBe(1);
    for(const name of ['foreign','forged-description','override']){
      const refused=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(commands.execute({name,invocation}).pipe(Effect.provideService(OperationPermitRef,{token:'a'.repeat(64),revision:0,sessionID})))));
      expect(refused.ok).toBe(false);if(refused.ok)throw new Error('Unreviewed behavior executed');
      expect(refused.refusal.code).toBe('native_command_definition_unreviewed');
    }
    expect(executed).toBe(2);expect(requests).toHaveLength(2);
  }).pipe(Effect.provide(layer))));
});
