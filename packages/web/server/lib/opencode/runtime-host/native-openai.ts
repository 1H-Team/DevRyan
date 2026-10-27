import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import type { Location } from '@opencode/core/location';
import { Location as NativeLocation } from '@opencode/core/location';
import type { PluginHooks } from '@opencode/core/plugin/hooks';
import { Context, Effect, Logger, Option, Schema } from 'effect';
import { CredentialAuthorizationRef, CredentialMutationReauthorizeRef, CredentialResolutionScopeRef, type WithCredentialMutation, type WithCredentialResolution, type CredentialResolutionBinding, type CredentialMutationBinding } from './credential-mutation-contract.js';
import type { NativeOpenAiSelected } from './native-openai-auth.js';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { credentialMutationFingerprint as fingerprint } from './native-credential-mutation-owner.js';
import { RegistrationOriginRef, type RegistrationOrigin } from './registration-origin.js';
import type { ProviderCredentialLocation } from './controller-provider-credentials.js';
import { OperationPermitRef, requestPermit, type OperationPermit } from './native-admission-contract.js';

const methods = new Set(['chatgpt-token-sharing', 'chatgpt-browser']);
const retired = new Set(['chatgpt-siwc', 'chatgpt-headless']);
const openaiID = Schema.decodeUnknownSync(Integration.ID)('openai');
const projectCatalog = (info: Integration.Info): Integration.Info => info.id !== openaiID ? info : {
  ...info, methods: info.methods.filter(method => method.type !== 'oauth' || method.id === 'chatgpt-browser'),
};
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
function responsesURL(input: string, websocket: boolean, methodID: string): string | undefined {
  if (websocket) return undefined;
  const url = new URL(input);
  if (url.username || url.password || url.protocol !== 'https:') return undefined;
  const legacy = methodID === 'chatgpt-browser';
  if (url.hostname !== (legacy ? 'chatgpt.com' : 'api.openai.com') || url.port !== ''
    || url.pathname !== (legacy ? '/backend-api/codex/responses' : '/v1/responses') || url.search || url.hash) return undefined;
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
  withCredentialResolution: WithCredentialResolution;
  captureLocation(directory: string): ProviderCredentialLocation;
  assertResolution(binding: CredentialResolutionBinding): Effect.Effect<void>;
  reviewedNativeProviderOrigin?: RegistrationOrigin;
  reviewedNativeCodexOrigin?: RegistrationOrigin;
  withCredentialMutation: WithCredentialMutation;
  captureOAuthGrant(input: { readonly directory: string; readonly controllerInstanceID: string; readonly integrationID: 'openai'; readonly methodID: string }): Effect.Effect<{ readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> }>;
}

