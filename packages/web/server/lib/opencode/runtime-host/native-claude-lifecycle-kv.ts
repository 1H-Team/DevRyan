import {KV} from '@opencode/core/kv';
import {Database} from '@opencode/core/database/database';
import {Effect,Logger,Schema} from 'effect';
import {CLAUDE_LIFECYCLE_KEY,emptyClaudeLifecycle,parseClaudeLifecycle,transitionClaudeLifecycle,claudeRecordFingerprint,type ClaudeLifecycleOperation} from './native-claude-lifecycle.js';

export function readNativeClaudeLifecycle(){
 return Effect.gen(function*(){const kv=yield* KV.Service;const value=yield* kv.get(CLAUDE_LIFECYCLE_KEY);return value===undefined?emptyClaudeLifecycle():parseClaudeLifecycle(value);});
}
/** The original database transaction owns both expected-revision comparison and
 * publication. No host callback, provider HTTP, credential value or second store. */
export function transitionNativeClaudeLifecycle(expectedRevision:number,operation:ClaudeLifecycleOperation,assertCurrent:()=>void){
 return Effect.gen(function*(){
  const db=yield* Database.Service,kv=yield* KV.Service;
  return yield* db.db.$client.withTransaction(Effect.gen(function*(){
   assertCurrent();const before=yield* readNativeClaudeLifecycle();
   const next=transitionClaudeLifecycle(before,expectedRevision,operation);
   yield* kv.set(CLAUDE_LIFECYCLE_KEY,Schema.decodeUnknownSync(Schema.Json)(next));
   const written=yield* readNativeClaudeLifecycle();
   if(claudeRecordFingerprint(next)!==claudeRecordFingerprint(written))throw new Error('native_claude_lifecycle_unverified');
   assertCurrent();return written;
  })).pipe(Effect.orDie);
 });
}
export function createControllerClaudeLifecycle(options:{readonly controllerInstanceID:string;readonly kv:KV.Interface;readonly database:Database.Interface;readonly isCurrent:()=>boolean}){
 const assertCurrent=()=>{if(!options.isCurrent())throw new Error('native_claude_lifecycle_owner_expired');};
 const run=<A,E>(effect:Effect.Effect<A,E,KV.Service|Database.Service>)=>Effect.runPromise(effect.pipe(
  Effect.provideService(KV.Service,options.kv),Effect.provideService(Database.Service,options.database),Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
 const binding=(controllerInstanceID:string)=>{assertCurrent();if(controllerInstanceID!==options.controllerInstanceID)throw new Error('native_claude_lifecycle_owner_expired');};
 return {
  async readOwned(input:{readonly controllerInstanceID:string}){binding(input.controllerInstanceID);const state=await run(readNativeClaudeLifecycle());binding(input.controllerInstanceID);return state;},
  async transitionOwned(input:{readonly controllerInstanceID:string;readonly expectedRevision:number;readonly operation:ClaudeLifecycleOperation}){
   binding(input.controllerInstanceID);const state=await run(transitionNativeClaudeLifecycle(input.expectedRevision,input.operation,assertCurrent));binding(input.controllerInstanceID);return state;
  },
 };
}
