export interface NativeCompactionBudget {
 readonly auto:boolean;readonly buffer:number|null;readonly keep:number;readonly ceiling:number|null;readonly budget:number;
 readonly estimatePrompt:{readonly measured:number;readonly estimated:number};readonly estimateContext:number;
 readonly limits:{readonly context:number;readonly input:number|null;readonly output:number};
 readonly anchorIndex:number;readonly checkpointIndex:number;readonly stateRevision:number;readonly due:boolean;
}
const registrations=new WeakMap<object,(snapshot:NativeCompactionBudget)=>void>();
/** Private scoped observation only. The actual trigger is never copied or made authority. */
export function registerNativeCompactionObservation(trigger:object,observe:(snapshot:NativeCompactionBudget)=>void):()=>void {
 if(registrations.has(trigger))throw new Error('native_compaction_observer_duplicate');
 registrations.set(trigger,observe);let active=true;
 return ()=>{if(active){active=false;registrations.delete(trigger);}};
}
/** Called only by the SHA-guarded insertion after the ORIGINAL budget calculation. */
export function observeNativeCompactionBudget(trigger:object,snapshot:NativeCompactionBudget):void {
 try{registrations.get(trigger)?.(Object.freeze({...snapshot,estimatePrompt:Object.freeze({...snapshot.estimatePrompt}),limits:Object.freeze({...snapshot.limits})}));}
 catch{/* Evidence failure cannot modify the native compaction decision. */}
}
