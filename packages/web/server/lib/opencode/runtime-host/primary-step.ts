import {QueuedInputWitnesses,type QueuedInputWitness} from './native-queued-input.js';
import { Bus } from '@opencode/core/bus';
import { SessionEvent } from '@opencode/schema/session-event';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { Effect, Exit, Layer, Schema, type Scope } from 'effect';
import { OperationPermitRef } from './native-admission-contract.js';
import { HostRefusal, refuseHost } from './host-refusal.js';
import type { ExecutionRpc } from './worker-protocol.js';
import {RecoveredCancellationWitnesses,type RecoveredCancellationWitness} from './native-input-cancellation-receipt.js';
import {isNativeCursorIngress} from './native-cursor-ingress.js';
import {currentNativeAttemptIdentity} from './native-observation.js';

/** Constructor callback disposition only; never execution or wire authority. */
export interface PrimaryStepPublication { readonly primaryStep: 'interrupted-cleanup' }
const interruptedCleanup: PrimaryStepPublication = Object.freeze({primaryStep:'interrupted-cleanup'});

/** Native Step.Started commits the exact assistant identity before tool dispatch. */
export function primaryStepOverride(rpc: ExecutionRpc,
  captureBus?: (inner: Bus.Interface) => Effect.Effect<Bus.Interface, never, Scope.Scope>,
  onPublished?: (event:unknown, disposition?:PrimaryStepPublication)=>Effect.Effect<void>,
  beforePublish?: (events:readonly {readonly type:string;readonly data:unknown}[])=>Effect.Effect<readonly RecoveredCancellationWitness[]|void>,
  commitCancellation?: (event:typeof SessionEvent.InboxCancelled.Type)=>Effect.Effect<void>,
  dropCancellationReceipts?: (event:typeof SessionEvent.Deleted.Type)=>Effect.Effect<void>,
  assertHelperTitle?: (event:typeof SessionEvent.Renamed.Type)=>Effect.Effect<void>,
  prepareQueued?: (events:readonly {readonly type:string;readonly data:unknown}[])=>Effect.Effect<readonly QueuedInputWitness[]>,
  assertQueued?: (event:typeof SessionEvent.InboxEnqueued.Type|typeof SessionEvent.InboxDelivered.Type)=>Effect.Effect<void>,
  interruptStoppedHandoff?: (sessionID:string)=>Effect.Effect<void>): LayerNode.Replacement {
  return Bus.node.replace(Bus.node.mapLayer(layer => Layer.effect(Bus.Service, Effect.gen(function* () {
    const inner = yield* Bus.Service;
    if(assertQueued){yield* inner.project(SessionEvent.InboxEnqueued,assertQueued);yield* inner.project(SessionEvent.InboxDelivered,assertQueued);}
    if(assertHelperTitle)yield* inner.project(SessionEvent.Renamed,assertHelperTitle);
    if(dropCancellationReceipts)yield* inner.project(SessionEvent.Deleted,dropCancellationReceipts);
    if(commitCancellation)yield* inner.project(SessionEvent.InboxCancelled,commitCancellation);
    const observe = (event: unknown) => Effect.gen(function* () {
      if(yield* isNativeCursorIngress())return;
      // Bus returns decoded values; optional fields may be present as undefined.
      const step = Schema.decodeUnknownSync(Schema.toType(SessionEvent.Step.Started))(event);
      // The native publisher lazily starts its assistant while finalizing an
      // interrupted stream. Preserve that cleanup event without admitting work.
      // Temporarily restoring interruptibility observes a delivered interruption
      // on this fiber; held permits and aborted provider signals are insufficient.
      const interrupted = Effect.uninterruptible(Effect.exit(Effect.interruptible(Effect.void))).pipe(Effect.map(Exit.hasInterrupts));
      if (yield* interrupted) return interruptedCleanup;
      const permit = yield* OperationPermitRef;
      if (!permit) return yield* refuseHost(new HostRefusal('native_primary_permit_required', 403, 'primary.step', step.data.sessionID));
      const attempt=yield* currentNativeAttemptIdentity;
      return yield* Effect.tryPromise({ try: signal => rpc('native.primary-step', { permit, event: step, attempt }, { signal }),
        catch: error => error }).pipe(Effect.catch(() => Effect.gen(function* () {
          // Stop can reach the native fiber while the handoff is awaiting its
          // reply. A normal rejected handoff still fails closed.
          if (yield* interrupted) return interruptedCleanup;
          return yield* refuseHost(new HostRefusal('native_primary_step_unavailable', 503, 'primary.step', step.data.sessionID));
        })), Effect.flatMap(value=>{
          if(value===interruptedCleanup)return Effect.succeed(interruptedCleanup);
          if(typeof value==='object'&&value!==null&&'stop' in value){
            const stop=value.stop;
            if(Array.isArray(value)||!interruptStoppedHandoff||Object.keys(value).length!==2||!('tracked' in value)||value.tracked!==false
              ||Object.keys(value).some(key=>!['tracked','stop'].includes(key))
              ||typeof stop!=='object'||stop===null||Array.isArray(stop)||Object.keys(stop).length!==2
              ||Object.keys(stop).some(key=>!['sessionID','assistantMessageID'].includes(key))
              ||!('sessionID' in stop)||!('assistantMessageID' in stop)
              ||stop.sessionID!==step.data.sessionID||stop.assistantMessageID!==step.data.assistantMessageID){
              return refuseHost(new HostRefusal('native_primary_step_unavailable',503,'primary.step',step.data.sessionID));
            }
            return interruptStoppedHandoff(step.data.sessionID).pipe(Effect.andThen(Effect.interruptible(Effect.interrupt)));
          }
          return Effect.succeed(undefined);
        }));
    });
    const published=(event:unknown,isStep:boolean)=> (isStep?observe(event):Effect.succeed(undefined)).pipe(
      Effect.flatMap(disposition=>onPublished?onPublished(event,disposition):Effect.void));
    const prepare=(events:readonly {readonly type:string;readonly data:unknown}[])=>Effect.gen(function*(){
      const queued=prepareQueued?yield* prepareQueued(events):[];
      const cancelled=beforePublish?yield* beforePublish(events):[];
      return {queued,cancelled:cancelled??[]};
    });
    const decorated = Bus.Service.of({ ...inner,
      publish: (definition, data, options) => prepare([{type:definition.type,data}]).pipe(Effect.flatMap(witnesses=>inner.publish(definition,data,options).pipe(Effect.provideService(RecoveredCancellationWitnesses,witnesses.cancelled),Effect.provideService(QueuedInputWitnesses,witnesses.queued))),Effect.tap(event =>
        published(event,definition.type === SessionEvent.Step.Started.type))),
      publishAll: events => prepare(events.map(([definition,data])=>({type:definition.type,data}))).pipe(Effect.flatMap(witnesses=>inner.publishAll(events).pipe(Effect.provideService(RecoveredCancellationWitnesses,witnesses.cancelled),Effect.provideService(QueuedInputWitnesses,witnesses.queued))),Effect.tap(published =>
        Effect.forEach(published,event=>(typeof event==='object'&&event!==null&&'type' in event&&event.type===SessionEvent.Step.Started.type?observe(event):Effect.succeed(undefined)).pipe(
          Effect.flatMap(disposition=>onPublished?onPublished(event,disposition):Effect.void)), { discard: true }))),
    });
    if (captureBus) yield* captureBus(decorated);
    return decorated;
  })).pipe(Layer.provide(layer))));
}
