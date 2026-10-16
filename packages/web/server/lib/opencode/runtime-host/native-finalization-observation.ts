import { Effect,Exit } from 'effect';

export interface NativeFinalizationIdentity { readonly sessionID:string; readonly assistantMessageID:string }
export interface NativeFinalizationMovement extends NativeFinalizationIdentity { readonly phase:'finalizing'|'cleared'; readonly progress:number }
type Observer=(movement:NativeFinalizationMovement)=>Effect.Effect<void>;
type PresentationSend=(signal:AbortSignal)=>Promise<unknown>;
/** One constructor-owned settlement interval; never an admission capability. */
export function createNativeFinalizationQueue(onClosed:()=>void) {
  const abort=new AbortController();
  const pending:PresentationSend[]=[];
  let tail:PresentationSend|undefined,running=false,terminal=false,closed=false;
  let resolveDone!:()=>void;
  const done=new Promise<void>(resolve=>{resolveDone=resolve;});
  const close=()=>{
    if(closed)return;closed=true;clearTimeout(timer);pending.length=0;tail=undefined;
    abort.abort();resolveDone();try{onClosed();}catch{/* Display cleanup cannot change native settlement. */}
  };
  // One original RPC budget for the entire interval, never one per queued mark.
  const timer=setTimeout(close,30_000);
  timer.unref?.();
  const pump=async()=>{
    if(running||closed)return;running=true;
    try{
      while(!closed){
        let send:PresentationSend|undefined;
        if(pending.length)send=pending.shift();else{send=tail;tail=undefined;}
        if(!send)break;
        try{await send(abort.signal);}catch{/* Missing presentation proof remains unknown. */}
      }
    }finally{
      running=false;
      if(!closed&&terminal&&pending.length===0&&!tail)close();
    }
  };
  return {
    done,
    abort:close,
    enqueue(send:PresentationSend,phase:NativeFinalizationMovement['phase']) {
      if(closed||terminal)return;
      terminal=phase==='cleared';
      if(tail||pending.length+Number(running)>=8)tail=send;else pending.push(send);
      void pump();
    },
  };
}
/** The existing ensuring owner retains its original exit. A pending or newly
 * delivered Stop aborts optional display I/O instead of waiting out its budget. */
export function drainNativeFinalizationQueue(queue:ReturnType<typeof createNativeFinalizationQueue>):Effect.Effect<void> {
  return Effect.uninterruptible(Effect.exit(Effect.interruptible(Effect.promise(()=>queue.done)))).pipe(
    Effect.tap(exit=>Exit.hasInterrupts(exit)?Effect.sync(queue.abort):Effect.void),Effect.asVoid);
}
const observers=new WeakMap<object,{observe:Observer;progress:number;active:boolean}>();
/** Constructor-private association; model/tool output cannot register a producer. */
export function registerNativeFinalizationObservation(request:object,observe:Observer):void {
  observers.set(request,{observe,progress:0,active:false});
}
const notify=(request:object,identity:NativeFinalizationIdentity,phase:'finalizing'|'cleared')=>Effect.suspend(()=>{
  const entry=observers.get(request);
  return entry?entry.observe({...identity,phase,progress:entry.progress}):Effect.void;
}).pipe(Effect.catchCause(()=>Effect.void));
/** SHA-guarded caller has naturally drained the model and joined every tool.
 * The original mandatory snapshot/Step.Ended effect owns this pending interval.
 * Observer failures cannot replace any save/cancellation outcome. */
export function observeNativeFinalization<A,E,R>(request:object,identity:NativeFinalizationIdentity,eligible:boolean,operation:Effect.Effect<A,E,R>):Effect.Effect<A,E,R> {
  return Effect.suspend(()=>{
    const entry=observers.get(request);
    if(!eligible||!entry)return operation;
    entry.active=true;entry.progress=0;
    return notify(request,identity,'finalizing').pipe(Effect.andThen(operation),Effect.ensuring(
      Effect.sync(()=>{entry.active=false;}).pipe(Effect.andThen(notify(request,identity,'cleared')))));
  });
}
/** Called after the ORIGINAL durable Step.Ended commit has completed. */
export function nativeFinalizationProgress(request:object,identity:NativeFinalizationIdentity):Effect.Effect<void> {
  return Effect.suspend(()=>{
    const entry=observers.get(request);if(!entry?.active)return Effect.void;
    entry.progress++;return notify(request,identity,'finalizing');
  });
}
