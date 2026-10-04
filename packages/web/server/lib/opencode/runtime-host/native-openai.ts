import crypto from 'node:crypto';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import type { Location } from '@opencode/core/location';
import { Location as NativeLocation } from '@opencode/core/location';
import type { PluginHooks } from '@opencode/core/plugin/hooks';
import { Context, Effect, Logger, Option, Schema } from 'effect';
import { CredentialAuthorizationRef, CredentialMutationReauthorizeRef, type WithCredentialMutation, type CredentialMutationBinding } from './credential-mutation-contract.js';
import type { NativeOpenAiAttempt, NativeOpenAiSelected } from './native-openai-auth.js';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { OperationPermitRef, requestPermit, type OperationPermit } from './native-admission-contract.js';

const methods = new Set(['chatgpt-browser', 'chatgpt-headless']);
const openaiID = Schema.decodeUnknownSync(Integration.ID)('openai');
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]));
  return value;
}
const fingerprint = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const deny = (code = 'native_openai_owner_unavailable') => refuseHost(new HostRefusal(code, 503, 'provider.openai'));
export type NativeOpenAiKind = 'primary'|'compaction'|'title'|'generate';
interface PhysicalIdentity { readonly sessionID: string; readonly model: { readonly providerID: string }; readonly kind: NativeOpenAiKind }
interface HttpAttempt extends PhysicalIdentity { request: Request }
interface HandshakeAttempt extends PhysicalIdentity { url: string; headers: Record<string, string> }
interface SendAttempt extends PhysicalIdentity { frame: string }
function physical(value: unknown): value is PhysicalIdentity {
  return typeof value === 'object' && value !== null && 'sessionID' in value && typeof value.sessionID === 'string'
    && 'kind' in value && ['primary', 'compaction', 'title', 'generate'].includes(String(value.kind))
    && 'model' in value && typeof value.model === 'object' && value.model !== null
    && 'providerID' in value.model && typeof value.model.providerID === 'string';
}
function http(value: unknown): value is HttpAttempt { return physical(value) && 'request' in value && value.request instanceof Request; }
function handshake(value: unknown): value is HandshakeAttempt {
  return physical(value) && 'url' in value && typeof value.url === 'string' && 'headers' in value
    && typeof value.headers === 'object' && value.headers !== null && !Array.isArray(value.headers)
    && Object.values(value.headers).every(item => typeof item === 'string');
}
function send(value: unknown): value is SendAttempt { return physical(value) && 'frame' in value && typeof value.frame === 'string'; }
function codexURL(input: string, websocket: boolean): string | undefined {
  const url = new URL(input);
  if (url.username || url.password) return undefined;
  const protocol = websocket ? 'wss:' : 'https:';
  if (url.protocol !== protocol) return undefined;
  if (url.hostname === 'api.openai.com' && url.port === '' && url.pathname === '/v1/responses') {
    url.hostname = 'chatgpt.com'; url.pathname = '/backend-api/codex/responses';
  }
  if (url.hostname !== 'chatgpt.com' || url.port !== '' || url.pathname !== '/backend-api/codex/responses') return undefined;
  return url.href;
}

export interface NativeOpenAiPhysicalAttempt {
  readonly directory: string; readonly controllerInstanceID: string; readonly credentialID?: string;
  readonly sessionID: string; readonly kind: NativeOpenAiKind; readonly permit: OperationPermit;
}
export interface NativeOpenAiOptions {
  controllerIdentity(): string | undefined;
  isBound(): boolean;
  isExecutionReady(): boolean;
  assertAttempt(input: NativeOpenAiPhysicalAttempt): Effect.Effect<void>;
  access(input: NativeOpenAiPhysicalAttempt): Promise<NativeOpenAiAttempt | undefined>;
  withCredentialMutation: WithCredentialMutation;
  captureOAuthGrant(input: { readonly directory: string; readonly controllerInstanceID: string; readonly integrationID: 'openai'; readonly methodID: string }): Effect.Effect<{ readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> }>;
}

