import {Schema} from 'effect';
import {SessionInbox} from '@opencode/schema/session-inbox';
import {bundleFailure,sha256,canonicalJSON} from './bundle-migration-inventory.js';
import {recoveredInputHash} from './native-recovered-input-hash.js';
const LIMIT=128;const fail=code=>{throw bundleFailure(code);};
const eventData=row=>{if(typeof row.data!=='string')fail('native_recovered_input_limit');return JSON.parse(row.data);};
const decodeItem=value=>Schema.decodeUnknownSync(Schema.toEncoded(SessionInbox.Item))(value,{onExcessProperty:'error'});
/** Original accepted encoding, with delivery changes before the selected boundary. */
export function nativeInputEnqueue(db,input,before=Number.MAX_SAFE_INTEGER){
 const events=db.all(`SELECT seq,CASE WHEN length(CAST(data AS BLOB))<=1048576+4096 THEN data ELSE NULL END AS data FROM event WHERE aggregate_id=? AND type='session.inbox.enqueued.1' AND seq=?`,[input.sessionID,input.enqueuedSeq]);
 if(events.length!==1)return null;
 const data=eventData(events[0]);if(data.sessionID!==input.sessionID||data.inboxID!==input.messageID)return null;
 let item=decodeItem(data.item);
 const changes=db.all(`SELECT seq,CASE WHEN length(CAST(data AS BLOB))<=1048576+4096 THEN data ELSE NULL END AS data FROM event WHERE aggregate_id=? AND type='session.inbox.delivery.changed.1' AND seq>? AND seq<? AND json_extract(data,'$.inboxID')=? ORDER BY seq LIMIT 129`,[input.sessionID,input.enqueuedSeq,before,input.messageID]);
 if(changes.length>LIMIT)fail('native_recovered_input_limit');
 for(const row of changes){const change=eventData(row);if(change.inboxID===input.messageID&&change.sessionID===input.sessionID)item=decodeItem({...item,delivery:change.delivery});}
 return item;
}
/** Correlate cancellation after exact accepted encoding; absence alone proves nothing. */
export function nativeInputCancellation(db,input) {
 if(db.all('SELECT id FROM session_inbox WHERE id=?',[input.messageID]).length||db.all('SELECT id FROM session_message WHERE id=?',[input.messageID]).length)return null;
 const receipts=db.all(`SELECT id,aggregate_id,seq,created,CASE WHEN length(CAST(data AS BLOB))<=4096 THEN data ELSE NULL END AS data FROM event WHERE aggregate_id=? AND type='devryan.recovered-input.cancelled@1' AND seq>? AND json_extract(data,'$.inboxID')=? ORDER BY seq DESC LIMIT 129`,[`${input.sessionID}:recovered-input-cancellation`,input.enqueuedSeq,input.messageID]);
 if(receipts.length>LIMIT)fail('native_recovered_input_limit');
 for(const row of receipts){const receipt=eventData(row),native=receipt.nativeEvent;
  if(receipt.version!==1||receipt.sessionID!==input.sessionID||receipt.inboxID!==input.messageID
   ||receipt.enqueuedSeq!==input.enqueuedSeq||receipt.payloadHash!==input.payloadHash||receipt.type!==input.type||receipt.delivery!==input.delivery)continue;
  if(!native||native.type!=='session.inbox.cancelled'||native.version!==1||native.aggregateID!==input.sessionID
   ||native.seq!==row.seq||!Number.isSafeInteger(row.seq)||row.seq<=input.enqueuedSeq||typeof native.id!=='string'
   ||row.id!==`${native.id}:recovered-input`||!native.id||native.id.includes('\0')||native.id.length>256
   ||!Number.isSafeInteger(row.created)||row.created<0||typeof receipt.instanceID!=='string'||!receipt.instanceID||receipt.instanceID.includes('\0')||receipt.instanceID.length>256
   ||Object.keys(receipt).sort().join(',')!=='delivery,enqueuedSeq,inboxID,instanceID,nativeEvent,payloadHash,sessionID,type,version'
   ||Object.keys(native).sort().join(',')!=='aggregateID,id,seq,type,version')return null;
  return {eventID:native.id,seq:row.seq,receiptSha256:sha256(canonicalJSON(row))};
 }
 return null;
}
