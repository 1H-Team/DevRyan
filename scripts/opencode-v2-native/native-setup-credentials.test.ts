import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Credential} from '@opencode/core/credential';
import {Database} from '@opencode/core/database/database';
import {KV} from '@opencode/core/kv';
import {Global} from '@opencode/util/global';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Effect} from 'effect';
import {bootstrapNativeSetupCredentials,NATIVE_SETUP_CREDENTIAL_STAMP} from '../../packages/web/server/lib/opencode/runtime-host/native-setup-credentials.ts';
test('Windows seed transaction retains its input for host CAS and validates SHA/count before activation and on lost-ACK retry',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/setup-credentials-')),seedPath=path.join(root,'native-setup-credentials.json');
 try{
  const layer=LayerNode.compile(LayerNode.group([Credential.node,KV.node,Database.node]),{replacements:[Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),Database.node.replace(Database.configured({path:path.join(root,'native.db')}))]});
  const bytes=JSON.stringify({schema:1,credentials:[{integrationID:'openai',value:{type:'key',key:'isolated-fixture-key'}}]});await fs.writeFile(seedPath,bytes);
  const expected={sha256:createHash('sha256').update(bytes).digest('hex'),count:1};
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
   const credentials=yield* Credential.Service,kv=yield* KV.Service;
   const rejected=yield* Effect.exit(bootstrapNativeSetupCredentials({seedPath,expected:{...expected,count:2},platform:'win32'}));
   expect(rejected._tag).toBe('Failure');expect((yield* credentials.all()).length).toBe(0);expect(yield* kv.get(NATIVE_SETUP_CREDENTIAL_STAMP)).toBeUndefined();
   expect(yield* bootstrapNativeSetupCredentials({seedPath,expected,platform:'win32'})).toEqual({status:'applied',...expected});
   yield* Effect.promise(async()=>expect(await fs.readFile(seedPath,'utf8')).toBe(bytes));
   expect(yield* bootstrapNativeSetupCredentials({seedPath,expected,platform:'win32'})).toEqual({status:'already-applied',...expected});
   yield* kv.set(NATIVE_SETUP_CREDENTIAL_STAMP,{schema:1,sha256:expected.sha256,count:0});
   const invalidStamp=yield* Effect.exit(bootstrapNativeSetupCredentials({seedPath,expected,platform:'win32'}));expect(invalidStamp._tag).toBe('Failure');expect((yield* credentials.all()).length).toBe(1);
  }).pipe(Effect.provide(layer))));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('original native credential activation and setup stamp commit once; later selections survive restart',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/setup-credentials-')),seedPath=path.join(root,'native-setup-credentials.json');
 try{
  const layer=LayerNode.compile(LayerNode.group([Credential.node,KV.node,Database.node]),{replacements:[Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),Database.node.replace(Database.configured({path:path.join(root,'native.db')}))]});
  const seed={schema:1,credentials:[{integrationID:'openai',label:'Imported account',value:{type:'key',key:'isolated-fixture-key'}}]};await fs.writeFile(seedPath,JSON.stringify(seed));
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
   const credentials=yield* Credential.Service,kv=yield* KV.Service;
   expect((yield* credentials.all()).length).toBe(0);
   expect(yield* bootstrapNativeSetupCredentials({seedPath})).toEqual({status:'applied',count:1});
   const [created]=yield* credentials.all();expect(created.label).toBe('Imported account');
   expect(yield* kv.get(NATIVE_SETUP_CREDENTIAL_STAMP)).toMatchObject({schema:1,count:1});
   yield* credentials.update(created.id,{label:'Changed by current owner'});
   expect(yield* bootstrapNativeSetupCredentials({seedPath})).toEqual({status:'already-applied',count:1});
   yield* Effect.promise(()=>fs.writeFile(seedPath,JSON.stringify(seed)));
   expect(yield* bootstrapNativeSetupCredentials({seedPath})).toEqual({status:'already-applied',count:1});
   expect((yield* credentials.all()).length).toBe(1);expect((yield* credentials.get(created.id))?.label).toBe('Changed by current owner');
  }).pipe(Effect.provide(layer))));
  expect(await fs.stat(seedPath).catch(error=>error.code)).toBe('ENOENT');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('failed setup activation rolls back both original credentials and stamp, then retries exactly once',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/setup-credentials-')),seedPath=path.join(root,'native-setup-credentials.json');
 try{
  const layer=LayerNode.compile(LayerNode.group([Credential.node,KV.node,Database.node]),{replacements:[Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),Database.node.replace(Database.configured({path:path.join(root,'native.db')}))]});
  await fs.writeFile(seedPath,JSON.stringify({schema:1,credentials:[{integrationID:'openai',value:{type:'key',key:'isolated-fixture-key'}},{integrationID:'github-copilot',value:{type:'oauth',methodID:'device',access:'',refresh:'isolated-fixture-refresh',expires:0}}]}));
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
   const credentials=yield* Credential.Service,kv=yield* KV.Service;let writes=0;
   const failing:Credential.Interface={...credentials,create:input=>Effect.suspend(()=>++writes===2?Effect.die(new Error('fixture_second_activation_failed')):credentials.create(input))};
   const failed=yield* Effect.exit(bootstrapNativeSetupCredentials({seedPath}).pipe(Effect.provideService(Credential.Service,failing)));
   expect(failed._tag).toBe('Failure');expect((yield* credentials.all()).length).toBe(0);expect(yield* kv.get(NATIVE_SETUP_CREDENTIAL_STAMP)).toBeUndefined();
   expect(yield* bootstrapNativeSetupCredentials({seedPath})).toEqual({status:'applied',count:2});expect((yield* credentials.all()).length).toBe(2);
  }).pipe(Effect.provide(layer))));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