/** Captured services perform CAS; only the Node coordinator owns refresh. */
export function createNativeOpenAi(options: NativeOpenAiOptions) {
  let credentials: Credential.Interface | undefined;
  interface Acquisition { readonly inner: Integration.Interface; readonly location: Location.Interface; readonly controllerInstanceID: string; closed: boolean; readonly attempts: Map<Integration.AttemptID, OAuthScope> }
  interface OAuthScope { readonly acquisition: Acquisition; readonly methodID: Integration.MethodID; readonly grant: { readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> } }
  const OAuthAuthorization = Context.Reference<OAuthScope | undefined>('DevRyan/OpenAiOAuthAuthorization', { defaultValue: () => undefined });
  const integrations = new Map<string, Acquisition>();
  const acquisitions = new WeakMap<Integration.Interface, Acquisition>();
  const sockets = new Map<string, { directory: string; generation: string; credentialID: string; accountId?: string; controllerInstanceID: string; acquisition: Acquisition }>();
  const identity = () => {
    const value = options.controllerIdentity();
    if (!value) throw new HostRefusal('native_openai_owner_unavailable', 503, 'provider.openai');
    return value;
  };
  const requireCurrent = (acquisition: Acquisition) => {
    if (acquisition.closed || integrations.get(acquisition.location.directory) !== acquisition || identity() !== acquisition.controllerInstanceID)
      throw new HostRefusal('native_openai_location_expired', 409, 'provider.openai');
  };
  const currentAcquisition = (directory: string) => {
    const value = integrations.get(directory);
    if (!value) throw new HostRefusal('native_openai_location_unavailable', 503, 'provider.openai');
    requireCurrent(value); return value;
  };
  const selected = (directory: string): Effect.Effect<NativeOpenAiSelected | undefined> => Effect.gen(function* () {
    const acquisition = currentAcquisition(directory), integration = acquisition.inner, store = credentials, controllerInstanceID = identity();
    if (!store) return yield* deny();
    const active = yield* integration.connection.active(openaiID); requireCurrent(acquisition);
    if (!active || active.type !== 'credential') return undefined;
    const record = yield* store.get(active.id);
    const finalActive = yield* integration.connection.active(openaiID); requireCurrent(acquisition);
    if (identity() !== controllerInstanceID) return yield* deny();
    if (!record || record.integrationID !== openaiID || finalActive?.type !== 'credential'
      || finalActive.id !== active.id) return yield* deny('native_credential_changed');
    return { directory, controllerInstanceID, integrationID: 'openai', credentialID: record.id, value: structuredClone(record.value) };
  });
  const location = (): Effect.Effect<Location.Interface> => Effect.gen(function* () {
    const actual = Option.getOrUndefined(Context.getOption(yield* Effect.context(), NativeLocation.Service));
    if (!actual) return yield* deny('native_openai_location_unavailable');
    return actual;
  });
  const mutation = <A, E, R>(operation: CredentialMutationBinding['operation'], record: Credential.Info | undefined,
    value: Credential.Value, request: unknown, action: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.gen(function* () {
    const actual = yield* location(), controllerInstanceID = identity(), store = credentials;
    const acquisition = currentAcquisition(actual.directory), oauth = yield* OAuthAuthorization;
    if (oauth && (oauth.acquisition !== acquisition || value.type !== 'oauth' || oauth.methodID !== value.methodID)) return yield* deny('native_openai_oauth_scope_required');
    if (oauth) { yield* oauth.grant.reauthorize; requireCurrent(acquisition); }
    if (!store) return yield* deny();
    if (value.type === 'oauth' && !methods.has(value.methodID)) return yield* deny('native_openai_method_unsupported');
    const original = record ? structuredClone(record) : undefined;
    const binding: CredentialMutationBinding = { kind: 'openai', directory: actual.directory, controllerInstanceID,
      integrationID: 'openai', operation, credentialID: original?.id,
      expectedFingerprint: original ? fingerprint(original) : undefined, requestedFingerprint: fingerprint(request),
      ...(value.type === 'oauth' ? { valueType: 'oauth', methodID: value.methodID } : { valueType: 'key' }) };
    return yield* options.withCredentialMutation(binding, Effect.gen(function* () {
      requireCurrent(acquisition);
      if (oauth) { yield* oauth.grant.reauthorize; requireCurrent(acquisition); }
      if (identity() !== controllerInstanceID) return yield* deny();
      if (original) {
        const current = yield* store.get(original.id);
        if (!current || fingerprint(current) !== fingerprint(original)) return yield* deny('native_credential_changed');
      }
      requireCurrent(acquisition);
      if (oauth) { yield* oauth.grant.reauthorize; requireCurrent(acquisition); }
      if (identity() !== controllerInstanceID || fingerprint(request) !== binding.requestedFingerprint) return yield* deny();
      const reauthorize = yield* CredentialMutationReauthorizeRef;
      if (!reauthorize) return yield* deny('native_credential_mutation_authorization_required');
      yield* reauthorize; requireCurrent(acquisition);
      return yield* action;
    })).pipe(Effect.provideService(CredentialAuthorizationRef, oauth?.grant.authorizationID ?? (yield* CredentialAuthorizationRef))); 
  });
  const decorateCredential = (inner: Credential.Interface): Credential.Interface => {
    credentials = inner;
    const existing = <A, E, R>(operation: CredentialMutationBinding['operation'], id: Credential.ID, request: unknown,
      action: Effect.Effect<A, E, R>, requestedValue?: Credential.Value): Effect.Effect<A, E, R> => Effect.gen(function* () {
      const record = yield* inner.get(id);
      if (!record || record.integrationID !== openaiID) return yield* action;
      return yield* mutation(operation, record, requestedValue ?? record.value, request, action);
    });
    return { ...inner,
      create: input => {
        const copy = structuredClone(input);
        return copy.integrationID === openaiID ? mutation('create', undefined, copy.value, copy, inner.create(copy)) : inner.create(copy);
      },
      update: (id, updates) => { const copy = structuredClone(updates); return existing('update', id, { id, updates: copy }, inner.update(id, copy), copy.value); },
      activate: id => existing('activate', id, { id }, inner.activate(id)),
      remove: id => existing('remove', id, { id }, inner.remove(id)),
    };
  };
  const closeAcquisition = (acquisition: Acquisition): Effect.Effect<void> => Effect.gen(function* () {
    acquisition.closed = true;
    if (integrations.get(acquisition.location.directory) === acquisition) integrations.delete(acquisition.location.directory);
    for (const [sessionID, socket] of sockets) if (socket.acquisition === acquisition) sockets.delete(sessionID);
    const failures = [];
    for (const [attemptID] of acquisition.attempts) {
      const exit = yield* acquisition.inner.oauth.cancel({ integrationID: openaiID, attemptID }).pipe(Effect.exit);
      if (exit._tag === 'Success') acquisition.attempts.delete(attemptID); else failures.push(exit.cause);
    }
    if (failures.length) return yield* Effect.die(new AggregateError(failures, 'Native OpenAI acquisition cleanup failed'));
  });
  const closeLocation = (directory: string, inner: Integration.Interface): Effect.Effect<void> => Effect.suspend(() => {
    const captured = acquisitions.get(inner);
    return captured?.location.directory === directory ? closeAcquisition(captured) : Effect.void;
  });
  const decorateIntegration = (inner: Integration.Interface, actualLocation: Location.Interface): Integration.Interface => {
    const directory = actualLocation.directory;
    const previous = integrations.get(directory);
    if (acquisitions.has(inner)) throw new HostRefusal('native_openai_location_expired', 409, 'provider.openai');
    if (previous && !previous.closed) throw new HostRefusal('native_openai_acquisition_active', 409, 'provider.openai');
    const acquisition: Acquisition = { inner, location: Object.freeze({ ...actualLocation, project: Object.freeze({ ...actualLocation.project }) }),
      controllerInstanceID: identity(), closed: false, attempts: new Map() };
    integrations.set(directory, acquisition); acquisitions.set(inner, acquisition);
    const live = <A, E, R>(action: Effect.Effect<A, E, R>) => Effect.gen(function* () { requireCurrent(acquisition); const result = yield* action; requireCurrent(acquisition); return result; });
    const scope = <A, E, R>(authorization: OAuthScope, action: Effect.Effect<A, E, R>) => action.pipe(
      Effect.provideService(OAuthAuthorization, authorization), Effect.provideService(CredentialAuthorizationRef, authorization.grant.authorizationID),
      Effect.provideService(NativeLocation.Service, acquisition.location));
    const ownedAttempt = (input: { integrationID: Integration.ID; attemptID: Integration.AttemptID }) => Effect.gen(function* () {
      requireCurrent(acquisition);
      const attempt = acquisition.attempts.get(input.attemptID);
      if (input.integrationID !== openaiID || !attempt) return yield* deny('native_openai_attempt_scope_required');
      yield* attempt.grant.reauthorize; requireCurrent(acquisition); return attempt;
    });
    const connectionMutation = <A, E, R>(id: Credential.ID, action: Effect.Effect<A, E, R>) => Effect.gen(function* () {
      const info=credentials ? yield* credentials.get(id) : undefined;
      return yield* info?.integrationID === openaiID ? live(action.pipe(Effect.provideService(NativeLocation.Service,acquisition.location))) : action;
    });
    return { ...inner, transform: callback => live(inner.transform(callback)), reload: () => live(inner.reload()),
      get: id => live(inner.get(id)), list: () => live(inner.list()),
      connection: { ...inner.connection, key: input => input.integrationID === openaiID
        ? live(inner.connection.key(input).pipe(Effect.provideService(NativeLocation.Service,acquisition.location))) : inner.connection.key(input),
      activate: id => connectionMutation(id,inner.connection.activate(id)),
      update: (id,updates) => connectionMutation(id,inner.connection.update(id,updates)),
      remove: id => connectionMutation(id,inner.connection.remove(id)), active: id => id === openaiID ? live(inner.connection.active(id)) : inner.connection.active(id), resolve: connection => Effect.gen(function* () {
      requireCurrent(acquisition);
      if (connection.type !== 'credential' || !credentials) return yield* inner.connection.resolve(connection);
      const record = yield* credentials.get(connection.id); requireCurrent(acquisition);
      if (!record || record.integrationID !== openaiID || record.value.type !== 'oauth') return yield* inner.connection.resolve(connection);
      if (!methods.has(record.value.methodID)) return yield* deny('native_openai_method_unsupported');
      const current = yield* selected(directory);
      if (!current || current.credentialID !== record.id) return yield* deny('native_credential_changed');
      // Activation and selection reload use metadata in both phases. They
      // never refresh; every physical HTTP/WS attempt has the final hook below.
      requireCurrent(acquisition); return structuredClone(current.value);

    }) }, oauth: { ...inner.oauth,
      connect: input => input.integrationID !== openaiID ? inner.oauth.connect(input) : Effect.gen(function* () {
        requireCurrent(acquisition);
        if (!methods.has(input.methodID)) return yield* deny('native_openai_method_unsupported');
        const info = yield* inner.get(openaiID); requireCurrent(acquisition);
        if (!info?.methods.some(method => method.type === 'oauth' && method.id === input.methodID)) return yield* deny('native_openai_method_unsupported');
        const grant = yield* options.captureOAuthGrant({ directory, controllerInstanceID: acquisition.controllerInstanceID, integrationID: 'openai', methodID: input.methodID });
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(grant.authorizationID)) return yield* deny('native_openai_oauth_scope_required');
        yield* grant.reauthorize; requireCurrent(acquisition);
        const authorization: OAuthScope = { acquisition, methodID: input.methodID, grant };
        const attempt = yield* scope(authorization, inner.oauth.connect(input));
        let retained = false;
        return yield* Effect.gen(function* () {
          yield* grant.reauthorize; requireCurrent(acquisition);
          acquisition.attempts.set(attempt.attemptID, authorization); retained = true; return attempt;
        }).pipe(Effect.ensuring(Effect.suspend(() => retained ? Effect.void : inner.oauth.cancel({ integrationID: openaiID, attemptID: attempt.attemptID }))));
      }),
      status: input => input.integrationID !== openaiID ? inner.oauth.status(input) : Effect.gen(function* () {
        yield* ownedAttempt(input); return yield* live(inner.oauth.status(input));
      }),
      complete: input => input.integrationID !== openaiID ? inner.oauth.complete(input) : Effect.gen(function* () {
        const authorization = yield* ownedAttempt(input);
        return yield* scope(authorization, live(inner.oauth.complete(input)));
      }),
      cancel: input => input.integrationID !== openaiID ? inner.oauth.cancel(input) : Effect.gen(function* () {
        const authorization=yield* ownedAttempt(input); yield* scope(authorization,live(inner.oauth.cancel(input))); acquisition.attempts.delete(input.attemptID);
      }),
    } };
  };
  const fresh = (directory: string, input: PhysicalIdentity) => Effect.gen(function* () {
    if (!options.isBound() || !options.isExecutionReady()) return yield* deny('native_openai_startup_held');
    const permit = (yield* OperationPermitRef) ?? requestPermit();
    if (!permit || !['primary','compaction','title','generate'].includes(input.kind)) return yield* deny('native_openai_attempt_scope_required');
    const acquisition = currentAcquisition(directory), controllerInstanceID = identity(), before = yield* selected(directory);
    const attemptInput = { directory, controllerInstanceID, sessionID: input.sessionID, kind: input.kind, permit, credentialID: before?.credentialID };
    yield* options.assertAttempt(attemptInput); requireCurrent(acquisition);
    if (!before || before.value.type === 'key') return { acquisition, controllerInstanceID, selected: before, attempt: undefined };
    if (!methods.has(before.value.methodID)) return yield* deny('native_openai_method_unsupported');
    const attempt = yield* Effect.promise(() => options.access(attemptInput));
    const after = yield* selected(directory); requireCurrent(acquisition);
    yield* options.assertAttempt(attemptInput); requireCurrent(acquisition);
    if (!attempt || identity() !== controllerInstanceID || !options.isExecutionReady()
      || !after || after.value.type !== 'oauth' || after.credentialID !== before.credentialID
      || after.value.methodID !== before.value.methodID || after.value.access !== attempt.accessToken
      || after.value.expires !== attempt.expiresAt) return yield* deny('native_credential_changed');
    return { acquisition, controllerInstanceID, selected: after, attempt };
  });
  const finalize = (name: PropertyKey, event: unknown, original: { sessionID: string; kind: string; modelFingerprint: string }): Effect.Effect<void> => Effect.gen(function* () {
    if (!physical(event) || event.sessionID !== original.sessionID || event.kind !== original.kind
      || fingerprint(event.model) !== original.modelFingerprint) return yield* deny('native_openai_hook_identity_changed');
    const actual = yield* location(), proof = yield* fresh(actual.directory, event); requireCurrent(proof.acquisition);
    if (name === 'experimental.ws.send' && send(event)) {
      const socket = sockets.get(event.sessionID);
      const key = proof.selected?.value.type === 'key' ? proof.selected : undefined;
      const generation = proof.attempt?.generation ?? (key ? fingerprint([proof.controllerInstanceID, key.credentialID, key.value]) : undefined);
      if (!socket || socket.directory !== actual.directory || socket.controllerInstanceID !== proof.controllerInstanceID
        || socket.generation !== generation || socket.credentialID !== (proof.attempt?.credentialID ?? key?.credentialID)
        || socket.accountId !== proof.attempt?.accountId) return yield* deny('native_openai_socket_changed');
      return;
    }
    const attempt = proof.attempt;
    if (!attempt) {
      // Native API-key selection must not reuse a cached OAuth transport.
      sockets.delete(event.sessionID);
      const key = proof.selected?.value.type === 'key' ? proof.selected.value.key : undefined;
      if (!key) return yield* deny('native_openai_key_unavailable');
      if (name === 'http.request' && http(event)) {
        const url = new URL(event.request.url);
        if (url.origin !== 'https://api.openai.com' || url.username || url.password) return yield* deny('native_openai_key_route_unavailable');
        const headers = new Headers(event.request.headers); headers.delete('chatgpt-account-id'); headers.set('authorization', `Bearer ${key}`);
        event.request = new Request(event.request, { headers }); return;
      }
      if (name === 'experimental.ws.handshake' && handshake(event) && proof.selected) {
        const url = new URL(event.url);
        if (url.origin !== 'wss://api.openai.com' || url.username || url.password || url.pathname !== '/v1/responses') return yield* deny('native_openai_key_route_unavailable');
        const headers = new Headers(event.headers); headers.delete('chatgpt-account-id'); headers.set('authorization', `Bearer ${key}`);
        event.headers = Object.fromEntries(headers.entries());
        sockets.set(event.sessionID, { directory: actual.directory, controllerInstanceID: proof.controllerInstanceID,
          acquisition: proof.acquisition, credentialID: proof.selected.credentialID, generation: fingerprint([proof.controllerInstanceID, proof.selected.credentialID, proof.selected.value]) }); return;
      }
      return yield* deny('native_openai_socket_changed');
    }
    if (name === 'http.request' && http(event)) {
      const url = codexURL(event.request.url, false);
      if (!url) return yield* deny('native_openai_route_unreviewed');
      const headers = new Headers(event.request.headers);
      headers.set('authorization', `Bearer ${attempt.accessToken}`); headers.set('chatgpt-account-id', attempt.accountId);
      event.request = new Request(url, new Request(event.request, { headers })); return;
    }
    if (name === 'experimental.ws.handshake' && handshake(event)) {
      const url = codexURL(event.url, true);
      if (!url) return yield* deny('native_openai_route_unreviewed');
      const headers = new Headers(event.headers);
      headers.set('authorization', `Bearer ${attempt.accessToken}`); headers.set('chatgpt-account-id', attempt.accountId);
      event.url = url; event.headers = Object.fromEntries(headers.entries());
      sockets.set(event.sessionID, { directory: actual.directory, controllerInstanceID: proof.controllerInstanceID,
        acquisition: proof.acquisition, generation: attempt.generation, credentialID: attempt.credentialID, accountId: attempt.accountId }); return;
    }
    return yield* deny('native_openai_hook_invalid');
  });
  const decorateHooks = (inner: PluginHooks.Interface): PluginHooks.Interface => ({ ...inner,
    has: (domain, name, providerID) => domain === 'session' && (providerID === undefined || providerID === 'openai')
      && ['http.request', 'experimental.ws.handshake', 'experimental.ws.send'].includes(String(name)) ? Effect.succeed(true) : inner.has(domain, name, providerID),
    trigger: (domain, name, event) => Effect.suspend(() => {
      const original = domain === 'session' && ['http.request', 'experimental.ws.handshake', 'experimental.ws.send'].includes(String(name))
        && physical(event) && event.model.providerID === 'openai'
        ? { sessionID: event.sessionID, kind: event.kind, modelFingerprint: fingerprint(event.model) } : undefined;
      return inner.trigger(domain, name, event).pipe(Effect.tap(result => original ? finalize(name, result, original) : Effect.void));
    }),
  });
  return Object.freeze({ decorateIntegration, decorateCredential, decorateHooks, closeLocation,
    readSelectedOwned: (input: { directory: string }) => Effect.runPromise(selected(input.directory).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })))),
    compareAndSwapSelectedOwned: (input: { directory: string; expected: NativeOpenAiSelected; next: Credential.Value }) => Effect.runPromise(Effect.gen(function* () {
      const store = credentials, expected = structuredClone(input.expected), next = Schema.decodeUnknownSync(Credential.Value)(input.next);
      if (!store || expected.directory !== input.directory || expected.controllerInstanceID !== identity()
        || expected.integrationID !== 'openai' || expected.value.type !== 'oauth' || next.type !== 'oauth'
        || next.methodID !== expected.value.methodID || !methods.has(next.methodID)) return false;
      if (fingerprint({ ...expected.value, access: undefined, refresh: undefined, expires: undefined })
        !== fingerprint({ ...next, access: undefined, refresh: undefined, expires: undefined })) return false;
      const current = yield* selected(input.directory);
      if (!current || fingerprint(current) !== fingerprint(expected)) return false;
      if (identity() !== expected.controllerInstanceID) return false;
      yield* store.update(Schema.decodeUnknownSync(Credential.ID)(expected.credentialID), { value: next });
      return identity() === expected.controllerInstanceID;
    }).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })))),
  });
}
