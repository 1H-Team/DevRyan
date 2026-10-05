import {expect,test} from 'bun:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import {Credential} from '@opencode/core/credential';
import {Database} from '@opencode/core/database/database';
import {KV} from '@opencode/core/kv';
import {Integration} from '@opencode/core/integration';
import {Location} from '@opencode/core/location';
import {Global} from '@opencode/util/global';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Effect,Schema} from 'effect';
import {createControllerIntegrations} from '../../packages/web/server/lib/opencode/runtime-host/controller-integrations.js';
import type {NativeConfigurationSnapshot} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js';
import {credentialMutationFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import {createNativeIntegrationOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-integration-owner.js';
import type {NativeControllerProcess} from '../../packages/web/server/lib/opencode/runtime-host/native-process.js';
import {bootstrapNativeSetupCredentials,NATIVE_SETUP_CREDENTIAL_STAMP} from '../../packages/web/server/lib/opencode/runtime-host/native-setup-credentials.js';
import {parseClaudeLifecycle} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';

const directory=path.resolve('.cache/v2-validation/controller-integrations');
const location=Schema.decodeUnknownSync(Location.Info)({directory,project:{id:'global',directory,canonical:directory}});
function snapshot():NativeConfigurationSnapshot{return {schema:1,revision:1,sourceStamp:'a'.repeat(64),digest:'b'.repeat(64),registrationManifestDigest:'c'.repeat(64),locations:[{
  directory,configuration:{providers:{}},skills:[],instructions:[],textReferences:[],aliases:[],activePlugins:[],
  compatibility:{legacy:{},agents:{},commands:{},slim:{},mcp:{}},
  requiredCatalogs:{agents:[],plugins:[],tools:[],models:[],skills:[],commands:[],mcp:[]}}]};}

test('controller startup seeds the original credential graph with its shared database and KV before decoration',async()=>{
  const state=await fs.mkdtemp(path.resolve('.cache/v2-validation/controller-setup-'));
  const seedPath=path.join(state,'native-setup-credentials.json');
  let database:Database.Interface|undefined,kv:KV.Interface|undefined,bootstraps=0;
  await fs.writeFile(seedPath,JSON.stringify({schema:1,credentials:[{integrationID:'openai',value:{type:'key',key:'synthetic-setup-key'}}]}));
  const factory=createControllerIntegrations({controllerInstanceID:'controller-setup',configurationSnapshot:snapshot(),
    registrationOrigin:{kind:'native',id:'devryan.remote-mcp',manifestDigest:'c'.repeat(64),capabilities:['network']},reviewedConfigurationOrigins:new Map(),
    isBound:()=>false,isExecutionReady:()=>false,rpc:async()=>{throw Error('Setup must use original constructor services');},
    executeOwnedFallback:invocation=>invocation.executeNative(),authorizeMcpCall:(_i,_b,a)=>a,
    bootstrapCredentials:()=>Effect.gen(function*(){
      bootstraps++;database=yield* Database.Service;kv=yield* KV.Service;
      yield* bootstrapNativeSetupCredentials({seedPath});
    })});
  const layer=LayerNode.compile(LayerNode.group([Credential.node,Integration.node,Database.node,KV.node]),{replacements:[...factory.overrides,
    Global.node.replace(Global.layerWith({home:state,data:state,cache:state,config:state,state,tmp:state,bin:state,log:state,repos:state}))]});
  try{
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const credentials=yield* Credential.Service;yield* Integration.Service;
      if(!database||!kv)throw Error('Constructor setup services were not acquired');
      expect(yield* Database.Service).toBe(database);expect(yield* KV.Service).toBe(kv);expect(bootstraps).toBe(1);
      expect(yield* credentials.all()).toMatchObject([{integrationID:'openai',value:{type:'key',key:'synthetic-setup-key'}}]);
      expect(yield* (yield* KV.Service).get(NATIVE_SETUP_CREDENTIAL_STAMP)).toMatchObject({schema:1,count:1});
    }).pipe(Effect.provide(layer),Effect.provideService(Location.Service,location))));
    expect(await fs.stat(seedPath).catch(error=>error.code)).toBe('ENOENT');
  }finally{await factory.close();await fs.rm(state,{recursive:true,force:true});}
});

