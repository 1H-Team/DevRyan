import { Bus } from '@opencode/core/bus';
import { SessionExecution } from '@opencode/core/session/execution';
import { SessionStore } from '@opencode/core/session/store';
import { Session } from '@opencode/schema/session';
import { SessionMessage } from '@opencode/schema/session-message';
import { SessionEvent } from '@opencode/schema/session-event';
import { Context, Effect, Layer, Schema } from 'effect';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { HostRefusal } from './host-refusal.js';
import { credentialMutationFingerprint } from './native-credential-mutation-owner.js';
import { runControllerEffect } from './controller-effects.js';

const IngressRef = Context.Reference<object | undefined>('DevRyan/PrivateCursorIngress', { defaultValue: () => undefined });
const scopes = new WeakSet<object>();
/** Only a constructor-owned publication can bypass native runner observation. */
export const isNativeCursorIngress = () => Effect.map(IngressRef, value => value !== undefined && scopes.has(value));
const object = Schema.Record(Schema.String, Schema.Unknown);
const RecordSchema = Schema.Struct({ info: Schema.Struct({ id: Schema.String, sessionID: Schema.String,
  role: Schema.Literals(['user', 'assistant']), parentID: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String), modelID: Schema.optional(Schema.String),
  time: Schema.Struct({ created: Schema.Number, completed: Schema.optional(Schema.Number) }),
  error: Schema.optional(object), finish: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number), tokens: Schema.optional(object),
}), parts: Schema.Array(object) });
export interface NativeCursorRecordInput {
  readonly controllerInstanceID: string; readonly directory: string; readonly sessionID: string;
  readonly userMessageID: string; readonly assistantMessageID: string; readonly agent: string;
  readonly modelID: string; readonly variant?: string;
  readonly accepted: Readonly<Record<string, unknown>>; readonly record: unknown;
  readonly permit: { readonly token: string; readonly sessionID: string; readonly revision: number };
}
export type NativeCursorSettlementInput = Omit<NativeCursorRecordInput, 'record' | 'accepted'>;
export interface NativeCursorRecordAuthorization extends Omit<NativeCursorRecordInput, 'accepted' | 'record'> {
  readonly recordFingerprint: string;
}
const refusal = (code: string) => new HostRefusal(code, 403, 'cursor.record');
const mapContent = (parts: readonly Readonly<Record<string, unknown>>[], created: number) => parts.map(part => {
  if (typeof part.id !== 'string' || !part.id || part.id.length > 256) throw refusal('native_cursor_part_invalid');
  const identity = { devryan: { cursor: { partID: part.id } } };
  if (part.type === 'text') return Schema.decodeUnknownSync(SessionMessage.AssistantContentEncoded)({ type: 'text', text: part.text, state: identity });
  if (part.type === 'reasoning') {
    const time = Schema.decodeUnknownSync(Schema.Struct({ start: Schema.optional(Schema.Number), end: Schema.optional(Schema.Number) }))(part.time ?? {});
    return Schema.decodeUnknownSync(SessionMessage.AssistantContentEncoded)({ type: 'reasoning', text: part.text,
      state: identity, time: { created: time.start ?? created, ...(time.end === undefined ? {} : { completed: time.end }) } });
  }
  if (part.type !== 'tool') throw refusal('native_cursor_part_invalid');
  const state = Schema.decodeUnknownSync(object)(part.state);
  const time = Schema.decodeUnknownSync(Schema.Struct({ start: Schema.optional(Schema.Number), end: Schema.optional(Schema.Number) }))(state.time ?? {});
  const status = state.status;
  let nativeState: Record<string, unknown>;
  if (status === 'pending') nativeState = { status: 'streaming', input: JSON.stringify(state.input ?? {}) };
  else if (status === 'running') nativeState = { status, input: state.input ?? {}, metadata: state.metadata ?? {} };
  else if (status === 'completed') nativeState = { status, input: state.input ?? {}, metadata: state.metadata ?? {},
    content: [{ type: 'text', text: typeof state.output === 'string' ? state.output : '' }] };
  else if (status === 'error') nativeState = { status, input: state.input ?? {}, metadata: state.metadata ?? {},
    error: { type: 'CursorToolError', message: typeof state.error === 'string' ? state.error : 'Cursor tool failed' } };
  else throw refusal('native_cursor_part_invalid');
  return Schema.decodeUnknownSync(SessionMessage.AssistantContentEncoded)({ type: 'tool', id: part.callID,
    name: part.tool, executed: true, providerState: identity, state: nativeState,
    time: { created: time.start ?? created, ...(status === 'running' || status === 'completed' || status === 'error' ? { ran: time.start ?? created } : {}),
      ...(time.end === undefined ? {} : { completed: time.end }) } });
});

