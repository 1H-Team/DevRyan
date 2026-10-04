import type {CommandInvocation} from '@opencode/plugin/effect/command';
import type {Plugin} from '@opencode/plugin/effect/plugin';
import {Effect} from 'effect';
import type {ReviewedSlimCommandHook,ReviewedSlimCommandPart} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';

export interface NativeSlimCommandInput {readonly directory:string;readonly name:string;readonly invocation:CommandInvocation}
export interface NativeSlimCommandOptions {
 readonly snapshot:NativeConfigurationSnapshot;
 readonly factories:Readonly<Record<'deepwork'|'loop'|'reflect',()=>ReviewedSlimCommandHook>>;
 readonly interviewDeclaration?:{readonly description:string;readonly template:string};
 /** Host-owned canonical command admission, refreshed before actual submission. */
 readonly assertCommand:(input:NativeSlimCommandInput)=>Effect.Effect<void,unknown>;
 /** Existing accepted prompt/command owner preserves delivery and frozen selection. */
 readonly executeCommand:(input:NativeSlimCommandInput&{readonly parts:readonly ReviewedSlimCommandPart[]})=>Effect.Effect<void,unknown>;
}

/** Original registration data for the host's exact compiled-origin/name check. */
export function reviewedSlimCommandDeclarations(factories:NativeSlimCommandOptions['factories']):Readonly<Record<string,{readonly template:string;readonly description:string}>> {
 const declarations:Record<string,{readonly template:string;readonly description:string}>={};
 for(const name of ['deepwork','loop','reflect'] as const){
  const configuration:{command?:Record<string,unknown>}={};factories[name]().registerCommand(configuration);
  const value=configuration.command?.[name];
  if(!value||typeof value!=='object'||!('template' in value)||typeof value.template!=='string'||!('description' in value)||typeof value.description!=='string')throw new Error('native_slim_command_definition_invalid');
  declarations[name]=Object.freeze({template:value.template,description:value.description});
 }
 return Object.freeze(declarations);
}

/** Original package behavior factories; no public marker can acquire command authority. */
export function nativeSlimCommandBehaviorsPlugin(options:NativeSlimCommandOptions):Plugin {
 return {id:'devryan.slim-commands',effect:context=>Effect.gen(function*(){
  const location=options.snapshot.locations.find(value=>value.directory===context.location.directory);
  if(!location)return yield* Effect.die(new Error('native_slim_location_unreviewed'));
  if(location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes('devryan.slim'))return;
  yield* context.command.transform(editor=>{
   for(const name of ['deepwork','loop','reflect'] as const){
    // A saved custom command keeps its exact template and native Config owner.
    if(Object.hasOwn(location.compatibility.commands,name))continue;
    const hook=options.factories[name](),configuration:{command?:Record<string,unknown>}={};
    hook.registerCommand(configuration);
    const definition=configuration.command?.[name];
    if(!definition||typeof definition!=='object'||!('description' in definition)||typeof definition.description!=='string')throw new Error('native_slim_command_definition_invalid');
    editor.add({name,description:definition.description,execute:invocation=>Effect.gen(function*(){
     const input={directory:context.location.directory,name,invocation};
     yield* options.assertCommand(input);
     const output:{parts:ReviewedSlimCommandPart[]}={parts:[]};
     yield* Effect.tryPromise({try:()=>hook.handleCommandExecuteBefore({command:name,sessionID:invocation.sessionID,arguments:invocation.prompt.text},output),catch:error=>error});
     yield* options.assertCommand(input);
     yield* options.executeCommand({...input,parts:output.parts});
    })});
   }
   if(options.interviewDeclaration&&!Object.hasOwn(location.compatibility.commands,'interview')){
    const declaration=options.interviewDeclaration;
    editor.add({name:'interview',description:declaration.description,execute:invocation=>Effect.gen(function*(){
     const input={directory:context.location.directory,name:'interview',invocation};
     yield* options.assertCommand(input);
     // Original marker becomes data only; later context requires durable accepted
     // command provenance before invoking the original interview state machine.
     const text=declaration.template.replace('$ARGUMENTS',()=>invocation.prompt.text);
     yield* options.executeCommand({...input,parts:[{type:'text',text}]});
    })});
   }
  });
 })};
}
