import {NativeHelperContextRef} from './native-helper-context.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Cause,Context,Effect,Exit,Layer,Option,Scope,Schema} from 'effect';
import {LLM,LLMClient,Message,type LLMClientShape} from '@opencode/ai';
import {llmClient} from '@opencode/core/effect/app-node-platform';
import {Location} from '@opencode/core/location';
import {Database} from '@opencode/core/database/database';
import {ModelResolver} from '@opencode/core/model-resolver';
import {Agent} from '@opencode/core/agent';
import {OperationPermitRef,type OperationPermit} from './native-admission-contract.js';
import {nativeHelperInput,type NativeHelperInput} from './native-helper-contract.js';
import {SessionContext} from '@opencode/core/session/context';
import {SessionHistory} from '@opencode/core/session/history';
import {SessionProviderContext} from '@opencode/core/session/provider-context';
import {SessionModelRequest} from '@opencode/core/session/model-request';
import {SessionSchema} from '@opencode/core/session/schema';
import {Model} from '@opencode/schema/model';
import {Provider} from '@opencode/schema/provider';
import type {OwnedToolInvocation} from './native-admission-contract.js';
import type {OwnedSlimWebfetchOwners} from './native-slim-webfetch.js';
import type {ReviewedWebfetchOwners,ReviewedWebfetchContext,ReviewedWebfetchCache} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import {nativeWebfetchBinaryDirectory} from './native-read-paths.js';
import jsdom from '../../../../runtime/reviewed-inputs/jsdom-30.1.1/node_modules/jsdom/lib/api.js';

export type ControllerWebfetchSecondary=Parameters<ReviewedWebfetchOwners['secondary']>[0];
export interface ControllerWebfetchOriginals {
 readonly createReviewedWebfetchCache:()=>ReviewedWebfetchCache;
 readonly saveReviewedWebfetchBinary:(directory:string,data:Uint8Array,contentType:string,filename?:string)=>Promise<string>;
}
export interface ControllerWebfetchOptions {
 readonly tmpDirectory:string;
 readonly originals:ControllerWebfetchOriginals;
 /** Opens the private generate permit before model/context/hook IO, and owns
  * actual provider settlement through interruption. */
 readonly withSecondary:(invocation:OwnedToolInvocation,request:ControllerWebfetchSecondary,execute:Effect.Effect<string,unknown>)=>Effect.Effect<string,unknown>;
 readonly fetch?:ReviewedWebfetchOwners['fetch'];
}
const locationKey=(location:Readonly<Location.Info>)=>JSON.stringify([location.directory,location.workspaceID??null,location.project.id]);
const refuse=(code:string)=>new Error(code);

