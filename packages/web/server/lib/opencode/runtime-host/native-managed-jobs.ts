import { Deferred, Effect, Fiber, Scope } from 'effect';
import type { Job } from '@opencode/core/job';
import { SessionSchema } from '@opencode/core/session/schema';
import { SessionMessage } from '@opencode/core/session/message';
import { SessionInbox } from '@opencode/core/session/inbox';
import type { SessionStore } from '@opencode/core/session/store';
import type { SessionExecution } from '@opencode/core/session/execution';
import type { OperationPermit } from './native-admission-contract.js';
import { runControllerEffect } from './controller-effects.js';
import { HostRefusal } from './host-refusal.js';

export interface NativeManagedJobTask {
  readonly taskId:string; readonly leaseToken:string; readonly rootSessionId:string; readonly directory:string; readonly sessionID:string;
  readonly providerId:string; readonly modelId:string; readonly agent:string; readonly variant:string|null;
}
export interface NativeManagedJobIdentity { readonly jobID:string; readonly notificationID:string; readonly messageID:string }
export interface NativeManagedJobInput extends NativeManagedJobTask, NativeManagedJobIdentity { readonly envelopeID?:string }
export interface NativeManagedJobCancellation extends NativeManagedJobTask { readonly segments:readonly NativeManagedJobIdentity[] }
export type NativeManagedJobPhase = 'prepare'|'activate'|'cancelSegment'|'cancelTask'|'acknowledge';
export interface NativeManagedJobReceipt extends NativeManagedJobIdentity { readonly status:Job.Status|'absent' }
interface Services {
  readonly jobs:Job.Interface; readonly store:SessionStore.Interface;
  readonly inbox:Pick<ContextInbox,'list'|'cancel'>; readonly execution:SessionExecution.Interface; readonly scope:Scope.Scope;
}
type ContextInbox = import('effect').Context.Service.Shape<typeof SessionInbox.Service>;
type Waiter = Fiber.Fiber<void, unknown> | null;
interface Prepared {
  readonly identity:string; readonly launch:Deferred.Deferred<Waiter>; activated:boolean;
}
const identity=(input:NativeManagedJobInput)=>JSON.stringify([input.taskId,input.leaseToken,input.rootSessionId,input.directory,input.sessionID,
  input.providerId,input.modelId,input.agent,input.variant,input.messageID,input.jobID,input.notificationID]);
const refuse=(code:string)=>new HostRefusal(code,409,'job.managed');

