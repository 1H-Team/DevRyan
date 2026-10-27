import { Context, Effect } from 'effect';
import { Event } from '@opencode/schema/event';
import { SessionEvent } from '@opencode/schema/session-event';
import { EventTable, EventSequenceTable } from '@opencode/core/event/sql';
import type { Database } from '@opencode/core/database/database';

/** Private local PRE observation, scoped to the one original Bus transaction. */
export interface RecoveredCancellationWitness {
 readonly sessionID:string;readonly inboxID:string;readonly enqueuedSeq:number;
 readonly type:string;readonly delivery:string;readonly payloadHash:string;readonly instanceID:string;
}
export const RecoveredCancellationWitnesses = Context.Reference<readonly RecoveredCancellationWitness[]>(
 'DevRyan/RecoveredCancellationWitnesses',{defaultValue:()=>[]});
export const RECOVERED_CANCELLATION_RECEIPT_TYPE='devryan.recovered-input.cancelled@1';
/** Original Bus projector: receipt and original inbox deletion commit or roll back together. */
export const persistRecoveredCancellation = (database:Database.Interface,event:typeof SessionEvent.InboxCancelled.Type)=>Effect.gen(function*(){
 const witnesses=yield* RecoveredCancellationWitnesses;
 const witness=witnesses.find(row=>row.sessionID===event.data.sessionID&&row.inboxID===event.data.inboxID);
 if(!witness)return;
 if(!event.durable||event.durable.aggregateID!==witness.sessionID||event.durable.version!==1
   ||!Number.isSafeInteger(event.durable.seq)||event.durable.seq<=witness.enqueuedSeq)throw Error('native_recovered_input_receipt_invalid');
 // A separate operational aggregate avoids collisions when the original Bus also persists its native event.
 const aggregateID=`${witness.sessionID}:recovered-input-cancellation`;
 yield* database.db.insert(EventSequenceTable).values({aggregate_id:aggregateID,seq:event.durable.seq}).onConflictDoUpdate({target:EventSequenceTable.aggregate_id,set:{seq:event.durable.seq}}).run().pipe(Effect.orDie);
 yield* database.db.insert(EventTable).values({id:Event.ID.make(`${event.id}:recovered-input`),aggregate_id:aggregateID,
  seq:event.durable.seq,created:event.created??0,type:RECOVERED_CANCELLATION_RECEIPT_TYPE,
  data:{version:1,...witness,nativeEvent:{id:event.id,type:event.type,version:event.durable.version,aggregateID:event.durable.aggregateID,seq:event.durable.seq}}}).run().pipe(Effect.orDie);
});

export const dropRecoveredCancellationReceipts=(database:Database.Interface,event:typeof SessionEvent.Deleted.Type)=>
 database.db.$client.unsafe('DELETE FROM event_sequence WHERE aggregate_id=?',[`${event.data.sessionID}:recovered-input-cancellation`]).pipe(Effect.orDie,Effect.asVoid);
