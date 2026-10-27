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

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const applyCapturedSampling=(location:NativeConfigurationSnapshot['locations'][number],event:{readonly agent:string;readonly model:{readonly providerID:string;readonly id:string};options:Record<string,unknown>})=>{
 const providers=location.configuration.providers,provider=record(providers)?providers[event.model.providerID]:undefined;
 // This physical generation contract is qualified for native compatible chat.
 // A missing capability flag never guesses support for other providers/GPT.
 if(!record(provider)||provider.package!=='@opencode/ai/providers/openai-compatible')return;
 const legacyProviders=location.compatibility.legacy.provider??location.compatibility.legacy.providers,legacyProvider=record(legacyProviders)?legacyProviders[event.model.providerID]:undefined;
 const legacyModels=record(legacyProvider)?legacyProvider.models:undefined,legacyModel=record(legacyModels)?legacyModels[event.model.id]:undefined;
 if(record(legacyModel)&&legacyModel.temperature!==undefined&&legacyModel.temperature!==true)return;
 const agents=location.configuration.agents,agent=record(agents)?agents[event.agent]:undefined;
 const request=record(agent)?agent.request:undefined,body=record(request)?request.body:undefined;
 if(!record(body))return;
 for(const [source,target,max] of [['temperature','temperature',2],['top_p','topP',1]] as const){
  const value=body[source];if(value===undefined)continue;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)throw new Error('native_configured_sampling_invalid');
  // Captured defaults do not replace a preceding native hook's explicit choice.
  if(event.options[target]===undefined)event.options[target]=value;
 }
};

/** Constructor-frozen instruction data; hook admission remains the mandatory host gate. */
export function nativeConfiguredInstructionsPlugin(snapshot:NativeConfigurationSnapshot):Plugin {
  const frozen=structuredClone(snapshot);
  return {id:'devryan.configured-instructions',effect:context=>Effect.gen(function*(){
    const location=frozen.locations.find(value=>value.directory===context.location.directory);
    if(!location)return yield* Effect.die(new Error('native_instruction_location_unreviewed'));
    yield* context.session.hook('context',event=>Effect.sync(()=>{
      // Keep separate exact blocks and render order. Recompute from this
      // invocation's base system; never append into persistent shared state.
      appendNativeConfiguredInstructions(frozen,context.location.directory,event.system);
      applyCapturedSampling(location,event);
    }));
    yield* context.session.hook('generate',event=>Effect.sync(()=>applyCapturedSampling(location,event)));
  })};
}