/** Captures the actual location graph; each capture expires with its Scope. */
export function createControllerWebfetch(options:ControllerWebfetchOptions){
 const tmp=options.tmpDirectory;
 if(!path.isAbsolute(tmp)||path.resolve(tmp)!==tmp||tmp.includes('\0'))throw refuse('native_webfetch_tmp_invalid');
 let nativeLLM:{readonly value:LLMClientShape;active:boolean}|undefined;
 const entries=new Map<string,{readonly context:Context.Context<never>;readonly selection:SessionContext.Interface;readonly database:Database.Interface;readonly location:Location.Interface;readonly agents:Agent.Interface;readonly models:ModelResolver.Interface;active:boolean}>();
 const binaryDirectory=(directory:string)=>nativeWebfetchBinaryDirectory(tmp,directory);
 const overrides=[
  llmClient.replace(llmClient.mapLayer(layer=>Layer.effect(LLMClient.Service,Effect.gen(function*(){
   const value=yield* LLMClient.Service;
   if(nativeLLM?.active)return yield* Effect.die(refuse('native_webfetch_llm_duplicate'));
   const captured={value,active:true};nativeLLM=captured;
   yield* Effect.addFinalizer(()=>Effect.sync(()=>{captured.active=false;if(nativeLLM===captured)nativeLLM=undefined;}));
   return value;
  })).pipe(Layer.provide(layer)))),
  SessionContext.node.replace(SessionContext.node.mapLayer(layer=>Layer.fromBuild((memo,scope)=>Effect.gen(function*(){
   // Capture dependencies before Layer.provide narrows the context to only the
   // service output; build in the original memo map and location scope.
   const input=yield* Effect.context();
   const output=yield* Layer.buildWithMemoMap(layer,memo,scope);
   const context=Context.merge(input,output),selection=Context.get(output,SessionContext.Service);
   const location=Option.getOrUndefined(Context.getOption(context,Location.Service)),database=Option.getOrUndefined(Context.getOption(context,Database.Service));
   const agents=Option.getOrUndefined(Context.getOption(context,Agent.Service)),models=Option.getOrUndefined(Context.getOption(context,ModelResolver.Service));
   if(!location||!database||!agents||!models)return yield* Effect.die(refuse('native_webfetch_location_services_missing'));
   const key=locationKey(location),entry={context,selection,database,location,agents,models,active:true};
   if(entries.has(key))return yield* Effect.die(refuse('native_webfetch_location_duplicate'));
   entries.set(key,entry);
   yield* Effect.addFinalizer(()=>Effect.sync(()=>{entry.active=false;if(entries.get(key)===entry)entries.delete(key);})).pipe(Scope.provide(scope));
   return output;
  }))))
 ];
 const ownersFor=async(invocation:OwnedToolInvocation,toolContext:ReviewedWebfetchContext):Promise<OwnedSlimWebfetchOwners>=>{
  const key=locationKey(invocation.location),entry=entries.get(key),llm=nativeLLM;
  if(!entry?.active||!llm?.active||toolContext.sessionID!==invocation.nativeContext.sessionID||invocation.existingPermit.sessionID!==toolContext.sessionID)throw refuse('native_webfetch_location_expired');
  const check=async()=>{toolContext.abort.throwIfAborted();if(!entry.active||entries.get(key)!==entry||!llm.active||nativeLLM!==llm)throw refuse('native_webfetch_location_expired');await Effect.runPromiseWith(entry.context)(invocation.recheckPermit(),{signal:toolContext.abort});toolContext.abort.throwIfAborted();};
  const scratch=binaryDirectory(invocation.location.directory);
  return {cache:options.originals.createReviewedWebfetchCache(),assertCurrent:check,
   fetch:options.fetch??((url,init)=>fetch(url,init)),loadJSDOM:async()=>{await check();return jsdom;},
   saveBinary:async request=>{
    await check();await request.recheck();request.signal.throwIfAborted();
    if(request.directory!==scratch||request.data.byteLength>10*1024*1024||!request.contentType||request.contentType.length>256
     ||request.filename!==undefined&&(!request.filename||request.filename!==path.basename(request.filename)||/[\\/\0]/.test(request.filename)||['.','..'].includes(request.filename)||Buffer.byteLength(request.filename)>255))throw refuse('native_webfetch_binary_invalid');
    if(await fs.realpath(tmp)!==tmp)throw refuse('native_webfetch_tmp_changed');
    for(const directory of [path.dirname(scratch),scratch]){
     await fs.mkdir(directory,{recursive:false}).catch(error=>{if(error?.code!=='EEXIST')throw error;});
     const stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(directory)!==directory)throw refuse('native_webfetch_binary_symlink');
    }
    await check();const owned=await fs.mkdtemp(path.join(scratch,'owned-'));
    try{
     await request.recheck();request.signal.throwIfAborted();
     const saved=await options.originals.saveReviewedWebfetchBinary(owned,request.data,request.contentType,request.filename);
     if(path.dirname(saved)!==owned||!(await fs.lstat(saved)).isFile()||await fs.realpath(saved)!==saved)throw refuse('native_webfetch_binary_path_invalid');
     await request.recheck();await check();return saved;
    }catch(error){await fs.rm(owned,{recursive:true,force:true});throw error;}
   },
   secondary:async request=>{
    await check();request.signal.throwIfAborted();
    if(request.sessionID!==toolContext.sessionID||!request.model.providerID||!request.model.modelID||typeof request.prompt!=='string')throw refuse('native_webfetch_secondary_invalid');
    const frozen=Object.freeze({...request,model:Object.freeze({...request.model})});
    const execute=Effect.gen(function*(){
     yield* Effect.promise(check);
     const selected=yield* entry.selection.select(SessionSchema.ID.make(frozen.sessionID));
     if(selected.session.location.directory!==invocation.location.directory||selected.session.location.workspaceID!==invocation.location.workspaceID||selected.session.projectID!==invocation.location.project.id)return yield* Effect.die(refuse('native_webfetch_secondary_scope_invalid'));
     const requested=Model.Ref.make({providerID:Provider.ID.make(frozen.model.providerID),id:Model.ID.make(frozen.model.modelID),...(frozen.model.variant?{variant:Model.VariantID.make(frozen.model.variant)}:{})});
     const model=yield* entry.selection.resolveModel({...selected.session,model:requested});
     if(model.ref.providerID!==requested.providerID||model.ref.id!==requested.id||requested.variant!==undefined&&model.ref.variant!==requested.variant)return yield* Effect.die(refuse('native_webfetch_secondary_model_conflict'));
     const history=yield* SessionHistory.preview(entry.database.db,selected.session.id,selected.instructions,SessionProviderContext.provenance(model)??'local');
     const transcript=SessionModelRequest.baseTranscript({agent:selected.agent.info,model,tools:selected.tools,initial:history.initial,messages:history.messages});
     const prepared=yield* entry.selection.request.generate({session:selected.session,agent:selected.agent.id,model,tools:selected.tools,system:transcript.system,messages:[...transcript.messages,...history.instructionUpdate?[Message.system(history.instructionUpdate)]:[],Message.user(frozen.prompt)]});
     yield* Effect.promise(check);const response=yield* llm.value.generate(prepared.request,prepared.options);yield* Effect.promise(check);return response.text;
    });
    const text=await Effect.runPromiseWith(entry.context)(options.withSecondary(invocation,frozen,execute),{signal:request.signal});
    request.signal.throwIfAborted();await check();return text;
   },
  };
 };
 const generateHelper=async(input:NativeHelperInput,permit:OperationPermit,signal:AbortSignal,recheck:()=>Promise<void>)=>{
  const frozen=nativeHelperInput(input),entry=[...entries.values()].find(item=>item.location.directory===frozen.directory),llm=nativeLLM;
  if(!entry?.active||!llm?.active||!permit.sessionID)throw refuse('native_helper_location_expired');
  const check=async()=>{signal.throwIfAborted();if(!entry.active||!llm.active||nativeLLM!==llm)throw refuse('native_helper_location_expired');await recheck();signal.throwIfAborted();};
  const execute=Effect.gen(function*(){
   yield* Effect.promise(check);
   const location=entry.location,agents=entry.agents;
   const agent=yield* agents.get(Agent.ID.make(frozen.agent));
   if(!agent)return yield* Effect.die(refuse('native_helper_agent_unavailable'));
   const ref=Model.Ref.make({providerID:Provider.ID.make(frozen.providerID),id:Model.ID.make(frozen.modelID),...(frozen.variant?{variant:Model.VariantID.make(frozen.variant)}:{})});
   // Hook correlation only. This Info is never inserted into SessionStore.
   const session=Schema.decodeUnknownSync(SessionSchema.Info)({id:permit.sessionID,projectID:location.project.id,location:{directory:location.directory,...location.workspaceID?{workspaceID:location.workspaceID}:{}},
    agent:agent.id,model:ref,cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},time:{created:Date.now(),updated:Date.now()}});
   const model=yield* entry.models.resolve(ref);
   if(!model)return yield* Effect.die(refuse('native_helper_model_unavailable'));
   if(model.ref.providerID!==ref.providerID||model.ref.id!==ref.id||model.ref.variant!==ref.variant)return yield* Effect.die(refuse('native_helper_model_changed'));
   const prepared=yield* entry.selection.request.generate({session,agent:agent.id,model,system:[...agent.system?[{type:'text' as const,text:agent.system}]:[],...frozen.system?[{type:'text' as const,text:frozen.system}]:[]],messages:[Message.user(frozen.prompt)]}).pipe(Effect.provideService(NativeHelperContextRef,session));
   if(prepared.event.model.providerID!==ref.providerID||prepared.event.model.id!==ref.id||prepared.event.model.variant!==ref.variant)return yield* Effect.die(refuse('native_helper_model_changed'));
   if(prepared.request.tools.length||Object.keys(prepared.event.tools??{}).length)return yield* Effect.die(refuse('native_helper_tools_forbidden'));
   const users=prepared.request.messages.filter(message=>message.role==='user');
   if(users.length!==1||users[0]?.content.length!==1||users[0].content[0]?.type!=='text'||users[0].content[0].text!==frozen.prompt)return yield* Effect.die(refuse('native_helper_prompt_changed'));
   const request=LLM.request({...prepared.request,generation:{...prepared.request.generation,maxTokens:Math.min(frozen.maxOutputTokens,model.limit.output)}});
   yield* Effect.promise(check);const response=yield* llm.value.generate(request,prepared.options).pipe(Effect.provideService(NativeHelperContextRef,session));yield* Effect.promise(check);
   if(Buffer.byteLength(response.text)>262144)return yield* Effect.die(refuse('native_helper_output_invalid'));
   return {text:response.text};
  });
  const result=await Effect.runPromiseWith(entry.context)(Effect.exit(execute.pipe(Effect.provideService(OperationPermitRef,permit))),{signal});
  if(Exit.isFailure(result))throw Cause.squash(result.cause);return result.value;
 };
 return {overrides,ownersFor,binaryDirectory,generateHelper};
}
