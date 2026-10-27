import {expect,it} from 'vitest';
import {createNativeManagedPublicationReader,readManagedPublicationMessages} from './native-managed-publication-owner.js';

const input={sessionID:'ses_root',directory:'/project',messageID:'msg_review',permit:{token:'private'},nativeAttempt:{traceID:'a'.repeat(32),spanID:'b'.repeat(16)}};
const primary=()=>({directory:input.directory,stepID:input.messageID,anchorID:'msg_objective',cancellationGeneration:3,revision:4,nativeStepWitness:{attempt:input.nativeAttempt}});
it('publication scope captures actual primary Step/objective/generation and retains ordered canonical reader output',async()=>{
 const messages=[{info:{id:'msg_z'},parts:[]},{info:{id:'msg_a'},parts:[]}];let checks=0;
 const read=createNativeManagedPublicationReader({readConfiguration:()=>({controllerInstanceID:'controller',configurationDigest:'c'.repeat(64)}),
  recheckExecution:async()=>{checks++;},readPrimaryRecord:async()=>primary(),readMessages:async scope=>{expect(scope.sessionID).toBe(input.sessionID);return messages;}});
 const result=await read(input);expect(result.messages).toBe(messages);expect(result.identity).toMatchObject({objectiveID:'msg_objective',cancellationGeneration:3,stepID:'msg_review',attempt:input.nativeAttempt});
 expect(checks).toBe(2);
 await expect(read({...input,nativeAttempt:undefined})).rejects.toThrow('scope_expired');
 await expect(read({...input,nativeAttempt:{...input.nativeAttempt,spanID:'e'.repeat(16)}})).rejects.toThrow('scope_expired');
});
it.each(['configuration','controller','objective','generation','cancel','step'])('a %s change during canonical publication read cannot retain review authority',async change=>{
 let record=primary(),configuration={controllerInstanceID:'controller',configurationDigest:'c'.repeat(64)},revoked=false;
 const read=createNativeManagedPublicationReader({readConfiguration:()=>configuration,recheckExecution:async()=>{if(revoked)throw Error('revoked');},readPrimaryRecord:async()=>structuredClone(record),
  readMessages:async()=>{
   if(change==='configuration')configuration={...configuration,configurationDigest:'d'.repeat(64)};
   else if(change==='controller')configuration={...configuration,controllerInstanceID:'new'};
   else if(change==='cancel')revoked=true;
   else record={...record,revision:record.revision+1,...change==='objective'?{anchorID:'msg_unrelated'}:change==='generation'?{cancellationGeneration:4}:{stepID:'msg_other'}};
   return [];
  }});
 await expect(read(input)).rejects.toThrow(change==='cancel'?'revoked':'scope_expired');
});
it('reads only the required canonical window in a 2500-message session and preserves actual page order',async()=>{
 const rows=Array.from({length:2500},(_,index)=>({info:{id:`msg_${index}`,sessionID:input.sessionID,role:'assistant'},parts:[]}));
 let calls=0;
 const read=async(_input,{before,limit})=>{calls++;const end=before===undefined?rows.length:Number(before),start=Math.max(0,end-limit);
  return {records:rows.slice(start,end),cursor:start?String(start):null};};
 expect((await readManagedPublicationMessages(read,{...input,messageID:'msg_2499'},['msg_2498'])).map(row=>row.info.id)).toEqual(['msg_2498','msg_2499']);
 expect(calls).toBe(1);
 calls=0;expect((await readManagedPublicationMessages(read,{...input,messageID:'msg_2499'},['msg_2299'])).map(row=>row.info.id)).toEqual(['msg_2299','msg_2499']);
 expect(calls).toBe(2);
 await expect(readManagedPublicationMessages(read,{...input,messageID:'msg_2499'},['msg_0'])).rejects.toThrow('messages_limit');
});
it('missing or repeated canonical cursors and foreign records never establish publication',async()=>{
 await expect(readManagedPublicationMessages(async()=>({records:[],cursor:null}),input,[])).rejects.toThrow('scope_expired');
 await expect(readManagedPublicationMessages(async()=>({records:[],cursor:'same'}),input,[])).rejects.toThrow('scope_expired');
 await expect(readManagedPublicationMessages(async()=>({records:[{info:{id:input.messageID,sessionID:'foreign'},parts:[]}]}),input,[])).rejects.toThrow('scope_expired');
});
it('unique empty pages cannot extend the canonical publication read indefinitely',async()=>{
 let calls=0;
 await expect(readManagedPublicationMessages(async()=>({records:[],cursor:String(++calls)}),input,[])).rejects.toThrow('messages_limit');
 expect(calls).toBe(20);
});
it('each repeated publication check rereads canonical payloads and refuses newly revoked authority',async()=>{
 let output='first completed output',revoked=false,reads=0,primaryReads=0;
 const read=createNativeManagedPublicationReader({readConfiguration:()=>({controllerInstanceID:'controller',configurationDigest:'c'.repeat(64)}),
  recheckExecution:async()=>{if(revoked)throw Error('revoked');},readPrimaryRecord:async()=>{primaryReads++;return primary();},
  readMessages:async()=>{reads++;return [{info:{id:input.messageID},parts:[{type:'tool',state:{status:'completed',output}}]}];}});
 const first=await read(input);output='changed canonical output';const second=await read(input);
 expect(first.messages[0].parts[0].state.output).toBe('first completed output');
 expect(second.messages[0].parts[0].state.output).toBe(output);expect(reads).toBe(2);expect(primaryReads).toBe(4);
 revoked=true;await expect(read(input)).rejects.toThrow('revoked');expect(reads).toBe(2);
});
