import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Effect,Exit,Schema,Scope} from 'effect';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Global} from '@opencode/util/global';
import {Bus} from '@opencode/core/bus';
import {Database} from '@opencode/core/database/database';
import {Job} from '@opencode/core/job';
import {Project} from '@opencode/core/project';
import {SessionInbox} from '@opencode/core/session/inbox';
import {SessionProjector} from '@opencode/core/session/projector';
import {SessionStore} from '@opencode/core/session/store';
import {SessionEvent} from '@opencode/core/session/event';
import {SessionSchema} from '@opencode/core/session/schema';
import {SessionMessage} from '@opencode/core/session/message';
import {SessionRunCoordinator} from '@opencode/core/session/run-coordinator';
import {AbsolutePath} from '@opencode/schema/schema';
import {createNativeManagedJobs,type NativeManagedJobInput} from './native-managed-jobs.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
async function fixture(run:(input:{directory:string;jobs:Job.Interface;adapter:ReturnType<typeof createNativeManagedJobs>;restart:()=>ReturnType<typeof createNativeManagedJobs>;
  segment:NativeManagedJobInput;admit:()=>Promise<void>;finish:()=>void;started:Promise<void>;setHold:(hold:boolean)=>void;
  startOld:()=>Promise<void>;pendingInputIDs:()=>Promise<string[]>;counts:()=>{starts:number;drains:number;wakes:number};cancelSettled:Promise<void>;releaseCleanup:()=>void;holdCleanup:()=>void})=>Promise<void>){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-native-managed-jobs-'))),directory=path.join(root,'project');
  await fs.mkdir(directory);execFileSync('git',['init','--quiet'],{cwd:directory});
  const layer=LayerNode.compile(LayerNode.group([Job.node,SessionInbox.node,SessionStore.node,SessionProjector.node,Bus.node,Database.node,Project.node]),
    {replacements:[Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root}))]});
  const started=deferred(),finish=deferred(),cancelSettled=deferred(),cleanup=deferred();let hold=false,cleanupHeld=false,starts=0,drains=0,wakes=0;
  try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
    const bus=yield* Bus.Service,store=yield* SessionStore.Service,inbox=yield* SessionInbox.Service,jobs=yield* Job.Service,
      database=yield* Database.Service,scope=yield* Scope.Scope;
    const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(directory));
    const rootID=SessionSchema.ID.make('ses_managed_root'),childID=SessionSchema.ID.make('ses_managed_child');
    for(const sessionID of [rootID,childID])yield* bus.publish(SessionEvent.Created,Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,
      projectID:project.id,location:{directory},slug:'managed-job',version:'2.2.6',agent:'fixer',model:{providerID:'fixture',id:'saved'},...(sessionID===childID?{parentID:rootID}:{})}));
    const coordinator=yield* SessionRunCoordinator.make<SessionSchema.ID,never,'user'>({started:()=>Effect.sync(()=>{starts++;}),
      drain:id=>Effect.gen(function*(){drains++;started.resolve();if(hold){yield* Effect.promise(()=>finish.promise);return;}
        yield* SessionInbox.promote(database.db,bus,id,'input');}),
      settled:(_id,exit)=>Exit.isFailure(exit)?Effect.sync(()=>cancelSettled.resolve()).pipe(
        Effect.andThen(Effect.suspend(()=>cleanupHeld?Effect.promise(()=>cleanup.promise):Effect.void))):Effect.void});
    const execution={active:coordinator.active,isActive:coordinator.isActive,resume:coordinator.run,
      wake:(id:SessionSchema.ID)=>Effect.sync(()=>{wakes++;}).pipe(Effect.andThen(coordinator.wake(id))),
      interrupt:(id:SessionSchema.ID)=>coordinator.interrupt(id,'user'),awaitIdle:coordinator.awaitIdle};
    // A restarted controller rebuilds the adapter over the same durable stores.
    const restart=()=>createNativeManagedJobs({services:()=>({jobs,store,inbox,execution,scope}),guard:(_phase,_input,_permit,action)=>action,recheck:()=>Effect.void});
    const adapter=restart();
    const segment:NativeManagedJobInput={taskId:'dvr_task_job',leaseToken:'lease_one',rootSessionId:rootID,directory,sessionID:childID,
      providerId:'fixture',modelId:'saved',agent:'fixer',variant:null,messageID:'msg_managed_input',jobID:'devryan_subagent_one',notificationID:'msg_managed_notice'};
    yield* Effect.promise(()=>run({directory,jobs,adapter,restart,segment,admit:()=>Effect.runPromise(inbox.admit({sessionID:childID,id:SessionMessage.ID.make(segment.messageID),
      item:{type:'user',delivery:'steer',payload:Schema.decodeUnknownSync(SessionInbox.UserPayload)({text:'Assigned work'})}})).then(()=>{}),
      finish:finish.resolve,started:started.promise,setHold:value=>{hold=value;},startOld:()=>Effect.runPromise(coordinator.wake(childID)),
      pendingInputIDs:()=>Effect.runPromise(inbox.list(childID)).then(items=>items.map(item=>item.id)),
      counts:()=>({starts,drains,wakes}),cancelSettled:cancelSettled.promise,releaseCleanup:cleanup.resolve,holdCleanup:()=>{cleanupHeld=true;}}));
  })).pipe(Effect.provide(layer),Effect.timeout('15 seconds')));}finally{finish.resolve();cleanup.resolve();await fs.rm(root,{recursive:true,force:true});}
}
const permit={token:'a'.repeat(64),sessionID:'ses_managed_child',revision:0};

