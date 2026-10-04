import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Credential} from '@opencode/core/credential';
import {Database} from '@opencode/core/database/database';
import {KV} from '@opencode/core/kv';
import {Global} from '@opencode/util/global';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Effect,Logger,Schema} from 'effect';
import {Integration} from '@opencode/core/integration';
import {captureNativeBundleCredentials,projectNativeBundleCredentials,bundleCredentialFingerprint,runNativeBundleCredentialAction,NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credentials.ts';
import {CLAUDE_LIFECYCLE_KEY,emptyClaudeLifecycle,transitionClaudeLifecycle} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';

const held=async()=>{};
const openai=Schema.decodeUnknownSync(Integration.ID)('openai');
const copilot=Schema.decodeUnknownSync(Integration.ID)('github-copilot');
const oauth=(generation:string)=>Schema.decodeUnknownSync(Credential.Value)({type:'oauth',methodID:'device',refresh:`fixture-refresh-${generation}`,access:`fixture-access-${generation}`,expires:1000});
const blocked={fingerprint:'a'.repeat(64),generation:'11111111-1111-1111-1111-111111111111',blocked:true,refreshing:true,refreshFingerprint:'b'.repeat(64),blockedRefreshFingerprints:['b'.repeat(64)]};
const fixture=async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/bundle-credentials-'));
 const layer=LayerNode.compile(LayerNode.group([Credential.node,KV.node,Database.node]),{replacements:[
  Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),
  Database.node.replace(Database.configured({path:path.join(root,'native.db')})),
 ]});
 return {root,run:<A,E>(effect:Effect.Effect<A,E,Credential.Service|Database.Service|KV.Service>)=>Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer),Effect.provide(Logger.layer([],{mergeWithExisting:false})))))};
};
const binding=(before:unknown,source:unknown)=>({sourceBundleID:'candidate',targetBundleID:'baseline',targetManifestSha256:'c'.repeat(64),expectedTargetSha256:bundleCredentialFingerprint(before),sourceSha256:bundleCredentialFingerprint(source)});

