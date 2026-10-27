import assert from 'node:assert/strict';
import {Effect,Exit,Fiber,Stream} from 'effect';
import {LLMClient} from '@opencode/ai';
import {Bus} from '@opencode/core/bus';
import {Snapshot} from '@opencode/core/snapshot';
import {ToolOutput} from '@opencode/core/tool-output';
import {SessionStep} from '@opencode/core/session/runner/step';
import {registerNativeFinalizationObservation} from '../../packages/web/server/lib/opencode/runtime-host/native-finalization-observation.ts';
const barrier=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),release:()=>resolve()};};
const results=[];
for(const mode of ['success','io-error','cancel']){
 const request={},events=[],tool=barrier(),toolStarted=barrier(),modelEnded=barrier(),io=barrier(),ioStarted=barrier();
 let committed=false,toolSettled=false,mandatoryPending=false;
 const original=Error('fixture mandatory IO failure');
 registerNativeFinalizationObservation(request,event=>Effect.sync(()=>{
  events.push({...event,toolSettled,mandatoryPending});
 }));
 const bus={publish:definition=>definition.type==='session.step.ended'?Effect.gen(function*(){
  mandatoryPending=true;ioStarted.release();
  return yield* Effect.promise(()=>io.promise).pipe(Effect.andThen(mode==='io-error'?Effect.die(original):Effect.sync(()=>{committed=true;})),
   Effect.ensuring(Effect.sync(()=>{mandatoryPending=false;})));
 }):Effect.void};
 const provider=[{type:'step-start'},{type:'tool-input-start',id:'call_fixture',name:'fixture'},
  {type:'tool-call',id:'call_fixture',name:'fixture',input:{}},{type:'step-finish',index:0,reason:{normalized:'stop'}}];
 const program=Effect.gen(function*(){const native=yield* SessionStep.make;return yield* native.attempt({
  sessionID:'ses_finalization',assistantMessageID:'msg_finalization',agent:'build',isLocationClosed:()=>false,
  model:{ref:{providerID:'fixture',id:'model'},model:{route:{},provider:'fixture'},cost:[]},
  prepared:{request,options:{},executeTool:()=>Effect.promise(async()=>{toolStarted.release();await tool.promise;toolSettled=true;return {content:[{type:'text',text:'bounded fixture result'}]};})},
  retry:()=>Effect.succeed({retry:false}),recoverContinuation:false,recoverOverflow:Effect.succeed(false)});
 }).pipe(Effect.provideService(Bus.Service,bus),Effect.provideService(LLMClient.Service,{stream:()=>Stream.fromIterable(provider).pipe(Stream.ensuring(Effect.sync(()=>modelEnded.release())))}),
 Effect.provideService(Snapshot.Service,{capture:()=>Effect.succeed(undefined)}),Effect.provideService(ToolOutput.Service,{truncate:Effect.succeed}));
 const fiber=Effect.runFork(program);try{await toolStarted.promise;await modelEnded.promise;
 assert.deepEqual(events,[],'Ended model alone cannot label unfinished tools Finalizing');
 tool.release();await ioStarted.promise;
 assert.ok(events.some(event=>event.phase==='finalizing'&&event.progress===0));assert.equal(committed,false);assert.equal(mandatoryPending,true);
 let interrupt;if(mode==='cancel')interrupt=Effect.runPromise(Fiber.interrupt(fiber));
 io.release();if(interrupt)await interrupt;
 const exit=await Effect.runPromise(Fiber.await(fiber));
 assert.equal(events.at(-1).phase,'cleared');assert.equal(events.at(-1).mandatoryPending,false);assert.equal(mandatoryPending,false);
 assert.ok(events.filter(event=>event.phase==='finalizing').every(event=>event.toolSettled),'Finalizing preceded native tool join');
 if(mode==='success'){assert.ok(Exit.isSuccess(exit));assert.equal(exit.value._tag,'Completed');assert.equal(committed,true);assert.ok(events.some(event=>event.progress===1));}
 if(mode==='io-error'){assert.ok(Exit.isFailure(exit));assert.ok(exit.cause.reasons.some(reason=>reason._tag==='Die'&&reason.defect===original));assert.equal(committed,false);}
 if(mode==='cancel'){assert.ok(Exit.hasInterrupts(exit));assert.equal(committed,true,'Native uninterruptible mandatory commit retains its original cancellation semantics');}
 results.push({mode,modelAndToolsSettledBeforePresentation:true,actualNativeMandatoryIOObserved:true,closedAfterIO:true});
 }finally{tool.release();io.release();await Effect.runPromise(Fiber.interrupt(fiber));}
}
process.stdout.write(JSON.stringify({status:'passed',results})+'\n');
