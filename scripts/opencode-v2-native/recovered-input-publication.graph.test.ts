import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Effect, Exit, Schema } from 'effect';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Global } from '@opencode/util/global';
import { Bus } from '@opencode/core/bus';
import { Database } from '@opencode/core/database/database';
import { Project } from '@opencode/core/project';
import { SessionInbox } from '@opencode/core/session/inbox';
import { SessionProjector } from '@opencode/core/session/projector';
import { SessionStore } from '@opencode/core/session/store';
import { SessionEvent } from '@opencode/core/session/event';
import { SessionMessage } from '@opencode/core/session/message';
import { SessionSchema } from '@opencode/core/session/schema';
import { AbsolutePath } from '@opencode/schema/schema';
import { createAdmissionGates } from '../../packages/web/server/lib/opencode/runtime-host/admission-gates.js';
import { primaryStepOverride } from '../../packages/web/server/lib/opencode/runtime-host/primary-step.js';
import { parseNativeCommand } from '../../packages/web/server/lib/opencode/runtime-host/native-process-protocol.js';
import { recoveredInputHash } from '../../packages/web/server/lib/opencode/runtime-host/native-recovered-input-hash.js';
import { persistRecoveredCancellation,dropRecoveredCancellationReceipts,RecoveredCancellationWitnesses } from '../../packages/web/server/lib/opencode/runtime-host/native-input-cancellation-receipt.js';
import { OperationPermitRef, type NativeAdmissionBridge } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';

