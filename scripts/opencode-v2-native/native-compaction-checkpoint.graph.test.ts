import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Effect,Schema} from 'effect';
import {Message} from '@opencode/ai';
import * as OpenAI from '@opencode/ai/providers/openai';
import {Global} from '@opencode/util/global';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Database} from '@opencode/core/database/database';
import {Project} from '@opencode/core/project';
import {SessionStore} from '@opencode/core/session/store';
import {SessionProjector} from '@opencode/core/session/projector';
import {SessionInbox} from '@opencode/core/session/inbox';
import {SessionHistory} from '@opencode/core/session/history';
import {SessionProviderContext} from '@opencode/core/session/provider-context';
import {SessionSchema} from '@opencode/core/session/schema';
import {SessionMessage} from '@opencode/core/session/message';
import {SessionEvent} from '@opencode/schema/session-event';
import {Model} from '@opencode/schema/model';
import {AbsolutePath} from '@opencode/schema/schema';
import {Bus} from '@opencode/core/bus';

// Real pinned projector/database/history; no fake history reader or copied
// compatibility predicate. This tests checkpoint replay, not provider inference.
test('native checkpoint history replays only the exact provider/model/endpoint and preserves the original local transcript',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..'),root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-checkpoint-switch-')));
 const directory=path.join(root,'project');await fs.mkdir(directory);execFileSync('git',['init','--quiet'],{cwd:directory});
 const layer=LayerNode.compile(LayerNode.group([Database.node,Project.node,SessionStore.node,SessionProjector.node,SessionInbox.node,Bus.node]),{
  replacements:[Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root}))],
 });
 const provenance=(providerID:string,modelID:string,baseURL:string)=>{
  const model=OpenAI.configure({baseURL}).responses(modelID);
  const selected=SessionProviderContext.provenance({model,ref:Schema.decodeUnknownSync(Model.Ref)({providerID,id:modelID})});
  if(!selected)throw Error('Pinned configured route lacks checkpoint provenance');return selected;
 };
 const source=provenance('owned','fixture-a','http://127.0.0.1:1/v1');
 const variants=[source,provenance('owned','fixture-b','http://127.0.0.1:1/v1'),provenance('other','fixture-a','http://127.0.0.1:1/v1'),provenance('owned','fixture-a','http://127.0.0.1:2/v1')];
 try {await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const bus=yield* Bus.Service,inbox=yield* SessionInbox.Service,database=yield* Database.Service;
  const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(directory)),sessionID=SessionSchema.ID.make('ses_checkpoint');
  yield* bus.publish(SessionEvent.Created,Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,projectID:project.id,location:{directory},slug:'checkpoint',agent:'build',model:{providerID:'owned',id:'fixture-a'},version:'2.0.32'}));
  const userID=SessionMessage.ID.make('msg_original');
  yield* inbox.admit({sessionID,id:userID,item:Schema.decodeUnknownSync(SessionInbox.Item)({type:'user',delivery:'queue',payload:{text:'Exact original objective'}})});
  yield* bus.publish(SessionEvent.InboxDelivered,{sessionID,inboxID:userID});
  const providerContext=SessionProviderContext.encode(source,[Message.assistant('Provider replacement window')]);
  yield* bus.publish(SessionEvent.Compaction.Started,{sessionID,reason:'manual',recent:''});
  yield* bus.publish(SessionEvent.Compaction.Ended,Schema.decodeUnknownSync(SessionEvent.Compaction.Ended.data)({sessionID,reason:'manual',model:{providerID:'owned',id:'fixture-a'},text:'',recent:'',providerContext}));
  const exact=yield* SessionHistory.load(database.db,sessionID,source);
  expect(exact).toHaveLength(1);expect(SessionProviderContext.isCheckpoint(exact[0])).toBe(true);
  if(exact[0].type!=='compaction'||exact[0].status!=='completed'||!exact[0].providerContext)throw Error('Actual native checkpoint missing');
  expect(SessionProviderContext.decode(exact[0].providerContext)).toEqual(SessionProviderContext.decode(providerContext));
  const original=yield* SessionHistory.load(database.db,sessionID,'local');
  expect(original.map(row=>row.id)).toEqual([userID]);expect(original[0]).toMatchObject({type:'user',text:'Exact original objective'});
  for(const target of variants.slice(1)){
   expect(SessionProviderContext.compatible(source,target)).toBe(false);
   expect(yield* SessionHistory.latestCompaction(database.db,sessionID,target)).toBeUndefined();
   expect(yield* SessionHistory.load(database.db,sessionID,target)).toEqual(original);
  }
  // Returning to the exact configured deployment can replay its original
  // native window; reading another route never mutates or destroys that proof.
  expect(yield* SessionHistory.load(database.db,sessionID,variants[0])).toEqual(exact);
  expect(yield* SessionHistory.load(database.db,sessionID,'latest')).toEqual(exact);
 })).pipe(Effect.provide(layer)));}finally{await fs.rm(root,{recursive:true,force:true});}
});
