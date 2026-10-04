import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {KV} from '@opencode/core/kv';
import {Database} from '@opencode/core/database/database';
import {Global} from '@opencode/util/global';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Effect,Logger} from 'effect';
import {readNativeClaudeLifecycle,transitionNativeClaudeLifecycle} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle-kv.ts';
import {CLAUDE_LIFECYCLE_KEY,type ClaudeLifecycleAccount} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
const account:ClaudeLifecycleAccount={profileID:'selected',service:'Claude Code-credentials-01234567',configDirectory:'/owned/enrolled/one',enrollmentID:'enrollment-one',generation:'generation-one',recordFingerprint:'1'.repeat(64),grantFingerprint:'2'.repeat(64)};
const fixture=async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/claude-lifecycle-kv-'));
 const layer=LayerNode.compile(LayerNode.group([KV.node,Database.node]),{replacements:[
  Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),
  Database.node.replace(Database.configured({path:path.join(root,'native.db')})),
 ]});
 return {root,run:<A,E>(effect:Effect.Effect<A,E,KV.Service|Database.Service>)=>Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer),Effect.provide(Logger.layer([],{mergeWithExisting:false})))))};
};
test('original KV transaction persists authority and refuses stale revision after independent service recreation',async()=>{
 const f=await fixture();try{
  expect((await f.run(readNativeClaudeLifecycle())).revision).toBe(0);
  const enrolled=await f.run(transitionNativeClaudeLifecycle(0,{kind:'enroll',account},()=>{}));
  expect(await f.run(readNativeClaudeLifecycle())).toEqual(enrolled);
  expect((await f.run(Effect.exit(transitionNativeClaudeLifecycle(0,{kind:'begin',account,attemptID:'stale'},()=>{}))))._tag).toBe('Failure');
  expect(await f.run(readNativeClaudeLifecycle())).toEqual(enrolled);
  const pending=await f.run(transitionNativeClaudeLifecycle(enrolled.revision,{kind:'begin',account,attemptID:'pending'},()=>{}));
  expect((await f.run(readNativeClaudeLifecycle())).unresolved).toEqual(pending.unresolved);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('revoked final commit rolls back KV and malformed durable state cannot silently reset',async()=>{
 const f=await fixture();try{
  let checks=0;expect((await f.run(Effect.exit(transitionNativeClaudeLifecycle(0,{kind:'enroll',account},()=>{if(++checks===2)throw new Error('revoked');}))))._tag).toBe('Failure');
  expect((await f.run(readNativeClaudeLifecycle())).revision).toBe(0);
  await f.run(Effect.gen(function*(){const kv=yield* KV.Service;yield* kv.set(CLAUDE_LIFECYCLE_KEY,{protocol:'unknown',revision:0});}));
  expect((await f.run(Effect.exit(readNativeClaudeLifecycle())))._tag).toBe('Failure');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