test('actual Node original-caller grants and shared queue reach the single native Credential graph without lending a stale acquisition',async()=>{
  const observations:{method:string;input:unknown}[]=[];
  const state=await fs.mkdtemp(path.resolve('.cache/v2-validation/integration-state-'));
  const configuration=snapshot();let ready=false,originalChecks=0;
  let queue:Promise<void>=Promise.resolve();
  const withMutationQueue=<A>(action:()=>A|Promise<A>)=>{const result=queue.then(action);queue=result.then(()=>undefined,()=>undefined);return result;};
  const controller:Pick<NativeControllerProcess,'instanceID'|'call'|'killAndWaitForExit'|'killAndWaitForTermination'>={instanceID:'controller-one',
    call:async input=>{
      if(input.action==='credential-commit-owned')return factory.commitCredentialOwned(input);
      if(input.action==='openai-read-selected-owned')return factory.readSelectedOwned(input);
      if(input.action==='openai-cas-selected-owned')return factory.compareAndSwapSelectedOwned(input);
      if(input.action==='credential-operation-owned')return factory.credentialOwned(input);
      if(input.action==='credential-metadata-owned')return factory.credentialMetadataOwned(input);
      throw new Error('Unexpected native control');
    },killAndWaitForExit:async()=>{throw new Error('No real native process in service acquisition fixture');},
    killAndWaitForTermination:async()=>{throw new Error('No real native process in service acquisition fixture');}};
  const node=createNativeIntegrationOwner({instanceID:'controller-one',snapshot:configuration,stateDirectory:state,controller:()=>controller,
    isReady:()=>ready,withMutationQueue,captureWebAuthorization:async()=>async()=>{originalChecks++;},
    admissionOwner:{withProviderResolution:async (_input,action)=>action(async()=>{}),withProviderAttempt:(_input,action)=>action(async()=>{}),withImageGeneration:async()=>{throw Error('Image generation is outside this credential fixture');}}});
  const factory=createControllerIntegrations({controllerInstanceID:'controller-one',configurationSnapshot:configuration,
    registrationOrigin:{kind:'native',id:'devryan.remote-mcp',manifestDigest:'c'.repeat(64),capabilities:['network']},reviewedConfigurationOrigins:new Map(),
    isBound:()=>true,isExecutionReady:()=>ready,executeOwnedFallback:invocation=>invocation.executeNative(),authorizeMcpCall:(_invocation,_binding,action)=>action,
    rpc:async(method,input,context)=>{observations.push({method,input});return node.handleRpc(method,input,context);}});
  const layer=LayerNode.compile(LayerNode.group([Credential.node,Integration.node]),{replacements:[...factory.overrides,
    Global.node.replace(Global.layerWith({home:directory,data:directory,cache:directory,config:directory,state:directory,tmp:directory,bin:directory,log:directory,repos:directory}))]});
  let old:Integration.Interface|undefined,requestAuthorization:string|undefined;
  const nativeInput={integrationID:Schema.decodeUnknownSync(Integration.ID)('openai'),label:'Owned fixture',value:Schema.decodeUnknownSync(Credential.Value)({type:'key',key:'synthetic-no-provider'})};
  const spec={kind:'openai' as const,directory,integrationID:'openai',configurationDigest:credentialMutationFingerprint({}),operation:'openai.credential.create',
    method:'POST' as const,path:'/api/credential',body:nativeInput,valueType:'key' as const,requestedFingerprint:credentialMutationFingerprint(nativeInput)};
  try{
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      old=yield* Integration.Service;const credential=yield* Credential.Service;ready=true;
      const created=yield* Effect.promise(()=>node.withCallerOperation(spec,async()=>{
        requestAuthorization=node.requestHeaders()['x-devryan-native-integration-grant'];
        return factory.credentialOwned({directory,requestAuthorization,mutation:{operation:'create',input:nativeInput}});
      }));
      expect(created).toEqual({credentialID:expect.any(String)});if(!created.credentialID)throw new Error('Canonical native credential required');
      const id=Schema.decodeUnknownSync(Credential.ID)(created.credentialID);
      expect((yield* credential.get(id))?.label).toBe('Owned fixture');
      const metadata=yield* Effect.promise(()=>node.credentialMetadata({kind:'openai',directory,integrationID:'openai',
        configurationDigest:credentialMutationFingerprint({}),operation:'openai.integration',method:'GET',path:'/api/integration/openai'}));
      expect(metadata).toEqual([{id,integrationID:'openai',label:'Owned fixture',valueType:'key',active:true,
        expectedFingerprint:credentialMutationFingerprint(yield* credential.get(id))}]);
      expect(JSON.stringify(metadata)).not.toContain('synthetic-no-provider');
      const captures=observations.filter(row=>row.method==='integration.capture');expect(captures).toHaveLength(1);
      expect(captures[0].input).toMatchObject({operation:'mutation',requestAuthorization,binding:{kind:'openai',directory,
        controllerInstanceID:'controller-one',integrationID:'openai',configurationDigest:credentialMutationFingerprint({}),
        acquisitionID:expect.any(String),valueType:'key',requestedFingerprint:credentialMutationFingerprint(nativeInput)}});
      const commits=observations.filter(row=>row.method==='credential.mutation.commit');expect(commits).toHaveLength(1);
      expect(JSON.stringify(commits)).not.toContain('synthetic-no-provider');expect(originalChecks).toBeGreaterThan(1);
      expect(yield* Effect.promise(()=>factory.readSelectedOwned({directory}))).toMatchObject({integrationID:'openai',directory});
      if(!requestAuthorization)throw new Error('Original browser grant required');const stale=requestAuthorization;
      const refused=yield* Effect.exit(Effect.promise(()=>factory.credentialOwned({directory,requestAuthorization:stale,mutation:{operation:'create',input:nativeInput}})));
      expect(refused._tag).toBe('Failure');expect((yield* credential.list(nativeInput.integrationID))).toHaveLength(1);
    }).pipe(Effect.provide(layer),Effect.provideService(Location.Service,location))));
    if(!old||!requestAuthorization)throw new Error('Actual captured native Integration required');
    await expect(Effect.runPromise(old.list())).rejects.toMatchObject({code:'native_openai_location_expired'});
    await expect(factory.credentialOwned({directory,requestAuthorization,mutation:{operation:'create',input:nativeInput}})).rejects.toMatchObject({code:'native_integration_acquisition_expired'});
  }finally{await node.invalidate();await factory.close();await fs.rm(state,{recursive:true,force:true});}
});

