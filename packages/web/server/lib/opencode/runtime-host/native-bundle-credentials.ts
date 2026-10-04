import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Credential} from '@opencode/core/credential';
import {Integration} from '@opencode/core/integration';
import {CredentialTable} from '@opencode/core/credential/sql';
import {Database} from '@opencode/core/database/database';
import {KV} from '@opencode/core/kv';
import {Effect,Schema} from 'effect';
import {saveBundleJSON} from './bundle-migration-inventory.js';
import {CLAUDE_LIFECYCLE_KEY,parseClaudeLifecycle,type ClaudeLifecycleState} from './native-claude-lifecycle.js';

export const NATIVE_BUNDLE_CREDENTIAL_CONTRACT='devryan.bundle.credentials/2';
const projectionKey='devryan.bundle.credentials.projection/1';
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,item])=>item!==undefined).map(([key,item])=>[key,canonical(item)])):value;
export const bundleCredentialFingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const digest=Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const account=Schema.Struct({id:Credential.ID,integrationID:Integration.ID,label:Schema.String,value:Credential.Value,active:Schema.Boolean});
const snapshot=Schema.Struct({protocol:Schema.Literal(NATIVE_BUNDLE_CREDENTIAL_CONTRACT),credentials:Schema.Array(account),refreshBlockState:Schema.NullOr(Schema.Unknown),claudeLifecycle:Schema.NullOr(Schema.Unknown)});
export type NativeBundleCredentialSnapshot=Omit<typeof snapshot.Type,'claudeLifecycle'>&{readonly claudeLifecycle:ClaudeLifecycleState|null};
export interface NativeBundleCredentialBinding {
 readonly sourceBundleID:string;readonly targetBundleID:string;readonly targetManifestSha256:string;
 readonly expectedTargetSha256:string;readonly sourceSha256:string;
}
const refusal=(code:string):never=>{throw Object.assign(new Error(code),{code,status:503});};
const validate=(value:unknown):NativeBundleCredentialSnapshot=>{
 let result:typeof snapshot.Type;try{result=Schema.decodeUnknownSync(snapshot)(value,{onExcessProperty:'error'});}catch{return refusal('bundle_credential_snapshot_invalid');}
 if(result.credentials.length>256||Buffer.byteLength(JSON.stringify(result))>1024*1024||new Set(result.credentials.map(row=>row.id)).size!==result.credentials.length)return refusal('bundle_credential_snapshot_invalid');
 const active=new Set<string>();for(const row of result.credentials)if(row.active){if(active.has(row.integrationID))return refusal('bundle_credential_snapshot_invalid');active.add(row.integrationID);}
 // Original Credential.create guarantees one active record per nonempty integration.
 // A graph outside that contract cannot be projected through the original APIs.
 if(result.credentials.some(row=>!active.has(row.integrationID)))return refusal('bundle_credential_contract_incompatible');
 const state=result.refreshBlockState;
 if(state!==null){
  if(typeof state!=='object'||Array.isArray(state)||Object.keys(state).some(key=>!['fingerprint','generation','blocked','refreshing','refreshFingerprint','blockedRefreshFingerprints','blockedRefreshOverflow'].includes(key)))return refusal('bundle_credential_refresh_state_invalid');
  // Do not accept arbitrary owner state or a silently reset ambiguous rotation.
  const saved=state as Record<string,unknown>;
  if(typeof saved.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(saved.fingerprint)||typeof saved.generation!=='string'||!/^[a-f0-9-]{36}$/.test(saved.generation)
   ||typeof saved.blocked!=='boolean'||saved.refreshing!==undefined&&typeof saved.refreshing!=='boolean'
   ||saved.refreshFingerprint!==undefined&&(typeof saved.refreshFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(saved.refreshFingerprint))
   ||saved.blockedRefreshOverflow!==undefined&&typeof saved.blockedRefreshOverflow!=='boolean'
   ||saved.blockedRefreshFingerprints!==undefined&&(!Array.isArray(saved.blockedRefreshFingerprints)||saved.blockedRefreshFingerprints.length>128||saved.blockedRefreshFingerprints.some(item=>typeof item!=='string'||!/^[a-f0-9]{64}$/.test(item))))return refusal('bundle_credential_refresh_state_invalid');
 }
 let claudeLifecycle:ClaudeLifecycleState|null;try{claudeLifecycle=result.claudeLifecycle===null?null:parseClaudeLifecycle(result.claudeLifecycle);}catch{return refusal('bundle_credential_claude_state_invalid');}
 return {...result,claudeLifecycle};
};
const readHostState=async(file:string)=>{
 try{
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024||await fs.realpath(file)!==file)return refusal('bundle_credential_refresh_state_invalid');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const current=await handle.stat(),bytes=await handle.readFile(),after=await fs.lstat(file);
   if(bytes.length>64*1024||current.ino!==stat.ino||current.dev!==stat.dev||after.ino!==current.ino||after.dev!==current.dev
    ||after.mtimeMs!==current.mtimeMs||after.ctimeMs!==current.ctimeMs)return refusal('bundle_credential_baseline_changed');
   try{return JSON.parse(bytes.toString('utf8')) as unknown;}catch{return refusal('bundle_credential_refresh_state_invalid');}
  }finally{await handle.close();}
 }catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return null;throw error;}
};

