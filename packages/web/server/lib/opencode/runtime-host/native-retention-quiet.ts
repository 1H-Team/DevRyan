import {DateTime,Effect} from 'effect';
import {SessionInbox} from '@opencode/core/session/inbox';
import {SessionSchema} from '@opencode/core/session/schema';
import type {SessionStore} from '@opencode/core/session/store';
import type {SessionExecution} from '@opencode/core/session/execution';
import type {Session} from '@opencode/core/session';
import type {Database} from '@opencode/core/database/database';
import {HostRefusal,refuseHost} from './host-refusal.js';
import type {OperationPermit} from './native-admission-contract.js';
export interface NativeRetentionMember {readonly id:string;readonly parentID:string|null;readonly directory:string;readonly time:{readonly created:number;readonly updated:number;readonly archived?:number};readonly metadata?:Readonly<Record<string,unknown>>;readonly share?:unknown}
export interface QuietRetentionDependencies {
 readonly store:SessionStore.Interface;readonly database:Database.Interface;readonly execution:Pick<SessionExecution.Interface,'isActive'>;readonly session:Pick<Session.Interface,'setMetadata'>;
 readonly authorize:(permit:OperationPermit,members:readonly NativeRetentionMember[],acquire:boolean)=>Promise<void>;
}
const refuse=(code:string,id:string)=>refuseHost(new HostRefusal(code,409,'retention.acquire',id));
/** The original inbox locks and SQLite transaction exclude promotion/claims.
 * Node authorization is a ledger/policy read only: never a child HTTP call. */
export function quietNativeRetention(deps:QuietRetentionDependencies, input:{readonly sessionID:string;readonly permit:OperationPermit;readonly at?:number}){
 const tree=Effect.gen(function*(){
  const all=yield* deps.store.list({limit:10001});if(all.length>10000)return yield* refuse('native_retention_tree_unbounded',input.sessionID);
  const ids=new Set([input.sessionID]);for(let changed=true;changed;){changed=false;for(const row of all)if(row.parentID&&ids.has(row.parentID)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
  const rows=all.filter(row=>ids.has(row.id));if(!rows.length||rows.length>512)return yield* refuse('native_retention_tree_changed',input.sessionID);
  return rows;
 });
 return Effect.gen(function*(){
  const initial=yield* tree;
  const work=deps.database.db.$client.withTransaction(Effect.gen(function*(){
   const rows=yield* tree;
   if(JSON.stringify(rows.map(row=>row.id).sort())!==JSON.stringify(initial.map(row=>row.id).sort()))return yield* refuse('native_retention_tree_changed',input.sessionID);
   for(const row of rows){
    const claims=yield* deps.database.db.$client.unsafe<{time_suspended:number|null}>('SELECT time_suspended FROM session_v2 WHERE id=?',[row.id]).pipe(Effect.orDie);
    const pending=yield* deps.database.db.$client.unsafe('SELECT 1 FROM session_pending WHERE session_id=? LIMIT 1',[row.id]).pipe(Effect.orDie);
    const queued=yield* deps.database.db.$client.unsafe('SELECT 1 FROM session_inbox WHERE session_id=? LIMIT 1',[row.id]).pipe(Effect.orDie);
    if(claims.length!==1||claims[0].time_suspended!==null||pending.length||queued.length||(yield* deps.execution.isActive(row.id)))return yield* refuse('native_retention_session_active',row.id);
   }
   const members:NativeRetentionMember[]=rows.map(row=>{const devryan=row.metadata?.devryan;const archived=devryan&&typeof devryan==='object'&&!Array.isArray(devryan)&&'archive' in devryan?devryan.archive:undefined;const owned=archived&&typeof archived==='object'&&!Array.isArray(archived)&&'sessionID' in archived&&'at' in archived&&archived.sessionID===row.id;const archive=owned?archived.at:row.time.archived?DateTime.toEpochMillis(row.time.archived):undefined;return {id:row.id,parentID:row.parentID??null,directory:row.location.directory,time:{created:DateTime.toEpochMillis(row.time.created),updated:DateTime.toEpochMillis(row.time.updated),...(typeof archive==='number'?{archived:archive}:{})},metadata:row.metadata};});
   yield* Effect.tryPromise(()=>deps.authorize(input.permit,members,input.at===undefined)).pipe(Effect.orDie);
   if(input.at!==undefined){
    if(!Number.isSafeInteger(input.at)||input.at<=0)return yield* refuse('native_retention_scope_invalid',input.sessionID);
    // Publish every member atomically, preserving native metadata. No execution
    // or cancellation service is called by automatic archival.
    for(const row of rows){const metadata=row.metadata??{},devryan=metadata.devryan;
     yield* deps.session.setMetadata({sessionID:row.id,metadata:{...metadata,devryan:{...(devryan&&typeof devryan==='object'&&!Array.isArray(devryan)?devryan:{}),archive:{sessionID:row.id,at:input.at}}}}).pipe(Effect.orDie);
    }
   }
   return {held:true as const,archived:input.at!==undefined,members};
  })).pipe(Effect.orDie);
  let serialized=work;for(const id of initial.map(row=>row.id).sort().reverse())serialized=SessionInbox.serialized(SessionSchema.ID.make(id),serialized);
  return yield* serialized;
 });
}