test('saved remote MCP definitions are reviewed from compatibility snapshot and enabled local spawn is refused',async()=>{
  const config=snapshot();config.locations[0].compatibility.mcp.remote={type:'remote',url:'http://127.0.0.1:1/mcp',enabled:true};
  const create=()=>createControllerIntegrations({controllerInstanceID:'controller-one',configurationSnapshot:config,
    registrationOrigin:{kind:'native',id:'devryan.remote-mcp',manifestDigest:'c'.repeat(64),capabilities:['network']},reviewedConfigurationOrigins:new Map(),
    isBound:()=>false,isExecutionReady:()=>false,rpc:async()=>null,executeOwnedFallback:invocation=>invocation.executeNative(),authorizeMcpCall:(_i,_b,a)=>a});
  const factory=create();expect(factory.overrides).toHaveLength(5);await factory.close();
  config.locations[0].compatibility.mcp.local={type:'local',command:['unreviewed'],enabled:true};
  expect(create).toThrow('native_mcp_configuration_unqualified');
});

test('Cursor key reads use the actual selected native Credential and refuse closed acquisitions',async()=>{
  const config=snapshot();
  const state=await fs.mkdtemp(path.resolve('.cache/v2-validation/cursor-native-keys-'));
  let allowed=true,checks=0;let queue:Promise<void>=Promise.resolve();
  const node=createNativeIntegrationOwner({instanceID:'controller-one',snapshot:config,stateDirectory:state,
    controller:()=>({instanceID:'controller-one',call:async input=>{
      if(input.action==='credential-commit-owned')return factory.commitCredentialOwned(input);
      if(input.action==='credential-operation-owned')return factory.credentialOwned(input);
      if(input.action==='credential-metadata-owned')return factory.credentialMetadataOwned(input);
      throw Error('Unexpected native control');
    },killAndWaitForExit:async()=>{throw Error('No native process in service acquisition fixture');},
    killAndWaitForTermination:async()=>{throw Error('No native process in service acquisition fixture');}}),isReady:()=>true,
    withMutationQueue:action=>{const result=queue.then(action);queue=result.then(()=>undefined,()=>undefined);return result;},
    captureWebAuthorization:async()=>async()=>{if(!allowed)throw Error('original caller revoked');},
    admissionOwner:{withProviderResolution:async (_input,action)=>action(async()=>{}),withProviderAttempt:(_input,action)=>action(async()=>{}),withImageGeneration:async()=>{throw Error('Outside fixture');}}});
  const create=async(label:string,key:string)=>{
    const body={integrationID:Schema.decodeUnknownSync(Integration.ID)('cursor-acp'),label,value:{type:'key' as const,key}};
    const result=await node.credentialOperation({kind:'cursor',directory,integrationID:'cursor-acp',configurationDigest:credentialMutationFingerprint({}),
      operation:'cursor.credential.create',method:'POST',path:'/api/credential',body,valueType:'key',requestedFingerprint:credentialMutationFingerprint(body)},
      {operation:'create',input:body});
    if(!result||typeof result!=='object'||!('credentialID' in result))throw Error('Native credential ID required');
    return Schema.decodeUnknownSync(Credential.ID)(result.credentialID);
  };
  const factory=createControllerIntegrations({controllerInstanceID:'controller-one',configurationSnapshot:config,
    registrationOrigin:{kind:'native',id:'devryan.remote-mcp',manifestDigest:'c'.repeat(64),capabilities:['network']},reviewedConfigurationOrigins:new Map(),
    isBound:()=>true,isExecutionReady:()=>true,rpc:(method,input,context)=>node.handleRpc(method,input,context),
    executeOwnedFallback:invocation=>invocation.executeNative(),authorizeMcpCall:(_i,_b,a)=>a,
    authorizeCursorKey:()=>Effect.sync(()=>{checks++;if(!allowed)throw Error('original caller revoked');})});
  const layer=LayerNode.compile(LayerNode.group([Credential.node,Integration.node]),{replacements:[...factory.overrides,
    Global.node.replace(Global.layerWith({home:state,data:state,cache:state,config:state,state,tmp:state,bin:state,log:state,repos:state}))]});
  const input={controllerInstanceID:'controller-one',directory,sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer',
    permit:{token:'a'.repeat(64),sessionID:'ses_cursor',revision:0}};
  try{
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const integrations=yield* Integration.Service;const credentials=yield* Credential.Service;
      const integrationID=Schema.decodeUnknownSync(Integration.ID)('cursor-acp');
      expect((yield* integrations.get(integrationID))?.methods).toContainEqual({type:'key',label:'Cursor API Key'});
      const deniedDirect=yield* Effect.exit(credentials.create({integrationID,value:Schema.decodeUnknownSync(Credential.Value)({type:'key',key:'synthetic-unowned'})}));
      expect(deniedDirect._tag).toBe('Failure');expect(yield* credentials.list(integrationID)).toHaveLength(0);
      const first=yield* Effect.promise(()=>create('Account A','synthetic-cursor-a'));
      const selectedA=yield* Effect.promise(()=>factory.readSelectedCursorKeyOwned(input));expect(selectedA.key).toBe('synthetic-cursor-a');expect(selectedA.credentialID).toBe(first);
      const second=yield* Effect.promise(()=>create('Account B','synthetic-cursor-b'));
      const secondRecord=yield* credentials.get(second);
      yield* Effect.promise(()=>node.credentialOperation({kind:'cursor',directory,integrationID:'cursor-acp',configurationDigest:credentialMutationFingerprint({}),
        operation:'cursor.credential.activate',method:'POST',path:`/api/credential/${second}/activate`,valueType:'key',credentialID:second,
        expectedFingerprint:credentialMutationFingerprint(secondRecord),requestedFingerprint:credentialMutationFingerprint({id:second})},{operation:'activate',id:second}));
      const selectedB=yield* Effect.promise(()=>factory.readSelectedCursorKeyOwned(input));expect(selectedB.key).toBe('synthetic-cursor-b');expect(selectedB.credentialID).toBe(second);
      expect(selectedB.expectedFingerprint).not.toBe(selectedA.expectedFingerprint);expect(checks).toBe(4);
      allowed=false;const denied=yield* Effect.exit(Effect.promise(()=>factory.readSelectedCursorKeyOwned(input)));expect(denied._tag).toBe('Failure');
    }).pipe(Effect.provide(layer),Effect.provideService(Location.Service,location))));
    await expect(factory.readSelectedCursorKeyOwned(input)).rejects.toMatchObject({code:'native_integration_acquisition_expired'});
  }finally{await node.invalidate();await factory.close();await fs.rm(state,{recursive:true,force:true});}
});