test('actual Job persists before input and reuses its original latch after duplicate prepare/activate and acknowledgement replies',()=>fixture(async f=>{
  await f.adapter.prepare(f.segment,permit);await f.adapter.prepare({...f.segment},permit);
  expect(f.counts().starts).toBe(0);expect(await Effect.runPromise(f.jobs.pendingBackground)).toHaveLength(1);
  await f.admit();await f.adapter.activate(f.segment,permit);await f.adapter.activate(f.segment,permit);
  const completed=await Effect.runPromise(f.jobs.wait({id:f.segment.jobID,timeout:5000}));
  expect(completed.info?.status).toBe('completed');expect(f.counts().starts).toBe(1);
  expect((await Effect.runPromise(f.jobs.pendingBackground))[0]?.status).toBe('completed');
  await f.adapter.acknowledge({...f.segment,envelopeID:'env_one'},permit);await f.adapter.acknowledge({...f.segment,envelopeID:'env_one'},permit);
  expect(await Effect.runPromise(f.jobs.pendingBackground)).toEqual([]);
}));

test('a queued continuation rings an already active native coordinator and joins its following drain',()=>fixture(async f=>{
  f.setHold(true);await f.startOld();await f.started;
  await f.adapter.prepare(f.segment,permit);await f.admit();await f.adapter.activate(f.segment,permit);
  expect(f.counts().starts).toBe(1);expect(f.counts().wakes).toBe(1);
  f.setHold(false);f.finish();
  expect((await Effect.runPromise(f.jobs.wait({id:f.segment.jobID,timeout:5000}))).info?.status).toBe('completed');
  expect(f.counts()).toEqual({starts:1,drains:2,wakes:1});
}));

test('lost prepared replies can be cleaned and acknowledged without stopping an unrelated native child turn',()=>fixture(async f=>{
  f.setHold(true);await f.startOld();await f.started;
  await f.adapter.prepare(f.segment,permit);
  await f.adapter.cancelSegment(f.segment,permit);
  expect((await Effect.runPromise(f.jobs.get(f.segment.jobID)))?.status).toBe('cancelled');
  await expect(f.adapter.acknowledge({...f.segment,envelopeID:'env_lost'},permit)).rejects.toThrow('native_managed_job_unsettled');
  expect(await Effect.runPromise(f.jobs.pendingBackground)).toHaveLength(1);expect(f.counts().starts).toBe(1);
  f.finish();
}));