/** Native Job owns each accepted-input segment; the existing managed classifier owns its task result. */
export function createNativeManagedJobs(options:{
  readonly services:()=>Services;
  readonly guard:<A,E>(phase:NativeManagedJobPhase,input:NativeManagedJobInput|NativeManagedJobCancellation,
    permit:OperationPermit,action:Effect.Effect<A,E>)=>Effect.Effect<A,E>;
  readonly recheck:(phase:NativeManagedJobPhase,input:NativeManagedJobInput,permit:OperationPermit)=>Effect.Effect<void>;
}) {
  const prepared=new Map<string,Prepared>();
  const tails=new Map<string,Promise<unknown>>();
  const serialized=<A>(sessionID:string,action:()=>Promise<A>):Promise<A>=>{
    const pending=(tails.get(sessionID)??Promise.resolve()).catch(()=>{}).then(action);
    tails.set(sessionID,pending);
    void pending.finally(()=>{if(tails.get(sessionID)===pending)tails.delete(sessionID);}).catch(()=>{});
    return pending;
  };
  const run=<A,E>(phase:NativeManagedJobPhase,input:NativeManagedJobInput|NativeManagedJobCancellation,
    permit:OperationPermit,action:Effect.Effect<A,E>)=>runControllerEffect(options.guard(phase,input,permit,action));
  const marker=Effect.fnUntraced(function*(input:NativeManagedJobInput){
    const {jobs}=options.services();
    const pending=yield* jobs.pendingBackground;
    const byID=pending.filter(item=>item.id===input.jobID||item.notificationID===input.notificationID);
    if(byID.some(item=>item.id!==input.jobID||item.notificationID!==input.notificationID||item.recovery.kind!=='subagent'
      ||item.recovery.childSessionID!==input.sessionID||item.recovery.parentSessionID!==input.rootSessionId
      ||item.recovery.agent!==input.agent||item.recovery.description!==input.taskId))return yield* Effect.die(refuse('native_managed_job_identity_changed'));
    return byID[0];
  });
  const receipt=(input:NativeManagedJobInput,status:NativeManagedJobReceipt['status']):NativeManagedJobReceipt=>
    ({jobID:input.jobID,notificationID:input.notificationID,messageID:input.messageID,status});
  const cancel=Effect.fnUntraced(function*(input:NativeManagedJobInput){
    const {jobs}=options.services();
    yield* marker(input);
    const current=yield* jobs.get(input.jobID);
    if(current&&(current.notificationID!==input.notificationID||current.metadata?.messageID!==input.messageID
      ||current.metadata?.taskId!==input.taskId))return yield* Effect.die(refuse('native_managed_job_identity_changed'));
    const cancelled=yield* jobs.cancel(input.jobID);
    return receipt(input,cancelled?.status??'absent');
  });
  const discardQueued=Effect.fnUntraced(function*(input:NativeManagedJobInput){
    const {inbox}=options.services(),sessionID=SessionSchema.ID.make(input.sessionID),id=SessionMessage.ID.make(input.messageID);
    const pending=(yield* inbox.list(sessionID)).find(item=>item.id===id);
    if(!pending)return;
    if(pending.sessionID!==sessionID||pending.type!=='user')return yield* Effect.die(refuse('native_managed_job_input_unaccepted'));
    // Native cancel owns its inbox mutex. A concurrent promotion refuses this
    // cleanup rather than allowing a terminal receipt to discard live work.
    yield* inbox.cancel({sessionID,id});
  });
  return {
    prepare:(input:NativeManagedJobInput,permit:OperationPermit)=>serialized(input.sessionID,()=>run('prepare',input,permit,Effect.gen(function*(){
      const {jobs,store}=options.services();
      let existing=prepared.get(input.jobID);
      if(existing&&existing.identity!==identity(input))return yield* Effect.die(refuse('native_managed_job_identity_changed'));
      const durable=yield* marker(input);
      if(!existing&&((yield* jobs.get(input.jobID))||durable))return yield* Effect.die(refuse('native_managed_job_replay_forbidden'));
      if(!existing){
        existing={identity:identity(input),launch:yield* Deferred.make<Waiter>(),activated:false};
        prepared.set(input.jobID,existing);
      }
      if(!(yield* jobs.get(input.jobID))){
        const child=yield* store.get(SessionSchema.ID.make(input.sessionID));
        if(child?.parentID!==input.rootSessionId||child.location.directory!==input.directory)return yield* Effect.die(refuse('native_managed_job_child_invalid'));
        const launch=existing.launch;
        yield* jobs.start({id:input.jobID,type:'subagent',title:input.taskId,notificationID:SessionMessage.ID.make(input.notificationID),
          metadata:{taskId:input.taskId,messageID:input.messageID},
          recovery:{kind:'subagent',parentSessionID:child.parentID,childSessionID:child.id,agent:input.agent,description:input.taskId},
          run:Deferred.await(launch).pipe(Effect.flatMap(waiter=>waiter?Fiber.join(waiter):Effect.void),Effect.as(''))});
      }
      // The provider cannot receive the input until this native durable marker exists.
      const background=yield* jobs.background(input.jobID);
      if(!background||background.notificationID!==input.notificationID)return yield* Effect.die(refuse('native_managed_job_background_missing'));
      return receipt(input,background.status);
    }))),
    activate:(input:NativeManagedJobInput,permit:OperationPermit)=>serialized(input.sessionID,()=>run('activate',input,permit,Effect.gen(function*(){
      const {jobs,store,inbox,execution,scope}=options.services(),entry=prepared.get(input.jobID);
      if(!entry||entry.identity!==identity(input)||!(yield* marker(input)))return yield* Effect.die(refuse('native_managed_job_preparation_missing'));
      const current=yield* jobs.get(input.jobID);
      if(!current||current.status!=='running')return receipt(input,current?.status??'absent');
      if(!entry.activated){
        const id=SessionSchema.ID.make(input.sessionID),messageID=SessionMessage.ID.make(input.messageID);
        const waiter=yield* SessionInbox.serialized(id,Effect.gen(function*(){
          // Lock contention must not preserve a task grant revoked while waiting.
          yield* options.recheck('activate',input,permit);
          const message=yield* store.message(messageID),queued=(yield* inbox.list(id)).find(item=>item.id===messageID);
          if(message&&(message.sessionID!==id||message.message.type!=='user')||queued&&(queued.sessionID!==id||queued.type!=='user')
            ||!message&&!queued)return yield* Effect.die(refuse('native_managed_job_input_unaccepted'));
          const active=yield* execution.isActive(id);
          // A queued input needs pendingWake even when a previous segment's runner is active.
          if(queued)yield* execution.wake(id);
          if(queued||active)return yield* execution.resume(id).pipe(Effect.forkIn(scope,{startImmediately:true}));
          const following=yield* store.messages({sessionID:id,cursor:{id:messageID,direction:'next'},order:'asc',limit:1});
          if(following[0]?.type==='assistant'&&following[0].time.completed!==undefined)return null;
          if(following.length)return yield* Effect.die(refuse('native_managed_job_input_superseded'));
          return yield* execution.resume(id).pipe(Effect.forkIn(scope,{startImmediately:true}));
        }));
        entry.activated=true;
        yield* Deferred.succeed(entry.launch,waiter);
      }
      return receipt(input,(yield* jobs.get(input.jobID))?.status??'absent');
    }))),
    cancelSegment:(input:NativeManagedJobInput,permit:OperationPermit)=>serialized(input.sessionID,()=>run('cancelSegment',input,permit,Effect.gen(function*(){
      const {store}=options.services(),entry=prepared.get(input.jobID);
      // An input promoted out of the inbox is durable activation evidence that
      // survives a controller restart, unlike this process's latch entry.
      if(entry?.activated||(yield* store.message(SessionMessage.ID.make(input.messageID))))return yield* Effect.die(refuse('native_managed_job_already_activated'));
      const cancelled=yield* cancel(input);
      // Cancelling the Job interrupts its latched run; resolving the latch
      // instead would complete it with '' and could notify the parent. A
      // refused cancel keeps the entry, which the replay guard depends on.
      prepared.delete(input.jobID);
      return cancelled;
    }))),
    cancelTask:(input:NativeManagedJobCancellation,permit:OperationPermit)=>serialized(input.sessionID,()=>run('cancelTask',input,permit,Effect.gen(function*(){
      const {execution}=options.services(),id=SessionSchema.ID.make(input.sessionID);
      yield* execution.interrupt(id);
      yield* execution.awaitIdle(id).pipe(Effect.timeout('30 seconds'));
      if(yield* execution.isActive(id))return yield* Effect.die(refuse('native_settlement_uncertain'));
      for(const segment of input.segments){
        yield* discardQueued({...input,...segment});yield* cancel({...input,...segment});prepared.delete(segment.jobID);
      }
      if(yield* execution.isActive(id))return yield* Effect.die(refuse('native_settlement_uncertain'));
      return {aborted:true as const};
    }))),
    acknowledge:(input:NativeManagedJobInput,permit:OperationPermit)=>serialized(input.sessionID,()=>run('acknowledge',input,permit,Effect.gen(function*(){
      const {jobs,execution}=options.services();
      yield* marker(input);
      if(yield* execution.isActive(SessionSchema.ID.make(input.sessionID)))return yield* Effect.die(refuse('native_managed_job_unsettled'));
      const current=yield* jobs.get(input.jobID);
      if(current?.status==='running'){
        yield* cancel(input);
      }
      yield* discardQueued(input);
      if(yield* execution.isActive(SessionSchema.ID.make(input.sessionID)))return yield* Effect.die(refuse('native_managed_job_unsettled'));
      yield* jobs.completeBackground(SessionMessage.ID.make(input.notificationID));
      prepared.delete(input.jobID);
      return receipt(input,'absent');
    }))),
  };
}
