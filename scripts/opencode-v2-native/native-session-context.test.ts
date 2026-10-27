import {expect,test} from 'bun:test';
import {Effect,Schema} from 'effect';
import {Message} from '@opencode/ai/effect';
import {Location} from '@opencode/core/location';
import {Model} from '@opencode/schema/model';
import {Agent} from '@opencode/schema/agent';
import {Session} from '@opencode/schema/session';
import type {PluginHooks} from '@opencode/core/plugin/hooks';
import {createNativeSessionContext,nativeTodoSchema} from '../../packages/web/server/lib/opencode/runtime-host/native-session-context.js';
import {OperationPermitRef} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
const location=Schema.decodeUnknownSync(Location.Info)({directory:'/reviewed/project',project:{id:'global',directory:'/reviewed/project',canonical:'/reviewed/project'}});
const origin={kind:'plugin',id:'devryan.harness-context',manifestDigest:'c'.repeat(64),capabilities:['control']} as const;
const permit={token:'private',revision:2,sessionID:'ses_owned'};
test('TODO schema is the exact native ordered list, without caller scope/role authority',()=>{
 const input={todos:[{id:'one',content:'Verify',status:'in_progress',priority:'high'}]} as const;
 expect(Schema.decodeUnknownSync(nativeTodoSchema)(input,{onExcessProperty:'error'})).toEqual(input);
 expect(()=>Schema.decodeUnknownSync(nativeTodoSchema)({...input,sessionID:'other'},{onExcessProperty:'error'})).toThrow();
});
for(const preserveSystemCache of [true,false])test(`final compaction hook preserves prior hook changes and appends only a bounded host anchor (cache preserved: ${preserveSystemCache})`,async()=>{
 const seen:Readonly<Record<string,unknown>>[]=[];
 const factory=createNativeSessionContext({origin,preserveSystemCache,executeOwned:()=>Effect.die(Error('unreviewed')),rpc:async(_method,input)=>{seen.push(input);return {available:true,text:'[devryan-compaction-anchor:v1]\nOwned original objective'};}});
 const inner:PluginHooks.Interface={has:()=>Effect.succeed(false),register:()=>Effect.die(Error('not called')),
  trigger:(_domain,_name,event)=>Effect.sync(()=>{const payload:unknown=event;if(payload!==null&&typeof payload==='object'&&'system' in payload&&Array.isArray(payload.system))payload.system.push({type:'text',text:'Earlier reviewed hook'});return event;})};
 const history=Message.user('Owned history');
 const event={sessionID:Session.ID.make('ses_owned'),agent:Agent.ID.make('builder'),model:Schema.decodeUnknownSync(Model.Ref)({providerID:'owned',id:'fixture'}),system:[{type:'text' as const,text:'Native system'}],messages:[history],options:{},tools:{}};
 const hooks=factory.decorateHooks(inner,location);
 await Effect.runPromise(hooks.trigger('session','compaction',event).pipe(Effect.provideService(OperationPermitRef,permit)));
 if(preserveSystemCache){
  // The anchor follows the whole history as a system update; the system prefix is untouched.
  expect(event.system.map(part=>part.text)).toEqual(['Native system','Earlier reviewed hook']);
  expect(event.messages).toHaveLength(2);expect(event.messages[0]).toBe(history);
  expect(event.messages[1]).toEqual(Message.system('[devryan-compaction-anchor:v1]\nOwned original objective'));
 }else{
  expect(event.system.map(part=>part.text)).toEqual(['Native system','Earlier reviewed hook','[devryan-compaction-anchor:v1]\nOwned original objective']);
  expect(event.messages).toEqual([history]);
 }
 expect(seen).toEqual([{directory:'/reviewed/project',sessionID:'ses_owned',phase:'compaction',permit}]);
 await expect(Effect.runPromise(hooks.trigger('session','compaction',event))).rejects.toThrow('native_context_permit_required');
});


test('adaptive capability context is opt-in and appended after the cached history', async () => {
 const previous=process.env.DEVRYAN_ADAPTIVE_DELEGATION, seen:Readonly<Record<string,unknown>>[]=[];
 const factory=createNativeSessionContext({origin,executeOwned:()=>Effect.die(Error('unreviewed')),rpc:async(_method,input)=>{seen.push(input);return {available:true,text:'[devryan-runtime-capabilities:v1]\n{"browser":{"previewReady":false}}'};}});
 const inner:PluginHooks.Interface={has:()=>Effect.succeed(false),register:()=>Effect.die(Error('not called')),trigger:(_domain,_name,event)=>Effect.succeed(event)};
 const hooks=factory.decorateHooks(inner,location),history=Message.user('Owned history');
 const event={sessionID:Session.ID.make('ses_owned'),agent:Agent.ID.make('builder'),model:Schema.decodeUnknownSync(Model.Ref)({providerID:'owned',id:'fixture'}),system:[{type:'text' as const,text:'Native system'}],messages:[history],options:{},tools:{}};
 try {
  process.env.DEVRYAN_ADAPTIVE_DELEGATION='0'; await Effect.runPromise(hooks.trigger('session','context',event).pipe(Effect.provideService(OperationPermitRef,permit)));
  expect(seen).toHaveLength(0);expect(event.messages).toEqual([history]);
  process.env.DEVRYAN_ADAPTIVE_DELEGATION='1'; await Effect.runPromise(hooks.trigger('session','context',event).pipe(Effect.provideService(OperationPermitRef,permit)));
  expect(seen).toEqual([{directory:'/reviewed/project',sessionID:'ses_owned',phase:'context',permit}]);
  expect(event.system).toEqual([{type:'text',text:'Native system'}]);expect(event.messages[0]).toBe(history);
  expect(event.messages[1]).toEqual(Message.system('[devryan-runtime-capabilities:v1]\n{"browser":{"previewReady":false}}'));
 } finally { if(previous===undefined)delete process.env.DEVRYAN_ADAPTIVE_DELEGATION;else process.env.DEVRYAN_ADAPTIVE_DELEGATION=previous; }
});
