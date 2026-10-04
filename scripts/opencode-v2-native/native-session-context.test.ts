import {expect,test} from 'bun:test';
import {Effect,Schema} from 'effect';
import {Location} from '@opencode/core/location';
import {Model} from '@opencode/schema/model';
import {Agent} from '@opencode/schema/agent';
import {Session} from '@opencode/schema/session';
import type {PluginHooks} from '@opencode/core/plugin/hooks';
import {createNativeSessionContext,nativeTodoSchema} from '../../packages/web/server/lib/opencode/runtime-host/native-session-context.js';
import {OperationPermitRef} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
const location=Schema.decodeUnknownSync(Location.Info)({directory:'/reviewed/project',project:{id:'global',directory:'/reviewed/project',canonical:'/reviewed/project'}});
const origin={kind:'plugin',id:'devryan.harness-context',manifestDigest:'c'.repeat(64),capabilities:['control']} as const;
test('TODO schema is the exact native ordered list, without caller scope/role authority',()=>{
 const input={todos:[{id:'one',content:'Verify',status:'in_progress',priority:'high'}]} as const;
 expect(Schema.decodeUnknownSync(nativeTodoSchema)(input,{onExcessProperty:'error'})).toEqual(input);
 expect(()=>Schema.decodeUnknownSync(nativeTodoSchema)({...input,sessionID:'other'},{onExcessProperty:'error'})).toThrow();
});
test('final compaction hook preserves prior hook changes and appends only a bounded host anchor',async()=>{
 const seen:Readonly<Record<string,unknown>>[]=[];
 const factory=createNativeSessionContext({origin,executeOwned:()=>Effect.die(Error('unreviewed')),rpc:async(_method,input)=>{seen.push(input);return {available:true,text:'[devryan-compaction-anchor:v1]\nOwned original objective'};}});
 const inner:PluginHooks.Interface={has:()=>Effect.succeed(false),register:()=>Effect.die(Error('not called')),
  trigger:(_domain,_name,event)=>Effect.sync(()=>{const payload:unknown=event;if(payload!==null&&typeof payload==='object'&&'system' in payload&&Array.isArray(payload.system))payload.system.push({type:'text',text:'Earlier reviewed hook'});return event;})};
 const event={sessionID:Session.ID.make('ses_owned'),agent:Agent.ID.make('builder'),model:Schema.decodeUnknownSync(Model.Ref)({providerID:'owned',id:'fixture'}),system:[{type:'text' as const,text:'Native system'}],messages:[],options:{},tools:{}};
 const hooks=factory.decorateHooks(inner,location);
 await Effect.runPromise(hooks.trigger('session','compaction',event).pipe(Effect.provideService(OperationPermitRef,{token:'private',revision:2,sessionID:'ses_owned'})));
 expect(event.system.map(part=>part.text)).toEqual(['Native system','Earlier reviewed hook','[devryan-compaction-anchor:v1]\nOwned original objective']);
 expect(seen).toEqual([{directory:'/reviewed/project',sessionID:'ses_owned',phase:'compaction',permit:{token:'private',revision:2,sessionID:'ses_owned'}}]);
 await expect(Effect.runPromise(hooks.trigger('session','compaction',event))).rejects.toThrow('native_context_permit_required');
});