/** External Cursor facts use native durable Bus/projector APIs. No native
 * runner, provider, or public content-replacement route is introduced. */
export function createNativeCursorIngress(options: { readonly controllerInstanceID: string;
  readonly authorizeRecord: (input: NativeCursorRecordAuthorization) => Effect.Effect<void>;
  readonly authorizeSettlement: (input: NativeCursorSettlementInput) => Effect.Effect<void> }) {
  let bus: Bus.Interface | undefined, store: SessionStore.Interface | undefined;
  let closed = false;
  const queues = new Map<string, Promise<unknown>>();
  const completed = new Map<string, string>();
  const active = new Map<Session.ID, string>();
  const captureBus = (inner: Bus.Interface) => Effect.gen(function* () {
    bus = inner;
    yield* Effect.addFinalizer(() => Effect.sync(() => { if (bus === inner) { bus = undefined; active.clear(); } }));
    return inner;
  });
  const captureStore = (inner: SessionStore.Interface) => Effect.gen(function* () {
    store = inner;
    yield* Effect.addFinalizer(() => Effect.sync(() => { if (store === inner) store = undefined; }));
    return inner;
  });
  const overrides: LayerNode.Replacements = [
    Bus.node.replace(Bus.node.mapLayer(layer => Layer.effect(Bus.Service,
      Effect.flatMap(Bus.Service, captureBus)).pipe(Layer.provide(layer)))),
    SessionStore.node.replace(SessionStore.node.mapLayer(layer => Layer.effect(SessionStore.Service,
      Effect.flatMap(SessionStore.Service, captureStore)).pipe(Layer.provide(layer)))),
  ];
  const persistOwned = (input: NativeCursorRecordInput) => {
    const previous = queues.get(input.sessionID) ?? Promise.resolve();
    const action = previous.catch(() => {}).then(() => runControllerEffect(Effect.gen(function* () {
      const currentBus = bus, currentStore = store;
      const check = () => Effect.gen(function* () {
        if (closed || !currentBus || !currentStore || bus !== currentBus || store !== currentStore
          || input.controllerInstanceID !== options.controllerInstanceID) throw refusal('native_cursor_ingress_expired');
        const { accepted: _accepted, record: _record, ...scope } = input;
        void [_accepted, _record];
        yield* options.authorizeRecord({ ...scope, recordFingerprint: credentialMutationFingerprint(input.record) });
        if (closed || bus !== currentBus || store !== currentStore) throw refusal('native_cursor_ingress_expired');
      });
      yield* check();
      if (!currentBus || !currentStore) throw refusal('native_cursor_ingress_expired');
      const record = Schema.decodeUnknownSync(RecordSchema)(input.record);
      if (record.info.sessionID !== input.sessionID || record.info.providerID !== 'cursor-acp'
        || record.info.modelID !== input.modelID || input.permit.sessionID !== input.sessionID) throw refusal('native_cursor_record_identity');
      const sessionID = Schema.decodeUnknownSync(Session.ID)(input.sessionID);
      const canonical = yield* currentStore.get(sessionID);
      if (!canonical || canonical.location.directory !== input.directory) throw refusal('native_cursor_record_identity');
      const marker = {}; scopes.add(marker);
      const publish = (definition: Parameters<Bus.Interface['publish']>[0], data: unknown) =>
        currentBus.publish(definition, Schema.decodeUnknownSync(definition.data)(data), {
          location: canonical.location, metadata: { devryan: { cursor: { source: 'cursor-acp', userMessageID: input.userMessageID } } },
        });
      return yield* Effect.gen(function* () {
        if (record.info.role === 'user') {
          if (record.info.id !== input.userMessageID || input.accepted.id !== input.userMessageID) throw refusal('native_cursor_record_identity');
          const existing = yield* currentStore.message(Schema.decodeUnknownSync(SessionMessage.ID)(input.userMessageID));
          if (existing) {
            if (existing.sessionID !== sessionID || existing.message.type !== 'user'
              || existing.message.text !== input.accepted.text
              || credentialMutationFingerprint(existing.message.metadata) !== credentialMutationFingerprint(input.accepted.metadata)) throw refusal('native_cursor_record_identity');
          } else {
            yield* check();
            yield* publish(SessionEvent.InboxEnqueued, { sessionID, inboxID: input.userMessageID,
              item: { type: 'user', payload: input.accepted, delivery: input.accepted.delivery ?? 'steer' } });
            yield* check();
            yield* publish(SessionEvent.InboxDelivered, { sessionID, inboxID: input.userMessageID });
          }
        } else {
          if (record.info.id !== input.assistantMessageID || record.info.parentID !== input.userMessageID) throw refusal('native_cursor_record_identity');
          const user = yield* currentStore.message(Schema.decodeUnknownSync(SessionMessage.ID)(input.userMessageID));
          if (!user || user.sessionID !== sessionID || user.message.type !== 'user') throw refusal('native_cursor_record_identity');
          const existing = yield* currentStore.message(Schema.decodeUnknownSync(SessionMessage.ID)(input.assistantMessageID));
          if (existing && (existing.sessionID !== sessionID || existing.message.type !== 'assistant'
            || existing.message.model.providerID !== 'cursor-acp' || existing.message.model.id !== input.modelID)) throw refusal('native_cursor_record_identity');
          const digest = credentialMutationFingerprint(input.record);
          if (completed.has(input.assistantMessageID)) {
            if (completed.get(input.assistantMessageID) !== digest) throw refusal('native_cursor_terminal_record_changed');
            return { messageID: record.info.id };
          }
          if (!existing) {
            yield* check();
            yield* publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: input.assistantMessageID,
              agent: input.agent, model: { providerID: 'cursor-acp', id: input.modelID, ...(input.variant ? { variant: input.variant } : {}) }, started: record.info.time.created });
            yield* check();
            yield* publish(SessionEvent.Execution.Started, { sessionID });
            active.set(sessionID, input.assistantMessageID);
          }
          const content = mapContent(record.parts, record.info.time.created);
          yield* check();
          // Exported replay event is necessary for genuine cumulative ACP
          // corrections to earlier parts; native Text.Ended targets latest text.
          yield* publish(SessionEvent.MessageContentUpdated, { sessionID, messageID: input.assistantMessageID, content });
          if (record.info.time.completed !== undefined) {
            yield* check();
            if (record.info.error) {
              const error = { type: record.info.error.name ?? 'CursorProviderError', message: record.info.error.message ?? 'Cursor run failed' };
              yield* publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID: input.assistantMessageID, error });
              yield* check();
              yield* publish(SessionEvent.Execution.Failed, { sessionID, error });
            } else {
              yield* publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: input.assistantMessageID,
                finish: record.info.finish ?? 'stop', cost: record.info.cost ?? 0,
                tokens: record.info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
              yield* check();
              yield* publish(SessionEvent.Execution.Succeeded, { sessionID });
            }
            if (active.get(sessionID) === input.assistantMessageID) active.delete(sessionID);
            completed.set(input.assistantMessageID, digest);
          }
        }
        yield* check();
        return { messageID: record.info.id };
      }).pipe(Effect.provideService(IngressRef, marker), Effect.ensuring(Effect.sync(() => scopes.delete(marker))));
    })));
    queues.set(input.sessionID, action);
    void action.finally(() => { if (queues.get(input.sessionID) === action) queues.delete(input.sessionID); }).catch(() => {});
    return action;
  };
  const settleOwned = (input: NativeCursorSettlementInput) => {
    const previous = queues.get(input.sessionID) ?? Promise.resolve();
    const action = previous.catch(() => {}).then(() => runControllerEffect(Effect.gen(function* () {
      const currentBus = bus, currentStore = store;
      const check = () => Effect.gen(function* () {
        if (closed || !currentBus || !currentStore || bus !== currentBus || store !== currentStore
          || input.controllerInstanceID !== options.controllerInstanceID || input.permit.sessionID !== input.sessionID) throw refusal('native_cursor_ingress_expired');
        yield* options.authorizeSettlement(input);
        if (closed || bus !== currentBus || store !== currentStore) throw refusal('native_cursor_ingress_expired');
      });
      yield* check();
      if (!currentBus || !currentStore) throw refusal('native_cursor_ingress_expired');
      const sessionID = Schema.decodeUnknownSync(Session.ID)(input.sessionID);
      const canonical = yield* currentStore.get(sessionID);
      if (!canonical) return null;
      if (canonical.location.directory !== input.directory) throw refusal('native_cursor_record_identity');
      const existing = yield* currentStore.message(Schema.decodeUnknownSync(SessionMessage.ID)(input.assistantMessageID));
      if (!existing) return null;
      if (existing.sessionID !== sessionID || existing.message.type !== 'assistant'
        || existing.message.model.providerID !== 'cursor-acp' || existing.message.model.id !== input.modelID) throw refusal('native_cursor_record_identity');
      const assistant = existing.message;
      const wrapped = Schema.decodeUnknownSync(Schema.Struct({ devryan: Schema.Struct({ cursor: Schema.Struct({
        source: Schema.Literal('cursor-acp'), userMessageID: Schema.String }) }) }))(assistant.metadata);
      const metadata = wrapped.devryan.cursor;
      if (metadata.userMessageID !== input.userMessageID) throw refusal('native_cursor_record_identity');
      const user = yield* currentStore.message(Schema.decodeUnknownSync(SessionMessage.ID)(input.userMessageID));
      if (!user || user.sessionID !== sessionID || user.message.type !== 'user') throw refusal('native_cursor_record_identity');
      const marker = {}; scopes.add(marker);
      return yield* Effect.gen(function* () {
        if (!assistant.time.completed) {
          yield* check();
          yield* currentBus.publish(SessionEvent.Step.Failed, Schema.decodeUnknownSync(SessionEvent.Step.Failed.data)({ sessionID,
            assistantMessageID: input.assistantMessageID, error: { type: 'aborted', message: 'Cursor execution interrupted' } }), { location: canonical.location,
              metadata: { devryan: { cursor: { source: 'cursor-acp', userMessageID: input.userMessageID } } } });
        }
        // Even a terminal step may have failed before its execution-idle fact.
        if (!assistant.time.completed || active.get(sessionID) === input.assistantMessageID) {
          yield* check();
          yield* currentBus.publish(SessionEvent.Execution.Interrupted, Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted.data)({ sessionID, reason: 'user' }), { location: canonical.location });
        }
        if (active.get(sessionID) === input.assistantMessageID) active.delete(sessionID);
        return null;
      }).pipe(Effect.provideService(IngressRef, marker), Effect.ensuring(Effect.sync(() => scopes.delete(marker))));
    })));
    queues.set(input.sessionID, action);
    void action.finally(() => { if (queues.get(input.sessionID) === action) queues.delete(input.sessionID); }).catch(() => {});
    return action;
  };
  const decorateExecution = (inner: SessionExecution.Interface): SessionExecution.Interface => ({ ...inner,
    active: inner.active.pipe(Effect.map(original => active.size ? new Set([...original, ...active.keys()]) : original)),
    isActive: sessionID => active.has(sessionID) ? Effect.succeed(true) : inner.isActive(sessionID),
  });
  const close = async () => { closed = true; active.clear(); const results = await Promise.allSettled(queues.values());
    completed.clear(); const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Cursor ingress did not settle'); };
  return { overrides, captureBus, captureStore, persistOwned, settleOwned, decorateExecution, close };
}