test('original SDK projection preserves rotation, exact active choice, removals and ambiguous refresh blocks',async()=>{
 const f=await fixture();try{
  await f.run(Effect.gen(function*(){
   const owner=yield* Credential.Service;
   const old=yield* owner.create({integrationID:openai,label:'old',value:oauth('old')});
   const removed=yield* owner.create({integrationID:copilot,label:'disconnected',value:oauth('removed')});
   const before=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
   const newRecord=yield* owner.create({integrationID:openai,label:'new selected',value:oauth('rotated')});
   yield* owner.remove(removed.id);yield* owner.update(old.id,{value:oauth('standby')});
   yield* Effect.promise(async()=>{await fs.mkdir(path.join(f.root,'runtime'),{mode:0o700});await fs.writeFile(path.join(f.root,'runtime','openai-oauth-state.json'),JSON.stringify(blocked),{mode:0o600});});
   const source=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
   // Reconstruct old A with original services; then exercise the actual owner.
   for(const row of yield* owner.all())yield* owner.remove(row.id);
   for(const row of before.credentials)yield* owner.create({...row,activate:row.active});
   yield* Effect.promise(()=>fs.rm(path.join(f.root,'runtime','openai-oauth-state.json')));
   const receipt=yield* projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held});
   expect(receipt).toMatchObject({status:'projected',appliedSha256:bundleCredentialFingerprint(source)});
   expect(yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held})).toEqual(source);
   expect(source.credentials.find(row=>row.id===newRecord.id)?.active).toBe(true);
   expect(yield* owner.get(removed.id)).toBeUndefined();
   expect(yield* projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held})).toEqual(receipt);
   yield* Effect.promise(()=>fs.writeFile(path.join(f.root,'runtime','openai-oauth-state.json'),JSON.stringify({...blocked,blockedRefreshOverflow:true})));
   expect((yield* Effect.exit(projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
   expect((yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held})).refreshBlockState).toEqual({...blocked,blockedRefreshOverflow:true});
   expect(JSON.stringify(receipt)).not.toContain('fixture-refresh');
  }));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('native commit survives host-state interruption but resumes only the identical private intent',async()=>{
 const f=await fixture();try{await f.run(Effect.gen(function*(){
  const owner=yield* Credential.Service,kv=yield* KV.Service;
  yield* owner.create({integrationID:openai,label:'baseline',value:oauth('old')});
  const before=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
  const source={...before,credentials:before.credentials.map(row=>({...row,value:oauth('new')})),refreshBlockState:blocked};
  let nativeIntentSeen=false,checksAfterIntent=0;
  const observedKV={...kv,set:(...args:Parameters<typeof kv.set>)=>kv.set(...args).pipe(Effect.tap(()=>Effect.sync(()=>{if(args[0]==='devryan.bundle.credentials.projection/1')nativeIntentSeen=true;})))};
  const stopAfterCommit=async()=>{if(nativeIntentSeen&&++checksAfterIntent===2)throw new Error('fixture_host_checkpoint_closed');};
  expect((yield* Effect.exit(projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:stopAfterCommit}).pipe(Effect.provideService(KV.Service,observedKV))))._tag).toBe('Failure');
  // The failure is after durable native commit, before host publication.
  expect((yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held})).credentials).toEqual(source.credentials);
  expect((yield* Effect.exit(projectNativeBundleCredentials({source:{...source,refreshBlockState:null},binding:binding(before,{...source,refreshBlockState:null}),webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
  expect((yield* projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held})).status).toBe('projected');
  expect(yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held})).toEqual(source);
 }));}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('changed baseline, incompatible graph/contract and open admission refuse without credential mutation',async()=>{
 const f=await fixture();try{await f.run(Effect.gen(function*(){
  const owner=yield* Credential.Service;
  const row=yield* owner.create({integrationID:openai,label:'baseline',value:oauth('old')});
  const before=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
  const source={...before,credentials:before.credentials.map(value=>({...value,value:oauth('new')}))};
  yield* owner.update(row.id,{label:'newer A selection'});
  expect((yield* Effect.exit(projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
  const current=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
  expect((yield* Effect.exit(projectNativeBundleCredentials({source,binding:binding(current,source),webDataDirectory:f.root,assertHeld:async()=>{throw new Error('fixture_admission_open');}})))._tag).toBe('Failure');
  expect((yield* Effect.exit(runNativeBundleCredentialAction({action:{protocol:'older/0',action:'project',source,binding:binding(current,source)},webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
  const inactive={...source,credentials:source.credentials.map(value=>({...value,active:false}))};
  expect((yield* Effect.exit(projectNativeBundleCredentials({source:inactive,binding:binding(current,inactive),webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
  expect(yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held})).toEqual(current);
  expect(NATIVE_BUNDLE_CREDENTIAL_CONTRACT).toBe('devryan.bundle.credentials/2');
 }));}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('bundle projection carries complete Claude enrollment and prepared replacement metadata in the original KV transaction',async()=>{
 const f=await fixture();try{await f.run(Effect.gen(function*(){
  const kv=yield* KV.Service;
  const account={profileID:'dedicated',service:'Claude Code-credentials-01234567',configDirectory:'/owned/enrolled/one',enrollmentID:'enrollment-one',generation:'generation-one',recordFingerprint:'1'.repeat(64),grantFingerprint:'2'.repeat(64)};
  let lifecycle=transitionClaudeLifecycle(emptyClaudeLifecycle(),0,{kind:'enroll',account});
  yield* kv.set(CLAUDE_LIFECYCLE_KEY,Schema.decodeUnknownSync(Schema.Json)(lifecycle));
  const before=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
  lifecycle=transitionClaudeLifecycle(lifecycle,lifecycle.revision,{kind:'begin',account,attemptID:'uncertain-attempt'});
  const {recordFingerprint,grantFingerprint,...enrollment}=account;void recordFingerprint;void grantFingerprint;
  lifecycle=transitionClaudeLifecycle(lifecycle,lifecycle.revision,{kind:'prepare',binding:enrollment,attemptID:'uncertain-attempt',recordFingerprint:'3'.repeat(64),grantFingerprint:'4'.repeat(64)});
  yield* kv.set(CLAUDE_LIFECYCLE_KEY,Schema.decodeUnknownSync(Schema.Json)(lifecycle));
  const source=yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held});
  expect(source.claudeLifecycle).toEqual(lifecycle);
  yield* kv.set(CLAUDE_LIFECYCLE_KEY,Schema.decodeUnknownSync(Schema.Json)(before.claudeLifecycle));
  yield* projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held});
  expect(yield* captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held})).toEqual(source);
  expect((yield* Effect.exit(runNativeBundleCredentialAction({action:{protocol:'devryan.bundle.credentials/1',action:'capture'},webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
  yield* kv.remove(CLAUDE_LIFECYCLE_KEY);
  expect((yield* Effect.exit(projectNativeBundleCredentials({source,binding:binding(before,source),webDataDirectory:f.root,assertHeld:held})))._tag).toBe('Failure');
  const corruptKV={...kv,get:(key:string)=>key===CLAUDE_LIFECYCLE_KEY?Effect.succeed(null):kv.get(key)};
  expect((yield* Effect.exit(captureNativeBundleCredentials({webDataDirectory:f.root,assertHeld:held}).pipe(Effect.provideService(KV.Service,corruptKV))))._tag).toBe('Failure');
 }));}finally{await fs.rm(f.root,{recursive:true,force:true});}
});
