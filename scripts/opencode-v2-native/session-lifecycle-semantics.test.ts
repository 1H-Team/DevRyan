import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';
import os from 'node:os';
import {Clock,DateTime,Effect,Schema} from 'effect';
import {LayerNode} from '@opencode/util/effect/layer-node';import {Global} from '@opencode/util/global';
import {Project} from '@opencode/core/project';import {AbsolutePath} from '@opencode/schema/schema';
import {Bus} from '@opencode/core/bus';import {Database} from '@opencode/core/database/database';
import {SessionStore} from '@opencode/core/session/store';import {SessionProjector} from '@opencode/core/session/projector';
import {SessionEvent} from '@opencode/core/session/event';import {SessionSchema} from '@opencode/core/session/schema';
import {Session} from '@opencode/schema/session';

// Pins the installed OpenCode 2.2.6 session lifecycle semantics that the v2
// projection (`v2/projection/sessions.js` copies the wire values, `events.js`
// re-reads the record on each fact) and the UI monotonic merge rely on: start keeps idle/outcome, terminal idle is strictly
// increasing, shutdown leaves idle/outcome alone, viewed is a max watermark,
// none of them moves `time.updated`, and forks carry `fork` with no parentID.
test('native 2.2.6 session lifecycle and fork facts',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-session-lifecycle-')));
 const sessionID=SessionSchema.ID.make('ses_lifecycle_pin'),forkID=SessionSchema.ID.make('ses_lifecycle_fork');
 let now=1_000;
 const realClock=Clock.Clock.defaultValue();
 const clock:Clock.Clock={currentTimeMillisUnsafe:()=>now,currentTimeMillis:Effect.sync(()=>now),
  currentTimeNanosUnsafe:()=>BigInt(now)*1_000_000n,currentTimeNanos:Effect.sync(()=>BigInt(now)*1_000_000n),
  monotonicTimeNanosUnsafe:()=>realClock.monotonicTimeNanosUnsafe(),monotonicTimeNanos:realClock.monotonicTimeNanos,sleep:duration=>realClock.sleep(duration)};
 const layer=LayerNode.compile(LayerNode.group([SessionStore.node,SessionProjector.node,Bus.node,Database.node,Project.node]),
  {replacements:[Global.node.replace(Global.layerWith({home:root,config:root,data:root,state:root,tmp:root,cache:root,bin:root,log:root,repos:root}))]});
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const bus=yield* Bus.Service,store=yield* SessionStore.Service;
  const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(root));
  const millis=(value:DateTime.Utc|undefined)=>value===undefined?undefined:DateTime.toEpochMillis(value);
  const read=Effect.fnUntraced(function*(id:typeof sessionID){
   const info=yield* store.get(id);if(!info)throw Error(`missing native session ${id}`);
   return {busy:millis(info.time.busy),idle:millis(info.time.idle),viewed:millis(info.time.viewed),updated:millis(info.time.updated),outcome:info.outcome};
  });
  const at=<A,E,R>(time:number,effect:Effect.Effect<A,E,R>)=>Effect.suspend(()=>{now=time;return effect;});
  yield* at(1_000,bus.publish(SessionEvent.Created,Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,projectID:project.id,location:{directory:root},slug:'lifecycle-pin',agent:'build',model:{providerID:'fixture',id:'m1'},version:'2.2.6'})));
  expect(yield* read(sessionID)).toEqual({busy:undefined,idle:undefined,viewed:undefined,updated:1_000,outcome:undefined});

  // Start sets busy and keeps idle/outcome; time.updated never moves.
  yield* at(2_000,bus.publish(SessionEvent.Execution.Started,{sessionID}));
  expect(yield* read(sessionID)).toEqual({busy:2_000,idle:undefined,viewed:undefined,updated:1_000,outcome:undefined});
  yield* at(3_000,bus.publish(SessionEvent.Execution.Succeeded,{sessionID}));
  expect(yield* read(sessionID)).toEqual({busy:2_000,idle:3_000,viewed:undefined,updated:1_000,outcome:'succeeded'});
  yield* at(4_000,bus.publish(SessionEvent.Execution.Started,{sessionID}));
  expect(yield* read(sessionID)).toEqual({busy:4_000,idle:3_000,viewed:undefined,updated:1_000,outcome:'succeeded'});

  // Terminal idle is strictly increasing: a tie or an older time becomes previous + 1 ms.
  yield* at(3_000,bus.publish(SessionEvent.Execution.Failed,{sessionID,error:{type:'unknown',message:'pinned failure'}}));
  expect(yield* read(sessionID)).toMatchObject({idle:3_001,outcome:'failed',updated:1_000});
  yield* at(2_500,bus.publish(SessionEvent.Execution.Interrupted,{sessionID,reason:'user'}));
  expect(yield* read(sessionID)).toMatchObject({idle:3_002,outcome:'interrupted',updated:1_000});
  yield* at(9_000,bus.publish(SessionEvent.Execution.Succeeded,{sessionID}));
  expect(yield* read(sessionID)).toMatchObject({idle:9_000,outcome:'succeeded',updated:1_000});

  // A shutdown interruption touches neither idle nor outcome.
  yield* at(10_000,bus.publish(SessionEvent.Execution.Started,{sessionID}));
  yield* at(11_000,bus.publish(SessionEvent.Execution.Interrupted,{sessionID,reason:'shutdown'}));
  expect(yield* read(sessionID)).toEqual({busy:10_000,idle:9_000,viewed:undefined,updated:1_000,outcome:'succeeded'});

  // viewed is a max watermark of the reported idle.
  yield* at(12_000,bus.publish(SessionEvent.Viewed,{sessionID,idle:9_000}));
  expect((yield* read(sessionID)).viewed).toBe(9_000);
  yield* at(13_000,bus.publish(SessionEvent.Viewed,{sessionID,idle:5_000}));
  expect(yield* read(sessionID)).toEqual({busy:10_000,idle:9_000,viewed:9_000,updated:1_000,outcome:'succeeded'});

  // The wire record (what GET /api/session/:id serves) carries epoch-millisecond numbers.
  expect(Schema.encodeUnknownSync(Session.Info)(yield* store.get(sessionID))).toMatchObject({
   id:sessionID,outcome:'succeeded',time:{created:1_000,updated:1_000,busy:10_000,idle:9_000,viewed:9_000}});

  // A fork carries `fork{sessionID, boundary}` and no parentID; it starts without lifecycle facts.
  yield* at(14_000,bus.publish(SessionEvent.Synthetic,{sessionID,text:'fork boundary'}));
  const [boundary]=yield* store.messages({sessionID,order:'asc'});
  if(!boundary)throw Error('missing native boundary message');
  yield* at(15_000,bus.publish(SessionEvent.Forked,{sessionID:forkID,parentID:sessionID,boundary:{type:'through',messageID:boundary.id}}));
  const fork=yield* store.get(forkID);
  expect(fork?.parentID).toBeUndefined();
  expect(fork?.fork).toEqual({sessionID,boundary:{type:'through',messageID:boundary.id}});
  expect(yield* read(forkID)).toEqual({busy:undefined,idle:undefined,viewed:undefined,updated:15_000,outcome:undefined});
  const wireFork=Schema.encodeUnknownSync(Session.Info)(fork);
  expect(wireFork).not.toHaveProperty('parentID');
  expect(wireFork).toMatchObject({fork:{sessionID,boundary:{type:'through',messageID:boundary.id}},time:{created:15_000,updated:15_000}});
  expect(wireFork).not.toHaveProperty('outcome');
 })).pipe(Effect.provideService(Clock.Clock,clock),Effect.provide(layer),Effect.timeout('20 seconds')));}finally{await fs.rm(root,{recursive:true,force:true});}
},60_000);