/** OpenCode owns OAuth and transport; the host owns admission and serialized commits. */
export function createNativeOpenAi(options: NativeOpenAiOptions) {
  let credentials: Credential.Interface | undefined;
  interface ResolutionCommit { readonly original: Credential.Info; readonly reauthorize: Effect.Effect<void>; readonly assertSelected: Effect.Effect<void>; readonly assertCurrent: () => void; active: boolean; committed: boolean; result?: Credential.OAuth }
  const Commit = Context.Reference<ResolutionCommit | undefined>('DevRyan/OpenAiCredentialCommit', { defaultValue: () => undefined });
  const pendingResolutions = new Set<{ record: Credential.Info }>();
  const selections = new WeakMap<OperationPermit, { readonly acquisition: Acquisition; readonly record: Credential.Info }>();
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
    if (value.type === 'oauth' && !methods.has(value.methodID)
      && !(operation === 'remove' && retired.has(value.methodID))) return yield* deny('native_openai_method_unsupported');
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
      const commit = yield* Commit;
      if (commit) {
        if (!commit.active || operation !== 'update' || commit.committed || !commit.result || id !== commit.original.id
          || fingerprint(record) !== fingerprint(commit.original)
          || fingerprint(request) !== fingerprint({ id, updates: { value: commit.result } })) return yield* deny('native_openai_resolution_commit_invalid');
        commit.assertCurrent(); yield* commit.reauthorize; yield* commit.assertSelected; yield* commit.reauthorize; commit.assertCurrent();
        const result = yield* action; commit.committed = true; return result;
      }
      if (operation === 'update' && record.value.type === 'oauth' && requestedValue) return yield* deny('native_openai_resolution_scope_required');
      return yield* mutation(operation, record, requestedValue ?? record.value, request, action);
    });
    return { ...inner,
      create: input => {
        const copy = structuredClone(input);
        return copy.integrationID === openaiID ? mutation('create', undefined, copy.value, copy, inner.create(copy)) : inner.create(copy);
      },
      update: (id, updates) => { const copy = structuredClone(updates); return Effect.gen(function* () {
        const record = yield* inner.get(id);
        // OpenCode's startup migration must not revive a retired sign-in.
        if (record?.integrationID === openaiID && record.value.type === 'oauth' && copy.value &&
          (copy.value.type !== 'oauth' || copy.value.methodID !== record.value.methodID)) {
          yield* Effect.logWarning('native_openai_method_migration_ignored'); return;
        }
        yield* existing('update', id, { id, updates: copy }, inner.update(id, copy), copy.value);
      }); },
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
    const assertSelected = (original: Credential.Info, expected: Credential.Value = original.value) => Effect.gen(function* () {
      const current = yield* selected(directory);
      if (!current || current.credentialID !== original.id || fingerprint(current.value) !== fingerprint(expected)) return yield* deny('native_credential_changed');
      requireCurrent(acquisition);
    });
    const transform: Integration.Interface['transform'] = callback => Effect.gen(function* () {
      requireCurrent(acquisition); const origin = yield* RegistrationOriginRef;
      return yield* inner.transform(editor => callback({ ...editor, method: { ...editor.method, update: implementation => {
        if (implementation.integrationID !== openaiID || !('authorize' in implementation)) return editor.method.update(implementation);
        if (!methods.has(implementation.method.id)) return editor.method.update({ ...implementation,
          authorize: () => deny('native_openai_method_unsupported'),
          ...(implementation.refresh ? { refresh: () => deny('native_openai_method_unsupported') } : {}),
        });
        const legacy = implementation.method.id === 'chatgpt-browser';
        const reviewed = legacy ? options.reviewedNativeCodexOrigin : options.reviewedNativeProviderOrigin;
        if (!origin || !reviewed || origin.kind !== 'native' || origin.id !== (legacy ? 'opencode.provider.openai' : 'opencode.provider.chatgpt')
          || fingerprint(origin) !== fingerprint(reviewed)) throw new HostRefusal('native_openai_registration_unreviewed', 403, 'provider.openai');
        const original = implementation, refresh = implementation.refresh;
        editor.method.update({ ...original, authorize: answer => Effect.gen(function* () {
          if (!legacy) return yield* deny('native_openai_method_unsupported');
          const authorization = yield* OAuthAuthorization;
          if (!authorization || authorization.acquisition !== acquisition) return yield* deny('native_openai_oauth_scope_required');
          const checked = <A, E, R>(action: Effect.Effect<A, E, R>) => Effect.gen(function* () {
            yield* authorization.grant.reauthorize; requireCurrent(acquisition);
            const result = yield* action;
            yield* authorization.grant.reauthorize; requireCurrent(acquisition); return result;
          });
          const result = yield* checked(original.authorize(answer));
          return result.mode === 'auto' ? { ...result, callback: checked(result.callback) }
            : { ...result, callback: code => checked(result.callback(code)) };
        }), ...(refresh ? { refresh: value => Effect.gen(function* () {
          const commit = yield* Commit;
          if (!commit?.active || commit.original.value.type !== 'oauth' || fingerprint(value) !== fingerprint(commit.original.value)) return yield* deny('native_openai_resolution_scope_required');
          yield* commit.reauthorize; commit.assertCurrent();
          const result = yield* refresh(value);
          if (result.methodID !== value.methodID || !result.access || !result.refresh) return yield* deny('native_openai_method_unsupported');
          yield* commit.reauthorize; commit.assertCurrent(); commit.result = structuredClone(result); return result;
        }) } : {}) });
      } } }));
    });
    const resolve: Integration.Interface['connection']['resolve'] = connection => Effect.suspend(() => {
      let pending: { record: Credential.Info } | undefined;
      return Effect.gen(function* () {
        requireCurrent(acquisition);
        if (connection.type !== 'credential' || !credentials) return yield* inner.connection.resolve(connection);
        const observed = yield* credentials.get(connection.id); requireCurrent(acquisition);
        if (!observed || observed.integrationID !== openaiID || observed.value.type !== 'oauth') return yield* inner.connection.resolve(connection);
        if (retired.has(observed.value.methodID) || observed.value.methodID === 'chatgpt-browser' && typeof observed.value.metadata?.clientID === 'string') return undefined;
        if (!methods.has(observed.value.methodID)) return yield* deny('native_openai_method_unsupported');
        const scope = yield* CredentialResolutionScopeRef;
        if (!scope) return structuredClone(observed.value);
        let original: Credential.Info = observed;
        if (!scope.active || scope.directory !== directory || scope.permit.sessionID !== scope.sessionID) return yield* deny('native_openai_resolution_scope_required');
        const captured = options.captureLocation(directory); captured.assertCurrent();
        pending = { record: original }; pendingResolutions.add(pending);
        let binding: CredentialResolutionBinding = { kind: 'openai', integrationID: 'openai', valueType: 'oauth',
          methodID: observed.value.methodID === 'chatgpt-browser' ? 'chatgpt-browser' : 'chatgpt-token-sharing',
          directory, controllerInstanceID: acquisition.controllerInstanceID, acquisitionID: captured.acquisitionID, configurationDigest: captured.configurationDigest,
          sessionID: scope.sessionID, permit: scope.permit, credentialID: original.id, expectedFingerprint: fingerprint(original) };
        const reauthorize = Effect.gen(function* () {
          if (!scope.active) return yield* deny('native_openai_resolution_scope_required');
          requireCurrent(acquisition); captured.assertCurrent(); yield* options.assertResolution(binding); requireCurrent(acquisition); captured.assertCurrent();
        });
        let expected: Credential.Value = original.value;
        const result = yield* options.withCredentialResolution(binding, reauthorize, Effect.gen(function* () {
          if (!pending) return yield* deny();
          original = pending.record; expected = original.value;
          binding = { ...binding, expectedFingerprint: fingerprint(original) };
          yield* reauthorize; yield* assertSelected(original);
          const commit: ResolutionCommit = { original, reauthorize, assertSelected: assertSelected(original), assertCurrent: () => { requireCurrent(acquisition); captured.assertCurrent(); }, active: true, committed: false };
          return yield* Effect.gen(function* () {
            const resolved = yield* inner.connection.resolve(connection).pipe(Effect.provideService(Commit, commit), Effect.timeout('60 seconds'), Effect.catchTag('TimeoutError', () => deny('native_openai_resolution_timeout')));
            if (commit.result && !commit.committed) return yield* deny('native_openai_resolution_not_committed');
            expected = commit.result ?? original.value;
            yield* assertSelected(original, expected); yield* reauthorize;
            if (commit.result) {
              const previous = fingerprint(original), refreshed = structuredClone({ ...original, value: expected });
              for (const waiting of pendingResolutions) if (fingerprint(waiting.record) === previous) waiting.record = refreshed;
              original = refreshed;
            }
            return resolved;
          }).pipe(Effect.ensuring(Effect.sync(() => { commit.active = false; })));
        }));
        yield* reauthorize;
        selections.set(scope.permit, { acquisition, record: structuredClone({ ...original, value: expected }) });
        return result;
      }).pipe(Effect.ensuring(Effect.sync(() => { if (pending) pendingResolutions.delete(pending); })));
    });
    return { ...inner, transform, reload: () => live(inner.reload()),
      get: id => live(inner.get(id).pipe(Effect.map(info => info ? projectCatalog(info) : info))),
      list: () => live(inner.list().pipe(Effect.map(rows => rows.map(projectCatalog)))),
      connection: { ...inner.connection, key: input => input.integrationID === openaiID
        ? live(inner.connection.key(input).pipe(Effect.provideService(NativeLocation.Service,acquisition.location))) : inner.connection.key(input),
      activate: id => connectionMutation(id,inner.connection.activate(id)),
      update: (id,updates) => connectionMutation(id,inner.connection.update(id,updates)),
      remove: id => connectionMutation(id,inner.connection.remove(id)), active: id => id === openaiID ? live(inner.connection.active(id)) : inner.connection.active(id), resolve }, oauth: { ...inner.oauth,
      connect: input => input.integrationID !== openaiID ? inner.oauth.connect(input) : Effect.gen(function* () {
        requireCurrent(acquisition);
        if (input.methodID !== 'chatgpt-browser') return yield* deny('native_openai_method_unsupported');
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
    if (before.value.type !== 'oauth' || !methods.has(before.value.methodID)) return yield* deny('native_openai_method_unsupported');
    const proof = selections.get(permit);
    if (!proof || proof.acquisition !== acquisition || proof.record.id !== before.credentialID) return yield* deny('native_openai_resolution_proof_required');
    if (fingerprint(proof.record.value) !== fingerprint(before.value)) return yield* deny('native_credential_changed');
    yield* options.assertAttempt(attemptInput); requireCurrent(acquisition);
    if (!options.isExecutionReady()) return yield* deny('native_openai_startup_held');
    return { acquisition, controllerInstanceID, selected: before, attempt: { accessToken: before.value.access } };
  });
  const finalize = (name: PropertyKey, event: unknown, original: { sessionID: string; kind: string; modelFingerprint: string }): Effect.Effect<void> => Effect.gen(function* () {
    if (!physical(event) || event.sessionID !== original.sessionID || event.kind !== original.kind
      || fingerprint(event.model) !== original.modelFingerprint) return yield* deny('native_openai_hook_identity_changed');
    const actual = yield* location();
    const proof = yield* fresh(actual.directory, event); requireCurrent(proof.acquisition);
    if (name === 'experimental.ws.send' && send(event)) {
      const socket = sockets.get(event.sessionID);
      const key = proof.selected?.value.type === 'key' ? proof.selected : undefined;
      const generation = key ? fingerprint([proof.controllerInstanceID, key.credentialID, key.value]) : undefined;
      if (!socket || socket.directory !== actual.directory || socket.controllerInstanceID !== proof.controllerInstanceID
        || socket.generation !== generation || socket.credentialID !== key?.credentialID) return yield* deny('native_openai_socket_changed');
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
      const value = proof.selected?.value;
      if (value?.type !== 'oauth') return yield* deny('native_openai_method_unsupported');
      const url = responsesURL(event.request.url, false, value.methodID);
      if (!url) return yield* deny('native_openai_route_unreviewed');
      const headers = new Headers(event.request.headers);
      headers.set('authorization', `Bearer ${attempt.accessToken}`);
      headers.delete('chatgpt-account-id');
      if (value.methodID === 'chatgpt-browser' && typeof value.metadata?.accountID === 'string') headers.set('chatgpt-account-id', value.metadata.accountID);
      event.request = new Request(event.request, { headers }); return;
    }
    if (name === 'experimental.ws.handshake' && handshake(event)) {
      // DevRyan qualifies both native OAuth flows over HTTP.
      return yield* deny('native_openai_route_unreviewed');
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
    requiresOpenAiHttp: (directory: string): Effect.Effect<boolean> => selected(directory).pipe(Effect.map(current => current?.value.type === 'oauth' && methods.has(current.value.methodID) && !(current.value.methodID === 'chatgpt-browser' && typeof current.value.metadata?.clientID === 'string'))),
    isOpenAiTokenSharing: (directory: string): Effect.Effect<boolean> => selected(directory).pipe(Effect.map(current => current?.value.type === 'oauth' && current.value.methodID === 'chatgpt-token-sharing')),
    readSelectedOwned: (input: { directory: string }) => Effect.runPromise(selected(input.directory).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })))),
    compareAndSwapSelectedOwned: async (_input: { directory: string; expected: NativeOpenAiSelected; next: Credential.Value }) => false,
  });
}