/** Original services only, under the constructing host's closed-admission checkpoint. */
export function captureNativeBundleCredentials({webDataDirectory,assertHeld}:{readonly webDataDirectory:string;readonly assertHeld:()=>Promise<void>}){
 return Effect.gen(function*(){
  yield* Effect.promise(assertHeld);const db=yield* Database.Service,kv=yield* KV.Service;
  const rows=yield* db.db.select().from(CredentialTable).all();
  if(rows.some(row=>!row.integration_id||row.connector_id!==null||row.method_id!==null))return refusal('bundle_credential_contract_incompatible');
  const state=yield* Effect.promise(()=>readHostState(path.join(webDataDirectory,'runtime','openai-oauth-state.json')));
  const savedClaudeLifecycle=yield* kv.get(CLAUDE_LIFECYCLE_KEY);
  const claudeLifecycle=savedClaudeLifecycle===undefined?null:parseClaudeLifecycle(savedClaudeLifecycle);
  const result=validate({protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,credentials:rows.map(row=>({id:row.id,integrationID:row.integration_id,label:row.label,value:row.value,active:row.active===true})).sort((a,b)=>a.id.localeCompare(b.id)),refreshBlockState:state,claudeLifecycle});
  yield* Effect.promise(assertHeld);return result;
 });
}

/** No provider resolve, session admission, HTTP secret payload or SQL credential writes.
 * A durable KV intent makes the separate host-state publication retryable. */