test('private Claude lifecycle commands use original KV during held admission without reverse host queue callbacks',async()=>{
 const state=await fs.mkdtemp(path.resolve('.cache/v2-validation/controller-claude-lifecycle-'));let bound=false;
 const factory=createControllerIntegrations({controllerInstanceID:'controller-claude',configurationSnapshot:snapshot(),
  registrationOrigin:{kind:'native',id:'devryan.remote-mcp',manifestDigest:'c'.repeat(64),capabilities:['network']},reviewedConfigurationOrigins:new Map(),
  isBound:()=>bound,isExecutionReady:()=>false,rpc:async()=>{throw Error('Lifecycle KV must never reenter host credential queue');},
  executeOwnedFallback:invocation=>invocation.executeNative(),authorizeMcpCall:(_i,_b,a)=>a});
 const layer=LayerNode.compile(LayerNode.group([Credential.node,KV.node,Database.node]),{replacements:[...factory.overrides,
  Global.node.replace(Global.layerWith({home:state,data:state,cache:state,config:state,state,tmp:state,bin:state,log:state,repos:state})),Database.node.replace(Database.configured({path:path.join(state,'native.db')}))]});
 try{
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
   yield* Credential.Service;bound=true;
   const initial=yield* Effect.promise(()=>factory.readClaudeLifecycleOwned({controllerInstanceID:'controller-claude'}));expect(initial.revision).toBe(0);
   const account={profileID:'dedicated',service:'Claude Code-credentials-01234567',configDirectory:'/owned/enrolled/one',enrollmentID:'enrollment-one',generation:'generation-one',grantFingerprint:'1'.repeat(64),recordFingerprint:'2'.repeat(64)};
   const enrolled=yield* Effect.promise(()=>factory.transitionClaudeLifecycleOwned({controllerInstanceID:'controller-claude',expectedRevision:initial.revision,operation:{kind:'enroll',account}}));
   expect(enrolled.accounts).toEqual([account]);
   const kv=yield* KV.Service;expect(parseClaudeLifecycle(yield* kv.get('devryan.claude-lifecycle/1'))).toEqual(enrolled);
   expect((yield* Effect.exit(Effect.promise(()=>factory.readClaudeLifecycleOwned({controllerInstanceID:'foreign'}))))._tag).toBe('Failure');
   bound=false;expect((yield* Effect.exit(Effect.promise(()=>factory.readClaudeLifecycleOwned({controllerInstanceID:'controller-claude'}))))._tag).toBe('Failure');
  }).pipe(Effect.provide(layer),Effect.provideService(Location.Service,location))));
 }finally{await factory.close();await fs.rm(state,{recursive:true,force:true});}
});
