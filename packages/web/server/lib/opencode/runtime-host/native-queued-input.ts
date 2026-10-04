import {Context,Effect,Schema} from 'effect';
import {SessionInbox} from '@opencode/core/session/inbox';
import {SessionSchema} from '@opencode/core/session/schema';
import type {SessionStore} from '@opencode/core/session/store';
import type {SessionExecution} from '@opencode/core/session/execution';
import type {Database} from '@opencode/core/database/database';
import {HostRefusal,refuseHost} from './host-refusal.js';

export interface QueuedExecution {readonly agent:string;readonly providerID:string;readonly modelID:string;readonly variant:string}
export interface QueuedInputWitness {readonly execution?:QueuedExecution;readonly sessionID:string;readonly directory:string;readonly messageID:string;readonly item:typeof SessionInbox.Item.Type}
export const QueuedInputWitnesses=Context.Reference<readonly QueuedInputWitness[]>('DevRyan/QueuedInputWitnesses',{defaultValue:()=>[]});
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** Natural human FIFO sends opt in. Manual steer and native recovery/control inputs retain their contracts. */
export function isQueuedPrimaryInput(item:typeof SessionInbox.Item.Type):boolean {
 const metadata=item.type==='user'?item.payload.metadata:undefined;
 return item.type==='user'&&item.delivery==='queue'&&record(metadata)&&record(metadata.devryan)&&(metadata.devryan.origin==='human'||metadata.devryan.origin==='native'&&record(metadata.devryan.command)&&metadata.devryan.command.v===1);
}
export interface QueuedInputDependencies {readonly store:SessionStore.Interface;readonly database:Database.Interface;readonly execution:Pick<SessionExecution.Interface,'isActive'>}
const blocked=(id:string)=>refuseHost(new HostRefusal('native_queued_input_blocked',409,'queued.input.publish',id));
/** Called in the original enqueue/delivery transaction. Claims, pending input and
 * tree membership cannot change between this proof and the native projection commit.
 * The delivery's own root runner claim is allowed; no descendant claim is allowed. */
export function assertQueuedInputIdle(deps:QueuedInputDependencies,input:QueuedInputWitness,phase:'enqueue'|'delivery') {
 return Effect.gen(function*(){
  const all=yield* deps.store.list({limit:10001});
  if(all.length>10000)return yield* blocked(input.sessionID);
  const root=all.find(row=>row.id===input.sessionID);
  if(!root)return yield* blocked(input.sessionID);
  if(root.parentID)return;
  if(phase==='delivery'&&input.item.type==='user'){
   const metadata=input.item.payload.metadata?.devryan;
   if(!record(metadata)||root.agent!==metadata.agent||root.model?.providerID!==metadata.providerID||root.model?.id!==metadata.modelID||(metadata.variant!==undefined&&(root.model?.variant??'default')!==(metadata.variant??'default'))||!input.execution||root.agent!==input.execution.agent||root.model?.providerID!==input.execution.providerID||root.model?.id!==input.execution.modelID||(root.model?.variant??'default')!==input.execution.variant)return yield* blocked(input.sessionID);
  }
  const ids=new Set([root.id]);for(let changed=true;changed;){changed=false;for(const row of all)if(row.parentID&&ids.has(row.parentID)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
  const rows=all.filter(row=>ids.has(row.id));if(rows.length>512)return yield* blocked(input.sessionID);
  for(const row of rows){
   if(row.location.directory!==root.location.directory)return yield* blocked(input.sessionID);
   if(phase==='delivery'&&row.id===root.id)continue;
   const claim=yield* deps.database.db.$client.unsafe<{time_suspended:number|null}>('SELECT time_suspended FROM session_v2 WHERE id=?',[row.id]).pipe(Effect.orDie);
   const pending=yield* deps.database.db.$client.unsafe('SELECT 1 FROM session_pending WHERE session_id=? LIMIT 1',[row.id]).pipe(Effect.orDie);
   const queued=yield* deps.database.db.$client.unsafe('SELECT 1 FROM session_inbox WHERE session_id=? AND id<>? LIMIT 1',[row.id,row.id===root.id?input.messageID:'']).pipe(Effect.orDie);
   if(claim.length!==1||claim[0].time_suspended!==null||pending.length||queued.length||(yield* deps.execution.isActive(row.id)))return yield* blocked(input.sessionID);
  }
 }).pipe(Effect.catchDefect(error=>error instanceof HostRefusal?Effect.die(error):blocked(input.sessionID)));
}
export function queuedPublicationWitnesses(deps:QueuedInputDependencies&{readonly inbox:Pick<SessionInbox.Interface,'list'>},events:readonly {readonly type:string;readonly data:unknown}[]) {
 return Effect.gen(function*(){
  const result:QueuedInputWitness[]=[];
  for(const event of events){
   if(!record(event.data)||typeof event.data.sessionID!=='string'||typeof event.data.inboxID!=='string')continue;
   if(!['session.inbox.enqueued','session.inbox.delivered'].includes(event.type))continue;
   const data=event.data;
   // Bus events are original decoded values; optional fields may be present as undefined.
   // Inbox.list likewise returns decoded native Info values, not encoded payloads.
   const item=event.type==='session.inbox.enqueued'?Schema.decodeUnknownSync(Schema.toType(SessionInbox.Item))(data.item)
    :(yield* deps.inbox.list(SessionSchema.ID.make(event.data.sessionID))).find(row=>row.id===data.inboxID);
   if(!item||!isQueuedPrimaryInput(item))continue;
   const root=yield* deps.store.get(SessionSchema.ID.make(event.data.sessionID));if(!root)return yield* blocked(event.data.sessionID);if(root.parentID)continue;
   const execution=root.agent&&root.model?{agent:root.agent,providerID:root.model.providerID,modelID:root.model.id,variant:root.model.variant??'default'}:undefined;
   result.push({execution,directory:root.location.directory,sessionID:event.data.sessionID,messageID:event.data.inboxID,item});
  }
  return result;
 });
}

/** A terminal child event reuses the existing deferred execution wake. No
 * request authority is retained by this scoped observer. */
export function wakeQueuedInputParents(deps:QueuedInputDependencies&{readonly inbox:Pick<SessionInbox.Interface,'list'>;readonly execution:Pick<SessionExecution.Interface,'isActive'|'awaitIdle'>},id:string,notify:(sessionID:string)=>Effect.Effect<void>) {
 return Effect.gen(function*(){
  yield* deps.execution.awaitIdle(SessionSchema.ID.make(id));
  let current:string|undefined=id;const seen=new Set<string>();
  while(current){
   if(seen.has(current)||seen.size>=512)return;seen.add(current);
   const sessionID=SessionSchema.ID.make(current),row=yield* deps.store.get(sessionID);if(!row)return;
   const pending=yield* deps.inbox.list(sessionID),item=pending.find(isQueuedPrimaryInput);
   if(item&&!row.parentID){
    const quiet=yield* Effect.exit(assertQueuedInputIdle(deps,{directory:row.location.directory,sessionID,messageID:item.id,item},'enqueue'));
    if(quiet._tag==='Success')yield* notify(sessionID);
   }
   current=row.parentID??undefined;
  }
 });
}
