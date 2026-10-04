import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Effect,Exit,Schema} from 'effect';
import {Global} from '@opencode/util/global';
import {Database} from '@opencode/core/database/database';
import {Project} from '@opencode/core/project';
import {SessionStore} from '@opencode/core/session/store';
import {SessionProjector} from '@opencode/core/session/projector';
import {SessionInbox} from '@opencode/core/session/inbox';
import {SessionEvent} from '@opencode/schema/session-event';
import {SessionMessage} from '@opencode/core/session/message';
import {SessionSchema} from '@opencode/core/session/schema';
import {Bus} from '@opencode/core/bus';
import {AbsolutePath} from '@opencode/schema/schema';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {primaryStepOverride} from './primary-step.js';
import {assertQueuedInputIdle,isQueuedPrimaryInput,queuedPublicationWitnesses,wakeQueuedInputParents,QueuedInputWitnesses,type QueuedInputDependencies} from './native-queued-input.js';

const repo=path.resolve(import.meta.dir,'../../../../../..');
test('original native enqueue/delivery transactions fence busy/unknown descendants and recheck after PRE awaits',async()=>{
 const root=await fs.mkdtemp(path.join(repo,'.cache/v2-validation/native-queue-graph-'));
 const directory=path.join(root,'work');await fs.mkdir(directory);execFileSync('git',['init','--quiet'],{cwd:directory});
 const parentID=SessionSchema.ID.make('ses_queueParent'),childID=SessionSchema.ID.make('ses_queueChild');
 let dependencies:QueuedInputDependencies&{inbox:Pick<SessionInbox.Interface,'list'>}|undefined;
 let busy=false,unknown=false,race=false,selectionRace=false;let observedBus:Bus.Interface|undefined;
 const guard=primaryStepOverride(async()=>{throw Error('No inference');},inner=>Effect.sync(()=>{observedBus=inner;return inner;}),undefined,undefined,undefined,undefined,undefined,
  events=>Effect.gen(function*(){
   if(!dependencies)return [];
   const witnesses=yield* queuedPublicationWitnesses(dependencies,events);
   for(const witness of witnesses)yield* assertQueuedInputIdle(dependencies,witness,events.some(event=>event.type==='session.inbox.delivered')?'delivery':'enqueue');
   // Represents a child becoming active across an awaited constructor callback.
   if(race){yield* Effect.promise(()=>Promise.resolve());busy=true;}
   if(selectionRace&&events.some(event=>event.type==='session.inbox.delivered')){
    selectionRace=false;
    if(!observedBus)throw Error('Original bus missing');
    yield* observedBus.publish(SessionEvent.ModelSelected,Schema.decodeUnknownSync(SessionEvent.ModelSelected.data)({sessionID:parentID,model:{providerID:'fixture',id:'exact',variant:'high'}}));
   }
   return witnesses;
  }),event=>Effect.gen(function*(){
   const witnesses=yield* QueuedInputWitnesses,witness=witnesses.find(row=>row.messageID===event.data.inboxID);
   if(witness&&dependencies)yield* assertQueuedInputIdle(dependencies,witness,event.type==='session.inbox.enqueued'?'enqueue':'delivery');
  }));
 const group=LayerNode.group([Database.node,Project.node,SessionInbox.node,SessionStore.node,SessionProjector.node,Bus.node]);
 const layer=LayerNode.compile(group,{replacements:[Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),guard]});
 try{
 await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const bus=yield* Bus.Service,inbox=yield* SessionInbox.Service,store=yield* SessionStore.Service,database=yield* Database.Service;
  dependencies={store,inbox,database,execution:{isActive:id=>unknown&&id===childID?Effect.die(Error('Unavailable child state')):Effect.succeed(id===childID&&busy)}};
  const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(directory));
  for(const [sessionID,parent]of [[parentID,undefined],[childID,parentID]]as const)
   yield* bus.publish(SessionEvent.Created,Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,...parent?{parentID:parent}:{},projectID:project.id,location:{directory},slug:sessionID,agent:'orchestrator',model:{providerID:'fixture',id:'exact'},version:'2.0.20'}));
  const item=(delivery:'queue'|'steer')=>Schema.decodeUnknownSync(SessionInbox.Item)({type:'user',delivery,payload:{text:'exact',metadata:{devryan:{origin:'human',agent:'orchestrator',providerID:'fixture',modelID:'exact',variant:'default'}}}});
  expect(isQueuedPrimaryInput(item('queue'))).toBe(true);expect(isQueuedPrimaryInput(item('steer'))).toBe(false);
  // Original Session.prompt emits decoded optional keys with undefined values.
  const decodedNative=Schema.decodeUnknownSync(Schema.toType(SessionInbox.Item))({type:'user',delivery:'queue',payload:{text:'native acceptance',files:undefined,agents:undefined,metadata:{devryan:{origin:'native_acceptance'}}}});
  yield* inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_decodedNative'),item:decodedNative});
  yield* bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_decodedNative')});
  expect((yield* store.message(SessionMessage.ID.make('msg_decodedNative')))?.message.type).toBe('user');
  const decodedHuman=Schema.decodeUnknownSync(Schema.toType(SessionInbox.Item))({...item('queue'),payload:{...item('queue').payload,files:undefined,agents:undefined}});
  yield* inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_decodedHuman'),item:decodedHuman});
  expect((yield* inbox.list(parentID)).map(row=>row.id)).toEqual([SessionMessage.ID.make('msg_decodedHuman')]);
  yield* bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_decodedHuman')});
  expect((yield* store.message(SessionMessage.ID.make('msg_decodedHuman')))?.message.type).toBe('user');
  busy=true;
  const first=yield* Effect.exit(inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_busy'),item:item('queue')}));
  expect(Exit.isFailure(first)).toBe(true);expect(yield* inbox.list(parentID)).toHaveLength(0);
  busy=false;unknown=true;
  expect(Exit.isFailure(yield* Effect.exit(inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_unknown'),item:item('queue')})))).toBe(true);
  expect(yield* inbox.list(parentID)).toHaveLength(0);
  unknown=false;race=true;
  expect(Exit.isFailure(yield* Effect.exit(inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_race'),item:item('queue')})))).toBe(true);
  expect(yield* inbox.list(parentID)).toHaveLength(0);
  race=false;
  const command=Schema.decodeUnknownSync(SessionInbox.Item)({type:'user',delivery:'queue',payload:{text:'command',metadata:{devryan:{origin:'native',agent:'orchestrator',providerID:'fixture',modelID:'exact',variant:'default',command:{v:1,name:'reviewed'}}}}});
  expect(isQueuedPrimaryInput(command)).toBe(true);
  expect(Exit.isFailure(yield* Effect.exit(inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_commandBusy'),item:command})))).toBe(true);
  expect(yield* inbox.list(parentID)).toHaveLength(0);
  yield* inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_manual'),item:item('steer')});
  yield* bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_manual')});
  expect((yield* store.message(SessionMessage.ID.make('msg_manual')))?.message.type).toBe('user');
  busy=false;
  yield* inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_exact'),item:item('queue')});
  busy=true;
  expect(Exit.isFailure(yield* Effect.exit(bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_exact')})))).toBe(true);
  expect((yield* inbox.list(parentID)).map(row=>row.id)).toEqual([SessionMessage.ID.make('msg_exact')]);expect(yield* store.message(SessionMessage.ID.make('msg_exact'))).toBeUndefined();
  busy=false;unknown=true;
  expect(Exit.isFailure(yield* Effect.exit(bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_exact')})))).toBe(true);
  unknown=false;
  const wakes:string[]=[];
  busy=true;
  yield* wakeQueuedInputParents({...dependencies,execution:{...dependencies.execution,awaitIdle:()=>Effect.void}},childID,id=>Effect.sync(()=>{wakes.push(id)}));
  expect(wakes).toEqual([]);
  busy=false;
  yield* wakeQueuedInputParents({...dependencies,execution:{...dependencies.execution,awaitIdle:()=>Effect.void}},childID,id=>Effect.sync(()=>{wakes.push(id)}));
  expect(wakes).toEqual([parentID]);
  yield* bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_exact')});
  expect(yield* inbox.list(parentID)).toHaveLength(0);expect((yield* store.message(SessionMessage.ID.make('msg_exact')))?.message.type).toBe('user');
  yield* bus.publish(SessionEvent.ModelSelected,Schema.decodeUnknownSync(SessionEvent.ModelSelected.data)({sessionID:parentID,model:{providerID:'fixture',id:'exact',variant:'xhigh'}}));
  const inherited=Schema.decodeUnknownSync(SessionInbox.Item)({type:'user',delivery:'queue',payload:{text:'inherited',metadata:{devryan:{origin:'human',agent:'orchestrator',providerID:'fixture',modelID:'exact'}}}});
  yield* inbox.admit({sessionID:parentID,id:SessionMessage.ID.make('msg_inherited'),item:inherited});
  selectionRace=true;
  expect(Exit.isFailure(yield* Effect.exit(bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_inherited')})))).toBe(true);
  expect((yield* inbox.list(parentID)).map(row=>row.id)).toEqual([SessionMessage.ID.make('msg_inherited')]);
  yield* bus.publish(SessionEvent.ModelSelected,Schema.decodeUnknownSync(SessionEvent.ModelSelected.data)({sessionID:parentID,model:{providerID:'fixture',id:'exact',variant:'xhigh'}}));
  yield* bus.publish(SessionEvent.InboxDelivered,{sessionID:parentID,inboxID:SessionMessage.ID.make('msg_inherited')});
  expect((yield* store.message(SessionMessage.ID.make('msg_inherited')))?.message.type).toBe('user');

 })).pipe(Effect.provide(layer)));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
