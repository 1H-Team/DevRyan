import type {SessionContext} from '@opencode/plugin/effect/session';
import type {Plugin} from '@opencode/plugin/effect/plugin';
import {Effect} from 'effect';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';

/** Pure data operation; its caller must be the admitted native context hook. */
export function appendNativeConfiguredInstructions(snapshot:NativeConfigurationSnapshot,directory:string,system:SessionContext['system']):void {
  const location=snapshot.locations.find(value=>value.directory===directory);
  if(!location)throw new Error('native_instruction_location_unreviewed');
  for(const instruction of location.instructions)system.push({type:'text',text:instruction.content});
}

/** Constructor-frozen instruction data; hook admission remains the mandatory host gate. */
export function nativeConfiguredInstructionsPlugin(snapshot:NativeConfigurationSnapshot):Plugin {
  return {id:'devryan.configured-instructions',effect:context=>Effect.gen(function*(){
    const location=snapshot.locations.find(value=>value.directory===context.location.directory);
    if(!location)return yield* Effect.die(new Error('native_instruction_location_unreviewed'));
    yield* context.session.hook('context',event=>Effect.sync(()=>{
      // Keep separate exact blocks and render order. Recompute from this
      // invocation's base system; never append into persistent shared state.
      appendNativeConfiguredInstructions(snapshot,context.location.directory,event.system);
    }));
  })};
}