export function projectNativeBundleCredentials({source,binding,webDataDirectory,assertHeld}:{readonly source:unknown;readonly binding:NativeBundleCredentialBinding;readonly webDataDirectory:string;readonly assertHeld:()=>Promise<void>}){
 return Effect.gen(function*(){
  const desired=validate(source);
  for(const value of [binding.expectedTargetSha256,binding.sourceSha256,binding.targetManifestSha256])try{Schema.decodeUnknownSync(digest)(value);}catch{return refusal('bundle_credential_binding_invalid');}
  if(![binding.sourceBundleID,binding.targetBundleID].every(value=>/^[a-zA-Z0-9_-]{1,128}$/.test(value))||binding.sourceBundleID===binding.targetBundleID||bundleCredentialFingerprint(desired)!==binding.sourceSha256)return refusal('bundle_credential_binding_invalid');
  yield* Effect.promise(assertHeld);const credentials=yield* Credential.Service,db=yield* Database.Service,kv=yield* KV.Service;
  const intentSha256=bundleCredentialFingerprint({binding,source:desired});
  const prior=yield* kv.get(projectionKey);
  if(prior!==undefined&&(typeof prior!=='object'||prior===null||Array.isArray(prior)||!('schema'in prior)||prior.schema!==1||!('intentSha256'in prior)
   ||typeof prior.intentSha256!=='string'||!('status'in prior)||!['native-committed','completed'].includes(String(prior.status))
   ||!('beforeHostStateSha256'in prior)||typeof prior.beforeHostStateSha256!=='string'||!('desiredHostStateSha256'in prior)||typeof prior.desiredHostStateSha256!=='string'))return refusal('bundle_credential_projection_conflict');
  if(prior!==undefined&&typeof prior==='object'&&prior!==null&&'intentSha256'in prior&&prior.intentSha256===intentSha256){
   const current=yield* captureNativeBundleCredentials({webDataDirectory,assertHeld});
   if(bundleCredentialFingerprint({...current,refreshBlockState:desired.refreshBlockState})!==binding.sourceSha256)return refusal('bundle_credential_projection_conflict');
   const stateHash=bundleCredentialFingerprint(current.refreshBlockState);
   if('status'in prior&&prior.status==='completed'?bundleCredentialFingerprint(current)!==binding.sourceSha256:
    !('beforeHostStateSha256'in prior)||!('desiredHostStateSha256'in prior)||(stateHash!==prior.beforeHostStateSha256&&stateHash!==prior.desiredHostStateSha256))return refusal('bundle_credential_projection_conflict');
  }else{
   if(prior!==undefined&&typeof prior==='object'&&prior!==null&&'status'in prior&&prior.status!=='completed')return refusal('bundle_credential_projection_conflict');
   const before=yield* captureNativeBundleCredentials({webDataDirectory,assertHeld});
   if(bundleCredentialFingerprint(before)!==binding.expectedTargetSha256)return refusal('bundle_credential_baseline_changed');
   yield* db.db.$client.withTransaction(Effect.gen(function*(){
    yield* Effect.promise(assertHeld);
    const current=yield* captureNativeBundleCredentials({webDataDirectory,assertHeld});
    if(bundleCredentialFingerprint(current)!==binding.expectedTargetSha256)return refusal('bundle_credential_baseline_changed');
    // Recreate the exact graph with original Credential APIs. This handles
    // revoked/removed records without restoring the target's older selection.
    for(const row of yield* credentials.all())yield* credentials.remove(row.id);
    for(const row of desired.credentials)yield* credentials.create({id:row.id,integrationID:row.integrationID,label:row.label,value:row.value,activate:false});
    for(const row of desired.credentials)if(row.active)yield* credentials.activate(row.id);
    if(desired.claudeLifecycle===null)yield* kv.remove(CLAUDE_LIFECYCLE_KEY);
    else yield* kv.set(CLAUDE_LIFECYCLE_KEY,Schema.decodeUnknownSync(Schema.Json)(desired.claudeLifecycle));
    yield* kv.set(projectionKey,{schema:1,intentSha256,status:'native-committed',beforeHostStateSha256:bundleCredentialFingerprint(before.refreshBlockState),desiredHostStateSha256:bundleCredentialFingerprint(desired.refreshBlockState)});
    yield* Effect.promise(assertHeld);
   })).pipe(Effect.orDie);
  }
  const file=path.join(webDataDirectory,'runtime','openai-oauth-state.json');
  yield* Effect.promise(async()=>{await assertHeld();if(desired.refreshBlockState===null)await fs.rm(file,{force:true});else await saveBundleJSON(file,desired.refreshBlockState);await assertHeld();});
  const after=yield* captureNativeBundleCredentials({webDataDirectory,assertHeld});
  if(bundleCredentialFingerprint(after)!==binding.sourceSha256)return refusal('bundle_credential_projection_unverified');
  const committed=yield* kv.get(projectionKey);
  if(typeof committed!=='object'||committed===null||Array.isArray(committed)||!('intentSha256'in committed)||committed.intentSha256!==intentSha256)return refusal('bundle_credential_projection_conflict');
  yield* kv.set(projectionKey,{...committed,status:'completed'});
  return {protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'projected' as const,...binding,appliedSha256:binding.sourceSha256};
 });
}

/** Strict private stdin action. Paths/holds come from the verified constructor,
 * never the private credential payload. Capture replies must remain private. */
export function runNativeBundleCredentialAction({action,webDataDirectory,assertHeld}:{readonly action:unknown;readonly webDataDirectory:string;readonly assertHeld:()=>Promise<void>}){
 return Effect.gen(function*(){
  if(typeof action!=='object'||action===null||Array.isArray(action))return refusal('bundle_credential_action_invalid');
  const input=action as Record<string,unknown>;
  if(input.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT)return refusal('bundle_credential_contract_incompatible');
  if(input.action==='capture'&&Object.keys(input).every(key=>['protocol','action'].includes(key))){
   const value=yield* captureNativeBundleCredentials({webDataDirectory,assertHeld});
   return {protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'captured' as const,snapshot:value,sha256:bundleCredentialFingerprint(value)};
  }
  if(input.action!=='project'||Object.keys(input).some(key=>!['protocol','action','source','binding'].includes(key)))return refusal('bundle_credential_action_invalid');
  const fields=Schema.Struct({sourceBundleID:Schema.String,targetBundleID:Schema.String,targetManifestSha256:digest,expectedTargetSha256:digest,sourceSha256:digest});
  let binding:NativeBundleCredentialBinding;try{binding=Schema.decodeUnknownSync(fields)(input.binding,{onExcessProperty:'error'});}catch{return refusal('bundle_credential_binding_invalid');}
  return yield* projectNativeBundleCredentials({source:input.source,binding,webDataDirectory,assertHeld});
 });
}
