import {afterEach,expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {SessionContext} from '@opencode/plugin/effect/session';
import {Location} from '@opencode/core/location';
import {Effect,Schema} from 'effect';
import {createReviewedSkillExecution} from '../../packages/web/server/lib/opencode/runtime-host/native-reviewed-skill-execution.ts';
import {appendNativeConfiguredInstructions} from '../../packages/web/server/lib/opencode/runtime-host/native-configured-instructions.ts';
import {WorkerInput} from '../../packages/web/server/lib/opencode/runtime-host/worker-protocol.ts';
import type {OwnedToolInvocation} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import type {NativeConfigurationSnapshot} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/reviewed-skill-'));roots.push(root);
 const file=path.join(root,'SKILL.md'),body='exact reviewed skill body\n';await fs.writeFile(file,body);
 const resource=path.join(root,'support.txt');await fs.writeFile(resource,'asset');
 const snapshot:NativeConfigurationSnapshot={schema:1,revision:1,sourceStamp:'a'.repeat(64),digest:'b'.repeat(64),registrationManifestDigest:'c'.repeat(64),locations:[{
  directory:root,configuration:{},skills:[{id:'reviewed-id',name:'Exact Skill',path:file,content:body,description:'saved',scope:'user',source:'opencode',bodySha256:createHash('sha256').update(body).digest('hex'),fileSha256:createHash('sha256').update(body).digest('hex'),fileSize:Buffer.byteLength(body),resources:[{relativePath:'support.txt',canonicalPath:resource,size:5,sha256:createHash('sha256').update('asset').digest('hex')}]}],aliases:[],activePlugins:[],
  instructions:[{path:path.join(root,'rules.md'),content:'instructions\n\n',sha256:'d'.repeat(64),size:14}],textReferences:[],
  compatibility:{legacy:{},agents:{},commands:{},slim:{},mcp:{}},requiredCatalogs:{agents:[],plugins:[],tools:[],models:[],skills:[],commands:[],mcp:[]}}]};
 const context=Schema.decodeUnknownSync(WorkerInput)({protocol:1,tool:'write',input:{},directory:root,projectDirectory:root,logicalDirectory:root,logicalProjectDirectory:root,scratchDirectory:root,config:{},context:{sessionID:'ses_fixture',agent:'build',messageID:'msg_fixture',id:'call_fixture'}}).context;
 const permissions:unknown[]=[],events:string[]=[];
 const invocation:OwnedToolInvocation={toolID:'skill',provenance:{kind:'native',id:'opencode.tool.skill',manifestDigest:'e'.repeat(64),capabilities:['read']},input:{id:'EXACT-SKILL'},location:Schema.decodeUnknownSync(Location.Info)({directory:root,project:{id:'global',directory:root,canonical:root}}),nativeContext:{...context,progress:()=>Effect.void},existingPermit:{token:'f'.repeat(64),revision:0,sessionID:context.sessionID},recheckPermit:()=>Effect.sync(()=>{events.push('permit');}),nativePermissionAssert:input=>Effect.sync(()=>{permissions.push(input);events.push('permission');}),executeNative:()=>Effect.die(new Error('ambient native scan must never run'))};
 const execute=createReviewedSkillExecution({snapshot,withDirectRead:(_invocation,action)=>Effect.gen(function*(){events.push('admit');return yield* action;}).pipe(Effect.ensuring(Effect.sync(()=>{events.push('finish');})))});
 return {root,file,snapshot,permissions,events,invocation,execute};
}
test('loads exact snapshot body via actual native formatter and fresh permission inside direct ledger fence',async()=>{
 const f=await fixture(),result=await Effect.runPromise(f.execute(f.invocation));
 expect(result.content).toContain('<skill_content name="Exact Skill">');expect(result.content).toContain('exact reviewed skill body');expect(result.content).toContain(`<file>${path.join(f.root,'support.txt')}</file>`);
 expect(f.permissions).toEqual([{action:'skill',resources:['reviewed-id'],save:['reviewed-id'],sessionID:'ses_fixture',agent:'build',source:{type:'tool',messageID:'msg_fixture',id:'call_fixture'}}]);
 expect(f.events).toEqual(['admit','permit','permission','permit','finish']);
});
test('refuses unknown origin, ambiguous/unreviewed IDs, extra input and modified resource bytes',async()=>{
 const f=await fixture();
 await expect(Effect.runPromise(f.execute({...f.invocation,provenance:{...f.invocation.provenance,kind:'plugin'}}))).rejects.toThrow('native_skill_registration_required');expect(f.events).toEqual([]);
 await expect(Effect.runPromise(f.execute({...f.invocation,input:{id:'unavailable'}}))).rejects.toThrow('native_skill_unreviewed');expect(f.events.at(-1)).toBe('finish');
 await expect(Effect.runPromise(f.execute({...f.invocation,input:{id:'reviewed-id',path:'/outside'}}))).rejects.toThrow('native_skill_input_invalid');
 await fs.writeFile(f.file,'changed reviewed body___\n');await expect(Effect.runPromise(f.execute(f.invocation))).rejects.toThrow('native_skill_resource_changed');expect(f.events.at(-1)).toBe('finish');
});
test('permission/hold refusal cannot produce a successful skill result and still settles direct owner',async()=>{
 const f=await fixture();
 await expect(Effect.runPromise(f.execute({...f.invocation,nativePermissionAssert:()=>Effect.die(new Error('permission denied'))}))).rejects.toThrow('permission denied');expect(f.events.at(-1)).toBe('finish');
 await expect(Effect.runPromise(f.execute({...f.invocation,recheckPermit:()=>Effect.die(new Error('session held'))}))).rejects.toThrow('session held');expect(f.events.at(-1)).toBe('finish');
});
test('configured context keeps exact separate instruction bytes and per-location scope',async()=>{
 const f=await fixture(),system:SessionContext['system']=[{type:'text',text:'original'}];
 appendNativeConfiguredInstructions(f.snapshot,f.root,system);expect(system).toEqual([{type:'text',text:'original'},{type:'text',text:'instructions\n\n'}]);
 expect(()=>appendNativeConfiguredInstructions(f.snapshot,'/unreviewed',system)).toThrow('native_instruction_location_unreviewed');expect(system).toHaveLength(2);
});
