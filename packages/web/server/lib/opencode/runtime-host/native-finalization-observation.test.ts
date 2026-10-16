import {expect,test,vi} from 'vitest';
import {Effect,Fiber,Exit} from 'effect';
import {createNativeFinalizationQueue,drainNativeFinalizationQueue,observeNativeFinalization,nativeFinalizationProgress,registerNativeFinalizationObservation} from './native-finalization-observation.js';
const identity={sessionID:'ses_pending',assistantMessageID:'msg_assistant'};
test('constructor witness retains pending mandatory IO and only actual completion moves progress',async()=>{
 const request={},events:unknown[]=[];let release!:()=>void,entered!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 registerNativeFinalizationObservation(request,event=>Effect.sync(()=>{events.push({...event});}));
 const operation=Effect.promise(()=>{entered();return barrier;}).pipe(Effect.andThen(nativeFinalizationProgress(request,identity)),Effect.as('committed'));
 const running=Effect.runPromise(observeNativeFinalization(request,identity,true,operation));await started;
 expect(events).toEqual([{...identity,phase:'finalizing',progress:0}]);release();expect(await running).toBe('committed');
 expect(events).toEqual([{...identity,phase:'finalizing',progress:0},{...identity,phase:'finalizing',progress:1},{...identity,phase:'cleared',progress:1}]);
});
test('unknown/unsuccessful model proof never activates; observer errors preserve the original IO result and error',async()=>{
 const request={},events:unknown[]=[];registerNativeFinalizationObservation(request,event=>Effect.sync(()=>{events.push(event);throw Error('display failed');}));
 expect(await Effect.runPromise(observeNativeFinalization({},identity,true,Effect.succeed('unknown')))).toBe('unknown');
 expect(await Effect.runPromise(observeNativeFinalization(request,identity,false,Effect.succeed('ineligible')))).toBe('ineligible');expect(events).toEqual([]);
 expect(await Effect.runPromise(observeNativeFinalization(request,identity,true,Effect.succeed('saved')))).toBe('saved');
 const original=Error('exact IO failure');const exit=await Effect.runPromiseExit(observeNativeFinalization(request,identity,true,Effect.fail(original)));
 expect(Exit.isFailure(exit)).toBe(true);if(Exit.isFailure(exit))expect(exit.cause.reasons.some(reason=>reason._tag==='Fail'&&reason.error===original)).toBe(true);
});
test('cancellation closes the presentation and retains the interrupted native outcome',async()=>{
 const request={},events:unknown[]=[];let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 registerNativeFinalizationObservation(request,event=>Effect.sync(()=>{events.push(event);}));
 const fiber=Effect.runFork(observeNativeFinalization(request,identity,true,Effect.sync(entered).pipe(Effect.andThen(Effect.never))));await started;
 await Effect.runPromise(Fiber.interrupt(fiber));const exit=await Effect.runPromise(Fiber.await(fiber));expect(Exit.hasInterrupts(exit)).toBe(true);
 expect(events).toEqual([{...identity,phase:'finalizing',progress:0},{...identity,phase:'cleared',progress:0}]);
});
test('one original interval survives an empty queue and drains its terminal pressure tail',async()=>{
 const sent:number[]=[];let release!:()=>void,closed=0;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 const queue=createNativeFinalizationQueue(()=>{closed++;});
 queue.enqueue(async()=>{sent.push(0);await barrier;},'finalizing');
 for(let i=1;i<=20;i++)queue.enqueue(async()=>{sent.push(i);},'finalizing');
 queue.enqueue(async()=>{sent.push(21);},'cleared');
 release();await queue.done;expect(sent).toEqual([0,1,2,3,4,5,6,7,21]);expect(closed).toBe(1);
 const quiet=createNativeFinalizationQueue(()=>{}),marks:string[]=[];
 quiet.enqueue(async()=>{marks.push('begin');},'finalizing');await Promise.resolve();await Promise.resolve();
 let settled=false;void quiet.done.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
 quiet.enqueue(async()=>{marks.push('progress');},'finalizing');quiet.enqueue(async()=>{marks.push('clear');},'cleared');
 await quiet.done;expect(marks).toEqual(['begin','progress','clear']);
});
test('the first-enqueue deadline aborts in-flight IO, drops unsent marks and cannot reopen',async()=>{
 vi.useFakeTimers();try{
 const sent:number[]=[];let signal:AbortSignal|undefined,closed=0;
 const queue=createNativeFinalizationQueue(()=>{closed++;});
 queue.enqueue(input=>{signal=input;sent.push(0);return new Promise(resolve=>input.addEventListener('abort',()=>resolve(undefined),{once:true}));},'finalizing');
 await vi.advanceTimersByTimeAsync(20_000);
 queue.enqueue(async()=>{sent.push(1);},'finalizing');queue.enqueue(async()=>{sent.push(2);},'cleared');
 await vi.advanceTimersByTimeAsync(9999);expect(signal?.aborted).toBe(false);expect(closed).toBe(0);
 await vi.advanceTimersByTimeAsync(1);await queue.done;expect(signal?.aborted).toBe(true);expect(sent).toEqual([0]);expect(closed).toBe(1);
 queue.enqueue(async()=>{sent.push(3);},'finalizing');queue.enqueue(async()=>{sent.push(4);},'cleared');
 await vi.advanceTimersByTimeAsync(30_000);expect(sent).toEqual([0]);expect(closed).toBe(1);
 }finally{vi.useRealTimers();}
});
test('a terminal mark replaces the pressure tail even after queue capacity becomes available',async()=>{
 const sent:number[]=[];let first!:()=>void,second!:()=>void,entered!:()=>void;
 const firstBarrier=new Promise<void>(resolve=>{first=resolve;}),secondBarrier=new Promise<void>(resolve=>{second=resolve;}),secondStarted=new Promise<void>(resolve=>{entered=resolve;});
 const queue=createNativeFinalizationQueue(()=>{});
 queue.enqueue(async()=>{sent.push(0);await firstBarrier;},'finalizing');
 queue.enqueue(async()=>{sent.push(1);entered();await secondBarrier;},'finalizing');
 for(let i=2;i<=20;i++)queue.enqueue(async()=>{sent.push(i);},'finalizing');
 first();await secondStarted;
 queue.enqueue(async()=>{sent.push(21);},'finalizing');queue.enqueue(async()=>{sent.push(22);},'cleared');second();await queue.done;
 expect(sent).toEqual([0,1,2,3,4,5,6,7,22]);
});
test('replacement aborts only its old interval and a delayed old clear cannot affect the new queue',async()=>{
 let oldSignal:AbortSignal|undefined,newSignal:AbortSignal|undefined;
 const old=createNativeFinalizationQueue(()=>{}),next=createNativeFinalizationQueue(()=>{});
 old.enqueue(signal=>{oldSignal=signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(undefined),{once:true}));},'finalizing');
 old.abort();await old.done;
 next.enqueue(async signal=>{newSignal=signal;},'finalizing');
 old.enqueue(async()=>{throw Error('Expired interval reopened');},'cleared');
 expect(oldSignal?.aborted).toBe(true);expect(newSignal?.aborted).toBe(false);
 next.enqueue(async()=>{},'cleared');await next.done;
});
for(const late of [false,true])test(`terminal observation cancels promptly with ${late?'new':'already pending'} interruption and preserves the native exit`,async()=>{
 let release!:()=>void,entered!:()=>void,draining!:()=>void;const request={};
 const operation=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),terminal=new Promise<void>(resolve=>{draining=resolve;});
 const queue=createNativeFinalizationQueue(()=>{});let signal:AbortSignal|undefined;
 registerNativeFinalizationObservation(request,event=>{
   queue.enqueue(input=>{signal=input;return new Promise(resolve=>input.addEventListener('abort',()=>resolve(undefined),{once:true}));},event.phase);
   return event.phase==='cleared'?Effect.sync(draining).pipe(Effect.andThen(drainNativeFinalizationQueue(queue))):Effect.void;
 });
 const fiber=Effect.runFork(observeNativeFinalization(request,identity,true,Effect.promise(()=>{entered();return operation;})));
 await started;if(late){release();await terminal;}
 await Effect.runPromise(Fiber.interrupt(fiber));const exit=await Effect.runPromise(Fiber.await(fiber));
 expect(signal?.aborted).toBe(true);expect(Exit.hasInterrupts(exit)).toBe(true);
});
test('optional queue refusal preserves the exact mandatory IO failure and saved success',async()=>{
 for(const failure of [false,true]){
   const queue=createNativeFinalizationQueue(()=>{}),request={},original=Error('original save failure');
   registerNativeFinalizationObservation(request,event=>{queue.enqueue(async()=>{throw Error('optional display refused');},event.phase);return event.phase==='cleared'?drainNativeFinalizationQueue(queue):Effect.void;});
   const exit=await Effect.runPromiseExit(observeNativeFinalization(request,identity,true,failure?Effect.fail(original):Effect.succeed('saved')));
   if(failure){expect(Exit.isFailure(exit)).toBe(true);if(Exit.isFailure(exit))expect(exit.cause.reasons.some(reason=>reason._tag==='Fail'&&reason.error===original)).toBe(true);}
   else{expect(Exit.isSuccess(exit)).toBe(true);if(Exit.isSuccess(exit))expect(exit.value).toBe('saved');}
 }
});
