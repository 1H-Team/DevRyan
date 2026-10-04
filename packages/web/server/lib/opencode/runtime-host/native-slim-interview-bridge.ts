import path from 'node:path';
import type * as ReviewedSlim from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
export interface NativeSlimInterviewBridgeOwners extends Omit<ReviewedSlim.ReviewedSlimInterviewBridgeOwner,'assertAcceptedCommand'> {
 readonly assertCurrent:(event:unknown)=>Promise<void>;
 readonly assertAcceptedCommand:(input:{readonly directory:string;readonly sessionID:string;readonly messageID:string;readonly args:string;readonly event:unknown})=>Promise<void>;
}
/** Original native bridge caches/algorithms; authority and state-machine IO are existing host owners. */
export function createOwnedSlimInterviewBridge(input:{readonly originals:typeof ReviewedSlim;readonly directory:string;readonly owners:NativeSlimInterviewBridgeOwners}){
 if(!path.isAbsolute(input.directory)||path.resolve(input.directory)!==input.directory)throw new Error('native_slim_interview_location_invalid');
 if(typeof input.owners.assertCurrent!=='function'||typeof input.owners.assertAcceptedCommand!=='function')throw new Error('native_slim_interview_owner_required');
 const bridge=input.originals.createReviewedSlimInterviewBridge({...input.owners,assertAcceptedCommand:proof=>input.owners.assertAcceptedCommand({...proof,directory:input.directory})});
 const checked=async(event:unknown,action:()=>Promise<void>)=>{await input.owners.assertCurrent(event);try{await action();}finally{await input.owners.assertCurrent(event);}};
 return {...bridge,handleContext:(event:unknown)=>checked(event,()=>bridge.handleContext(event)),handleEvent:(event:unknown)=>checked(event,()=>bridge.handleEvent(event))};
}