test('original inbox mutations validate the whole batch before commit and exact cancellation does not reacquire its mutex', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/v2-validation/recovered-publication-'));
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  const sessionID = SessionSchema.ID.make('ses_retained_graph');
  const permit = { token: 'a'.repeat(64), sessionID, revision: 1 };
  const ids = ['msg_retained_first', 'msg_retained_second', 'msg_live_ordinary'].map(id => SessionMessage.ID.make(id));
  const allowedID = ids[0];
  let fenced = false, allowedSeq=0, allowedHash = '', cancelled = 0, preBatches = 0;
  const bridge: NativeAdmissionBridge = {
    awaitReady: async () => {},
    authorize: async request => {
      expect(request.existingPermit).toEqual(permit);
      if (!fenced && request.operation === 'inbox.steer') return permit;
      expect(request.operation).toBe('recovered.input.cancel');
      expect(request.input).toEqual({ id: allowedID, payloadHash: allowedHash,enqueuedSeq:allowedSeq });
      return permit;
    },
    recheck: async current => { expect(current).toEqual(permit); }, release: async () => {},
    sealPrompt: async () => ({}), verifyAccepted: async () => {}, registerShellJob: async () => {},
    sealSynthetic: async () => ({}), deferContinuation: async () => {}, hold: async () => {},
    releaseHold: async () => {}, isHeld: async () => false,
  };
  const gates = createAdmissionGates({ bridge, nativePlugins: new Map(), executeOwned: () => Effect.die('No tool execution') });
  await gates.controls.openStartup();
  const guard = primaryStepOverride(async () => { throw Error('No inference in this graph'); }, undefined,
    event => Effect.sync(() => { if (typeof event === 'object' && event !== null && 'type' in event && event.type === 'session.inbox.cancelled') cancelled++; }),
    events => Effect.gen(function* () {
      if (!fenced) return;
      const mutations = events.filter(event => event.type.startsWith('session.inbox.'));
      if (!mutations.length) return;
      preBatches++;
      // This is the real local Inbox.list under the original native mutex.
      // The Node decision consumes only the supplied snapshot and permit.
      const observation = yield* gates.controls.observeRecoveredPublication(mutations);
      expect(observation.pending.map(row => row.id)).toContain(allowedID);
      expect(yield* OperationPermitRef).toEqual(permit);
      yield* Effect.sync(() => {
        for (const event of observation.events) {
          const data = event.data;
          if (event.type !== 'session.inbox.cancelled' || typeof data !== 'object' || data === null || !('inboxID' in data)
            || data.inboxID !== allowedID || observation.pending.find(row => row.id === allowedID)?.payloadHash !== allowedHash) {
            throw Error('retained_batch_refused');
          }
        }
      });
      return observation.pending.filter(row=>mutations.some(event=>typeof event.data==='object'&&event.data!==null&&'inboxID' in event.data&&event.data.inboxID===row.id)).map(row=>({sessionID:row.sessionID,inboxID:row.id,type:row.type,delivery:row.delivery,payloadHash:row.payloadHash,enqueuedSeq:row.enqueuedSeq??-1,instanceID:'graph-instance'}));
    }),gates.controls.persistRecoveredCancellation);
  const layer = LayerNode.compile(LayerNode.group([SessionInbox.node, SessionStore.node, SessionProjector.node, Bus.node, Database.node, Project.node]), {
    replacements: [Global.node.replace(Global.layerWith({ home: root, data: root, cache: root, config: root,
      state: root, tmp: root, bin: root, log: root, repos: root })), ...gates.overrides,Database.node.replace(Database.node.mapLayer(gates.captureDatabase)), guard],
  });
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* Bus.Service, inbox = yield* SessionInbox.Service,database=yield* Database.Service;
      const events=()=>database.db.$client.unsafe<{id:string;type:string;data:string;seq:number}>('SELECT id,type,data,seq FROM event ORDER BY seq').pipe(Effect.orDie);
      const project = yield* (yield* Project.Service).resolve(AbsolutePath.make(directory));
      yield* bus.publish(SessionEvent.Created, Schema.decodeUnknownSync(SessionEvent.Created.data)({ sessionID,
        projectID: project.id, location: { directory }, slug: 'retained-publication', agent: 'orchestrator',
        model: { providerID: 'fixture', id: 'saved' }, version: '2.0.20' }));
      const item = (text: string) => ({ type: 'user' as const, delivery: 'queue' as const,
        payload: Schema.decodeUnknownSync(SessionInbox.UserPayload)({ text }) });
      for (const id of ids.slice(0, 2)) yield* inbox.admit({ sessionID, id, item: item(id) });
      expect((yield* inbox.list(sessionID)).map(row => row.id)).toEqual(ids.slice(0, 2));
      allowedHash = recoveredInputHash(Schema.encodeSync(SessionInbox.Item)(item(ids[0])));
      expect(yield* events()).toEqual([]);
      allowedSeq=(yield* gates.controls.observeRecoveredPublication([{type:'session.inbox.cancelled',data:{sessionID,inboxID:allowedID}}])).pending.find(row=>row.id===allowedID)?.enqueuedSeq??-1;
      expect(allowedSeq).toBeGreaterThan(0);
      fenced = true;
      const rejected = yield* Effect.exit(bus.publishAll([
        [SessionEvent.InboxCancelled, { sessionID, inboxID: ids[0] }],
        [SessionEvent.InboxCancelled, { sessionID, inboxID: ids[1] }],
      ]));
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(preBatches).toBe(1); expect(cancelled).toBe(0);
      expect((yield* inbox.list(sessionID)).map(row => row.id)).toEqual(ids.slice(0, 2));
      expect(yield* events()).toEqual([]);
      const rollback=yield* Effect.exit(bus.publish(SessionEvent.InboxCancelled,{sessionID,inboxID:allowedID},{commit:()=>Effect.die('commit_failed')}));
      expect(Exit.isFailure(rollback)).toBe(true);expect(yield* events()).toEqual([]);
      expect((yield* inbox.list(sessionID)).map(row=>row.id)).toEqual(ids.slice(0,2));
      const wrongHash = allowedHash; allowedHash = '0'.repeat(64);
      yield* Effect.promise(async () => { await expect(gates.controls.cancelRecoveredInputOwned({ sessionID, messageID: allowedID, payloadHash: allowedHash,enqueuedSeq:allowedSeq,cancellationReceiptVersion:1, permit })).rejects.toThrow('retained_batch_refused'); });
      allowedHash = wrongHash;
      expect((yield* inbox.list(sessionID)).map(row => row.id)).toEqual(ids.slice(0, 2));
      yield* Effect.promise(() => gates.controls.cancelRecoveredInputOwned({ sessionID, messageID: allowedID, payloadHash: allowedHash,enqueuedSeq:allowedSeq,cancellationReceiptVersion:1, permit }));
      expect((yield* inbox.list(sessionID)).map(row => row.id)).toEqual([ids[1]]); expect(cancelled).toBe(1);
      const receipts=yield* events();expect(receipts).toHaveLength(1);expect(receipts[0]?.type).toBe('devryan.recovered-input.cancelled@1');
      const receipt=JSON.parse(receipts[0]?.data??'null');expect(receipt).toMatchObject({sessionID,inboxID:allowedID,enqueuedSeq:allowedSeq,payloadHash:allowedHash,type:'user',delivery:'queue',instanceID:'graph-instance',nativeEvent:{type:'session.inbox.cancelled',aggregateID:sessionID,version:1}});
      expect(receipts[0]?.id).toBe(`${receipt.nativeEvent.id}:recovered-input`);expect(receipt.nativeEvent.seq).toBe(receipts[0]?.seq);expect(receipt.nativeEvent.seq).toBeGreaterThan(allowedSeq);
      // Clearing the host fence retains normal native queue behavior.
      fenced = false;
      yield* inbox.admit({ sessionID, id: ids[2], item: item('ordinary live queue') });
      yield* inbox.steer({ sessionID, id: ids[2] });
      expect((yield* inbox.list(sessionID)).map(row => [row.id, row.delivery])).toEqual([[ids[1], 'queue'], [ids[2], 'steer']]);
    }).pipe(Effect.provide(layer), Effect.provideService(OperationPermitRef, permit), Effect.timeout('10 seconds'))));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('selective receipt coexists with original persisted versioned event and session deletion removes only its derived aggregate',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/recovered-persisted-'));const directory=path.join(root,'project');await fs.mkdir(directory);execFileSync('git',['init','--quiet'],{cwd:directory});
 const sessionID=SessionSchema.ID.make('ses_persisted_receipt'),id=SessionMessage.ID.make('msg_persisted_receipt');
 const layer=LayerNode.compile(LayerNode.group([SessionInbox.node,SessionStore.node,SessionProjector.node,Bus.node,Database.node,Project.node]),{replacements:[
  Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),Bus.node.replace(Bus.configured({persist:true}))]});
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const bus=yield* Bus.Service,inbox=yield* SessionInbox.Service,database=yield* Database.Service;
  yield* bus.project(SessionEvent.InboxCancelled,event=>persistRecoveredCancellation(database,event));
  yield* bus.project(SessionEvent.Deleted,event=>dropRecoveredCancellationReceipts(database,event));
  const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(directory));
  yield* bus.publish(SessionEvent.Created,Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,projectID:project.id,location:{directory},slug:'receipt',agent:'orchestrator',model:{providerID:'fixture',id:'saved'},version:'2.0.20'}));
  const item={type:'user' as const,delivery:'queue' as const,payload:Schema.decodeUnknownSync(SessionInbox.UserPayload)({text:'accepted'})};
  yield* inbox.admit({sessionID,id,item});
  const rows=yield* database.db.$client.unsafe<{enqueued_seq:number}>('SELECT enqueued_seq FROM session_inbox WHERE id=?',[id]).pipe(Effect.orDie);
  const witness={sessionID,inboxID:id,enqueuedSeq:rows[0]?.enqueued_seq??-1,type:item.type,delivery:item.delivery,payloadHash:recoveredInputHash(Schema.encodeSync(SessionInbox.Item)(item)),instanceID:'persisted-graph'};
  yield* inbox.cancel({sessionID,id}).pipe(Effect.provideService(RecoveredCancellationWitnesses,[witness]));
  const events=yield* database.db.$client.unsafe<{id:string;type:string;data:string;seq:number}>('SELECT id,type,data,seq FROM event ORDER BY seq').pipe(Effect.orDie);
  const native=events.find(row=>row.type==='session.inbox.cancelled.1'),receipt=events.find(row=>row.type==='devryan.recovered-input.cancelled@1');
  expect(native).toBeDefined();expect(receipt).toBeDefined();expect(receipt?.seq).toBe(native?.seq);expect(receipt?.id).toBe(`${native?.id}:recovered-input`);
  expect(JSON.parse(receipt?.data??'null').nativeEvent.id).toBe(native?.id);
  yield* bus.publish(SessionEvent.Deleted,{sessionID});
  expect(yield* database.db.$client.unsafe('SELECT id FROM event WHERE aggregate_id=?',[`${sessionID}:recovered-input-cancellation`]).pipe(Effect.orDie)).toEqual([]);
  expect(yield* database.db.$client.unsafe('SELECT aggregate_id FROM event_sequence WHERE aggregate_id=?',[`${sessionID}:recovered-input-cancellation`]).pipe(Effect.orDie)).toEqual([]);
 }).pipe(Effect.provide(layer),Effect.timeout('10 seconds'))));}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('exact cancellation receipt command refuses missing or incompatible witness before execution',()=>{
 const command={protocol:1 as const,id:'cancel',action:'cancel-recovered-input-owned' as const,sessionID:'ses_receipt',messageID:'msg_receipt',payloadHash:'a'.repeat(64),enqueuedSeq:4,cancellationReceiptVersion:1 as const,permit:{token:'b'.repeat(64),sessionID:'ses_receipt',revision:2}};
 expect(parseNativeCommand(command)).toEqual(command);
 for(const change of [{enqueuedSeq:undefined},{enqueuedSeq:-1},{enqueuedSeq:1.5},{cancellationReceiptVersion:undefined},{cancellationReceiptVersion:2}])expect(()=>parseNativeCommand({...command,...change})).toThrow();
});