test('terminal acknowledgement discards an exactly admitted no-reply input when activation never reached the coordinator',()=>fixture(async f=>{
  await f.adapter.prepare(f.segment,permit);await f.admit();
  expect(await f.pendingInputIDs()).toEqual([f.segment.messageID]);
  await f.adapter.acknowledge({...f.segment,envelopeID:'env_uncertain'},permit);
  expect(await Effect.runPromise(f.jobs.pendingBackground)).toEqual([]);expect(await f.pendingInputIDs()).toEqual([]);expect(f.counts().starts).toBe(0);
  // A later unrelated native wake cannot consume the retired accepted input.
  await f.startOld();await f.started;expect(f.counts().starts).toBe(1);
}));

test('task cancellation waits for native runner cleanup before closing its Job and durable marker',()=>fixture(async f=>{
  f.setHold(true);f.holdCleanup();await f.adapter.prepare(f.segment,permit);await f.admit();await f.adapter.activate(f.segment,permit);await f.started;
  const {jobID,notificationID,messageID,...task}=f.segment;let settled=false;
  const cancellation=f.adapter.cancelTask({...task,segments:[{jobID,notificationID,messageID}]},permit).then(value=>{settled=true;return value;});
  await f.cancelSettled;expect(settled).toBe(false);expect((await Effect.runPromise(f.jobs.get(jobID)))?.status).toBe('running');
  f.releaseCleanup();expect(await cancellation).toEqual({aborted:true});
  expect((await Effect.runPromise(f.jobs.get(jobID)))?.status).toBe('cancelled');
  await f.adapter.acknowledge({...f.segment,envelopeID:'env_cancel'},permit);expect(await Effect.runPromise(f.jobs.pendingBackground)).toEqual([]);
}));

test('a cancelled preparation is released only by its successful cancel and never completes or notifies',()=>fixture(async f=>{
  await f.adapter.prepare(f.segment,permit);
  // A refused cancel keeps the original latch: the same preparation stays idempotent.
  await expect(f.adapter.cancelSegment({...f.segment,notificationID:'msg_foreign_notice'},permit)).rejects.toThrow('native_managed_job_identity_changed');
  await f.adapter.prepare(f.segment,permit);
  expect((await Effect.runPromise(f.jobs.get(f.segment.jobID)))?.status).toBe('running');
  await f.adapter.cancelSegment(f.segment,permit);
  const marker=(await Effect.runPromise(f.jobs.pendingBackground)).find(item=>item.id===f.segment.jobID);
  expect(marker?.status).toBe('cancelled');expect((await Effect.runPromise(f.jobs.get(f.segment.jobID)))?.status).toBe('cancelled');
  // The released entry cannot be replayed or activated, and nothing ran.
  await expect(f.adapter.prepare(f.segment,permit)).rejects.toThrow('native_managed_job_replay_forbidden');
  await expect(f.adapter.activate(f.segment,permit)).rejects.toThrow('native_managed_job_preparation_missing');
  expect(f.counts().starts).toBe(0);
  await f.adapter.acknowledge({...f.segment,envelopeID:'env_released'},permit);expect(await Effect.runPromise(f.jobs.pendingBackground)).toEqual([]);
}));

test('after a controller restart, cancelSegment refuses a segment whose input was durably promoted',()=>fixture(async f=>{
  await f.adapter.prepare(f.segment,permit);await f.admit();await f.adapter.activate(f.segment,permit);
  expect((await Effect.runPromise(f.jobs.wait({id:f.segment.jobID,timeout:5000}))).info?.status).toBe('completed');
  const restarted=f.restart();
  await expect(restarted.cancelSegment(f.segment,permit)).rejects.toThrow('native_managed_job_already_activated');
  expect((await Effect.runPromise(f.jobs.get(f.segment.jobID)))?.status).toBe('completed');
}));
