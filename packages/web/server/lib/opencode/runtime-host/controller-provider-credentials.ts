import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import { Location } from '@opencode/core/location';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import { SessionRunnerModel } from '@opencode/core/session/runner/model';
import { Context, Effect, Layer, Option } from 'effect';
import { OperationPermitRef, requestPermit, type OperationPermit } from './native-admission-contract.js';
import { CredentialAuthorizationRef, CredentialMutationReauthorizeRef, isOwnedProviderIntegration,
  type OwnedProviderIntegration, type CredentialMutationBinding, type CredentialResolutionBinding,
  type WithCredentialMutation, type WithCredentialResolution } from './credential-mutation-contract.js';
import { credentialMutationFingerprint as fingerprint } from './native-credential-mutation-owner.js';
import { RegistrationOriginRef, type RegistrationOrigin } from './registration-origin.js';
import { HostRefusal } from './host-refusal.js';

export interface ProviderCredentialLocation {
  readonly acquisitionID: string; readonly configurationDigest: string; readonly assertCurrent: () => void;
}
export interface ProviderPhysicalAttempt {
  readonly controllerInstanceID: string; readonly directory: string; readonly sessionID: string;
  readonly integrationID: OwnedProviderIntegration; readonly kind: 'primary' | 'title' | 'compaction' | 'generate';
  readonly permit: OperationPermit;
}
export interface ControllerProviderCredentialsOptions {
  readonly controllerInstanceID: string;
  readonly withCredentialMutation: WithCredentialMutation;
  readonly withCredentialResolution: WithCredentialResolution;
  readonly captureLocation: (directory: string, integrationID: OwnedProviderIntegration) => ProviderCredentialLocation;
  readonly assertAttempt: (input: ProviderPhysicalAttempt) => Effect.Effect<void>;
  readonly assertResolution: (binding: CredentialResolutionBinding) => Effect.Effect<void>;
  readonly captureOAuthGrant: (directory: string) => Effect.Effect<{ readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> }>;
  readonly reviewedNativeProviderOrigin?: RegistrationOrigin;
  readonly ownsDelegatedIntegration: (id: string) => boolean;
}
interface ResolutionScope { readonly sessionID: string; readonly directory: string; readonly permit: OperationPermit; active: boolean }
interface ResolutionCommit {
  readonly binding: CredentialResolutionBinding; readonly original: Credential.Info;
  readonly reauthorize: Effect.Effect<void>; readonly assertSelected: Effect.Effect<void>; readonly assertCurrent: () => void;
  result?: Credential.OAuth; committed: boolean; active: boolean;
}
const Resolution = Context.Reference<ResolutionScope | undefined>('DevRyan/ProviderCredentialResolution', { defaultValue: () => undefined });
const Commit = Context.Reference<ResolutionCommit | undefined>('DevRyan/ProviderCredentialCommit', { defaultValue: () => undefined });
const refuse = (code: string): never => { throw new HostRefusal(code, 403, 'credential.provider'); };

/** Original native OAuth implementations remain registered. Only their exact
 * admitted resolution may refresh, and all writes share the existing queue. */
export function createControllerProviderCredentials(options: ControllerProviderCredentialsOptions) {
  let credentials: Credential.Interface | undefined;
  const integrations = new Map<string, Integration.Interface>();
  // Only waiting resolutions inherit a refresh committed by this owner; unrelated writes still refuse.
  const pendingOAuthResolutions = new Set<{ record: Credential.Info }>();
  // Observations belong to this exact admitted Effect object. They issue no
  // authority and disappear with its caller; never key them by Session ID.
  const selections = new WeakMap<OperationPermit, Map<OwnedProviderIntegration, {
    readonly directory: string; readonly acquisitionID: string; readonly record: Credential.Info;
  }>>();
  const oauth = Context.Reference<{ readonly directory: string; readonly grant: { readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> } } | undefined>(
    'DevRyan/ProviderOAuthGrant', { defaultValue: () => undefined });
  const validateValue = (integrationID: OwnedProviderIntegration, value: Credential.Value) => {
    if (value.type === 'oauth' && (integrationID !== 'xai' || value.methodID !== 'device' || !value.refresh)) refuse('native_provider_method_unsupported');
  };
  const decorateSessionRunnerModel = (inner: SessionRunnerModel.Interface, location: Location.Interface): SessionRunnerModel.Interface => ({
    resolve: (session, available) => Effect.gen(function* () {
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID) return refuse('native_provider_resolution_location_invalid');
      const permit = (yield* OperationPermitRef) ?? requestPermit();
      if (!permit || permit.sessionID !== session.id) return yield* inner.resolve(session, available);
      const scope: ResolutionScope = { sessionID: session.id, directory: location.directory, permit, active: true };
      return yield* inner.resolve(session, available).pipe(Effect.provideService(Resolution, scope),
        Effect.ensuring(Effect.sync(() => { scope.active = false; })));
    }),
  });
  const overrides = [SessionRunnerModel.node.replace(SessionRunnerModel.node.mapLayer(original => Layer.effect(SessionRunnerModel.Service, Effect.gen(function* () {
    const inner = yield* SessionRunnerModel.Service;
    const location = Option.getOrUndefined(Context.getOption(yield* Effect.context<never>(), Location.Service));
    if (!location) return refuse('native_provider_location_required');
    return decorateSessionRunnerModel(inner, location);
  })).pipe(Layer.provide(original))))];
  const decorateCredential = (inner: Credential.Interface): Credential.Interface => {
    credentials = inner;
    const mutate = <A,E,R>(operation: CredentialMutationBinding['operation'], before: Credential.Info | undefined,
      integrationID: OwnedProviderIntegration, value: Credential.Value, request: unknown, action: Effect.Effect<A,E,R>) => Effect.gen(function* () {
      validateValue(integrationID, value);
      const location = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
      if (!location) return refuse('native_provider_location_required');
      const captured = options.captureLocation(location.directory, integrationID), grant = yield* oauth;
      if (grant && (integrationID !== 'xai' || value.type !== 'oauth' || grant.directory !== location.directory)) return refuse('native_provider_oauth_scope_invalid');
      captured.assertCurrent();
      const original = before ? structuredClone(before) : undefined;
      const binding: CredentialMutationBinding = { kind: 'provider', integrationID, directory: location.directory,
        controllerInstanceID: options.controllerInstanceID, operation, requestedFingerprint: fingerprint(request),
        ...(original ? { credentialID: original.id, expectedFingerprint: fingerprint(original) } : {}),
        ...(value.type === 'oauth' ? { valueType: 'oauth', methodID: value.methodID } : { valueType: 'key' }) };
      return yield* options.withCredentialMutation(binding, Effect.gen(function* () {
        captured.assertCurrent();
        if (original && fingerprint(yield* inner.get(original.id)) !== fingerprint(original)) return refuse('native_credential_changed');
        if (fingerprint(request) !== binding.requestedFingerprint) return refuse('native_credential_changed');
        if (grant) yield* grant.grant.reauthorize;
        const reauthorize = yield* CredentialMutationReauthorizeRef;
        if (!reauthorize) return refuse('native_credential_mutation_authorization_required');
        yield* reauthorize; captured.assertCurrent();
        return yield* action;
      })).pipe(Effect.provideService(CredentialAuthorizationRef, grant?.grant.authorizationID ?? (yield* CredentialAuthorizationRef)));
    });
    const existing = <A,E,R>(operation: CredentialMutationBinding['operation'], id: Credential.ID, request: unknown,
      action: Effect.Effect<A,E,R>, value?: Credential.Value) => Effect.gen(function* () {
      const before = yield* inner.get(id);
      if (!before) return refuse('native_credential_changed');
      if (!isOwnedProviderIntegration(before.integrationID)) {
        if (!options.ownsDelegatedIntegration(before.integrationID)) return refuse('native_credential_mutation_denied');
        return yield* action;
      }
      const resolution = yield* Commit;
      if (resolution) {
        if (!resolution.active || operation !== 'update' || resolution.committed || !resolution.result
          || id !== resolution.original.id || fingerprint(before) !== fingerprint(resolution.original)
          || fingerprint(request) !== fingerprint({ id, updates: { value: resolution.result } })) return refuse('native_provider_resolution_commit_invalid');
        resolution.assertCurrent(); yield* resolution.reauthorize; yield* resolution.assertSelected; yield* resolution.reauthorize; resolution.assertCurrent();
        const result = yield* action; resolution.committed = true; return result;
      }
      return yield* mutate(operation, before, before.integrationID, value ?? before.value, request, action);
    });
    return { ...inner,
      create: input => { const copy = structuredClone(input); return Effect.gen(function* () {
        if (isOwnedProviderIntegration(copy.integrationID)) return yield* mutate('create', undefined, copy.integrationID, copy.value, copy, inner.create(copy));
        if (!options.ownsDelegatedIntegration(copy.integrationID)) return refuse('native_credential_mutation_denied');
        return yield* inner.create(copy);
      }); },
      update: (id, updates) => { const copy = structuredClone(updates); return existing('update', id, { id, updates: copy }, inner.update(id, copy), copy.value); },
      activate: id => existing('activate', id, { id }, inner.activate(id)),
      remove: id => existing('remove', id, { id }, inner.remove(id)),
    };
  };
  const assertSelected = (directory: string, original: Credential.Info, expected: Credential.Value = original.value) => Effect.gen(function* () {
    if (!isOwnedProviderIntegration(original.integrationID)) return refuse('native_provider_resolution_scope_required');
    const capture = options.captureLocation(directory, original.integrationID), inner = integrations.get(directory); capture.assertCurrent();
    if (!inner) return refuse('native_provider_location_required');
    const active = yield* inner.connection.active(original.integrationID), latest = credentials ? yield* credentials.get(original.id) : undefined;
    capture.assertCurrent();
    if (active?.type !== 'credential' || active.id !== original.id || fingerprint(latest) !== fingerprint({ ...original, value: expected })) return refuse('native_credential_changed');
  });
  const decorateIntegration = (inner: Integration.Interface, location: Location.Interface): Integration.Interface => {
    integrations.set(location.directory, inner);
    const acquired = options.captureLocation(location.directory, 'xai');
    const current = (id: OwnedProviderIntegration) => {
      acquired.assertCurrent();
      const captured = options.captureLocation(location.directory, id);
      if (captured.acquisitionID !== acquired.acquisitionID) return refuse('native_integration_acquisition_expired');
      return captured;
    };
    const transform: Integration.Interface['transform'] = callback => Effect.gen(function* () {
      acquired.assertCurrent();
      const origin = yield* RegistrationOriginRef;
      return yield* inner.transform(editor => callback({ ...editor, method: { ...editor.method,
      update: implementation => {
        if (!isOwnedProviderIntegration(implementation.integrationID) || !('authorize' in implementation)) return editor.method.update(implementation);
        if (implementation.integrationID !== 'xai' || implementation.method.id !== 'device') return editor.method.update({ ...implementation,
          authorize: () => Effect.sync(() => refuse('native_provider_method_unsupported')),
          ...implementation.refresh ? { refresh: () => Effect.sync(() => refuse('native_provider_method_unsupported')) } : {},
        });
        const reviewed = options.reviewedNativeProviderOrigin;
        if (!origin || !reviewed || origin.kind !== 'native' || origin.id !== 'opencode.provider.xai'
          || fingerprint(origin) !== fingerprint(reviewed)) return refuse('native_provider_registration_unreviewed');
        const original = implementation, refresh = implementation.refresh;
        const wrapped: Integration.OAuthImplementation = { ...original,
          authorize: answer => Effect.gen(function* () {
            const grant = yield* oauth;
            if (!grant || grant.directory !== location.directory) return refuse('native_provider_oauth_scope_invalid');
            yield* grant.grant.reauthorize; current('xai').assertCurrent();
            const captured = options.captureLocation(location.directory,'xai'); captured.assertCurrent();
            const authorization = yield* original.authorize(answer);
            yield* grant.grant.reauthorize; captured.assertCurrent();
            const checked = <A,E,R>(action: Effect.Effect<A,E,R>) => Effect.gen(function* () {
              yield* grant.grant.reauthorize; captured.assertCurrent();
              const result = yield* action;
              yield* grant.grant.reauthorize; captured.assertCurrent(); return result;
            });
            return authorization.mode === 'auto' ? { ...authorization, callback: checked(authorization.callback) }
              : { ...authorization, callback: code => checked(authorization.callback(code)) };
          }),
          ...(refresh ? { refresh: value => Effect.gen(function* () {
            const commit = yield* Commit;
            if (!commit?.active || commit.original.value.type !== 'oauth' || fingerprint(value) !== fingerprint(commit.original.value)) return refuse('native_provider_resolution_scope_required');
            yield* commit.reauthorize; commit.assertCurrent();
            const result = yield* refresh(value);
            validateValue('xai', result); yield* commit.reauthorize; commit.assertCurrent();
            commit.result = structuredClone(result); return result;
          }) } : {}),
        };
        editor.method.update(wrapped);
      },
    } }));
    });
    const resolve: Integration.Interface['connection']['resolve'] = connection => Effect.suspend(() => {
      let pending: { record: Credential.Info } | undefined;
      return Effect.gen(function* () {
      if (connection.type !== 'credential' || !credentials) return yield* inner.connection.resolve(connection);
      const observed = yield* credentials.get(connection.id);
      if (!observed || !isOwnedProviderIntegration(observed.integrationID)) return yield* inner.connection.resolve(connection);
      const integrationID = observed.integrationID;
      let original: Credential.Info = observed;
      validateValue(integrationID, original.value);
      if (original.value.type === 'oauth') {
        pending = { record: original };
        pendingOAuthResolutions.add(pending);
      }
      const scope = yield* Resolution;
      if (!scope?.active || scope.directory !== location.directory || scope.permit.sessionID !== scope.sessionID) return yield* Effect.fail(new Integration.AuthorizationError({cause:new HostRefusal('native_provider_resolution_scope_required',403,'credential.provider')}));
      const capture = current(integrationID); capture.assertCurrent();
      let binding: CredentialResolutionBinding = { kind: 'provider', integrationID,
        ...(original.value.type === 'key' ? {valueType:'key' as const} : {valueType:'oauth' as const,integrationID:'xai' as const,methodID:'device' as const}),
        directory: location.directory, controllerInstanceID: options.controllerInstanceID, acquisitionID: capture.acquisitionID,
        configurationDigest: capture.configurationDigest, sessionID: scope.sessionID, permit: scope.permit,
        credentialID: original.id, expectedFingerprint: fingerprint(original) };
      const reauthorize = Effect.gen(function* () { if (!scope.active) return refuse('native_provider_resolution_scope_required');
        capture.assertCurrent(); yield* options.assertResolution(binding); capture.assertCurrent(); });
      let expected = original.value;
      const resolveOAuth = Effect.gen(function* () {
        if (pending) {
          original = pending.record;
          expected = original.value;
          binding = { ...binding, expectedFingerprint: fingerprint(original) };
        }
        yield* reauthorize; yield* assertSelected(location.directory, original);
        const commit: ResolutionCommit = { binding, original, reauthorize, assertSelected: assertSelected(location.directory, original), assertCurrent: capture.assertCurrent, active: true, committed: false };
        return yield* Effect.gen(function* () {
          const result = yield* inner.connection.resolve(connection).pipe(Effect.provideService(Commit, commit));
          if (commit.result && !commit.committed) return refuse('native_provider_resolution_not_committed');
          expected = commit.result ?? original.value;
          yield* assertSelected(location.directory, original, expected); yield* reauthorize;
          if (commit.result) {
            const previous = fingerprint(original), refreshed = structuredClone({ ...original, value: expected });
            for (const waiting of pendingOAuthResolutions) {
              if (fingerprint(waiting.record) === previous) waiting.record = refreshed;
            }
            original = refreshed;
          }
          return result;
        }).pipe(Effect.ensuring(Effect.sync(() => { commit.active = false; })));
      });
      // Read-only key resolution needs no reverse commit or queue slot. The
      // selected record and original caller are checked again before dispatch.
      const result = yield* original.value.type === 'key' ? Effect.gen(function* () {
        yield* reauthorize; yield* assertSelected(location.directory, original);
        const resolved = yield* inner.connection.resolve(connection);
        yield* assertSelected(location.directory, original); yield* reauthorize;
        return resolved;
      }) : options.withCredentialResolution(binding, reauthorize, resolveOAuth);
      yield* reauthorize;
      const proofs = selections.get(scope.permit) ?? new Map();
      proofs.set(original.integrationID, {directory:location.directory,acquisitionID:capture.acquisitionID,record:structuredClone({...original,value:expected})});
      selections.set(scope.permit,proofs);
      return result;
      }).pipe(Effect.ensuring(Effect.sync(() => { if (pending) pendingOAuthResolutions.delete(pending); })));
    });
    const attempts = new Map<Integration.AttemptID, { readonly directory: string; readonly grant: { readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> } }>();
    const ownedAttempt = (input: { integrationID: Integration.ID; attemptID: Integration.AttemptID }) => Effect.gen(function* () {
      const attempt = attempts.get(input.attemptID);
      if (input.integrationID !== 'xai' || !attempt) return refuse('native_provider_attempt_scope_required');
      current('xai').assertCurrent(); yield* attempt.grant.reauthorize; current('xai').assertCurrent(); return attempt;
    });
    const scoped = <A,E,R>(action: Effect.Effect<A,E,R>) => Effect.sync(acquired.assertCurrent).pipe(Effect.andThen(action),Effect.tap(() => Effect.sync(acquired.assertCurrent)),Effect.provideService(Location.Service, location));
    const existingMutation = <A,E,R>(id: Credential.ID, action: Effect.Effect<A,E,R>) => Effect.gen(function* () {
      const record = credentials ? yield* credentials.get(id) : undefined;
      return yield* record && isOwnedProviderIntegration(record.integrationID) ? scoped(action) : action;
    });
    return { ...inner, transform, connection: { ...inner.connection, resolve,
      key: input => isOwnedProviderIntegration(input.integrationID) ? scoped(inner.connection.key(input)) : inner.connection.key(input),
      activate: id => existingMutation(id, inner.connection.activate(id)),
      update: (id, updates) => existingMutation(id, inner.connection.update(id, updates)),
      remove: id => existingMutation(id, inner.connection.remove(id)),
    }, oauth: { ...inner.oauth,
      connect: input => input.integrationID !== 'xai' ? isOwnedProviderIntegration(input.integrationID) ? Effect.sync(() => refuse('native_provider_method_unsupported')) : inner.oauth.connect(input) : Effect.gen(function* () {
        if (input.methodID !== 'device') return refuse('native_provider_method_unsupported');
        const grant = yield* options.captureOAuthGrant(location.directory); yield* grant.reauthorize; current('xai').assertCurrent();
        const scope = { directory: location.directory, grant };
        const attempt = yield* inner.oauth.connect(input).pipe(Effect.provideService(oauth, scope),
          Effect.provideService(CredentialAuthorizationRef, grant.authorizationID), Effect.provideService(Location.Service, location));
        let retained = false;
        return yield* Effect.gen(function* () {
          yield* grant.reauthorize; current('xai').assertCurrent(); attempts.set(attempt.attemptID, scope); retained = true; return attempt;
        }).pipe(Effect.ensuring(Effect.suspend(() => retained ? Effect.void : inner.oauth.cancel({ integrationID: input.integrationID, attemptID: attempt.attemptID }))));
      }),
      status: input => input.integrationID !== 'xai' ? isOwnedProviderIntegration(input.integrationID) ? Effect.sync(() => refuse('native_provider_method_unsupported')) : inner.oauth.status(input) : Effect.gen(function* () {
        const attempt = yield* ownedAttempt(input); const result = yield* inner.oauth.status(input);
        yield* attempt.grant.reauthorize; current('xai').assertCurrent(); return result;
      }),
      complete: input => input.integrationID !== 'xai' ? isOwnedProviderIntegration(input.integrationID) ? Effect.sync(() => refuse('native_provider_method_unsupported')) : inner.oauth.complete(input) : Effect.gen(function* () {
        const attempt = yield* ownedAttempt(input);
        yield* inner.oauth.complete(input).pipe(Effect.provideService(oauth, attempt),
          Effect.provideService(CredentialAuthorizationRef, attempt.grant.authorizationID), Effect.provideService(Location.Service, location));
        yield* attempt.grant.reauthorize; current('xai').assertCurrent();
      }),
      cancel: input => input.integrationID !== 'xai' ? isOwnedProviderIntegration(input.integrationID) ? Effect.sync(() => refuse('native_provider_method_unsupported')) : inner.oauth.cancel(input) : Effect.gen(function* () {
        const attempt = yield* ownedAttempt(input); yield* inner.oauth.cancel(input);
        yield* attempt.grant.reauthorize; current('xai').assertCurrent(); attempts.delete(input.attemptID);
      }),
    } };
  };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const physical = (value: unknown): value is { sessionID: string; kind: ProviderPhysicalAttempt['kind']; model: { providerID: OwnedProviderIntegration } } =>
    record(value) && typeof value.sessionID === 'string' && ['primary','title','compaction','generate'].includes(String(value.kind))
    && record(value.model) && typeof value.model.providerID === 'string' && isOwnedProviderIntegration(value.model.providerID);
  const decorateHooks = (inner: PluginHooks.Interface): PluginHooks.Interface => ({ ...inner,
    trigger: (domain, name, event) => Effect.suspend(() => {
      const guarded = domain === 'session' && ['model.request','http.request','experimental.ws.handshake','experimental.ws.send'].includes(String(name));
      const original = guarded && physical(event) ? fingerprint([event.sessionID,event.kind,event.model]) : undefined;
      return inner.trigger(domain,name,event).pipe(Effect.tap(result => Effect.gen(function* () {
        if (!guarded || !original && !physical(result)) return;
        if (!physical(result) || fingerprint([result.sessionID,result.kind,result.model]) !== original) return refuse('native_provider_hook_identity_changed');
        const location = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
        const permit = (yield* OperationPermitRef) ?? requestPermit();
        if (!location || !permit || permit.sessionID !== result.sessionID) return refuse('native_provider_attempt_scope_required');
        const current = options.captureLocation(location.directory,result.model.providerID); current.assertCurrent();
        const integration = integrations.get(location.directory);
        if (!integration) return refuse('native_provider_location_required');
        const selected = yield* integration.connection.active(Integration.ID.make(result.model.providerID)); current.assertCurrent();
        const proof = selections.get(permit)?.get(result.model.providerID);
        if (selected?.type === 'credential' || proof) {
          if (!proof || proof.directory !== location.directory || proof.acquisitionID !== current.acquisitionID) return refuse('native_provider_resolution_proof_required');
          yield* assertSelected(location.directory,proof.record);
        }
        yield* options.assertAttempt({controllerInstanceID:options.controllerInstanceID,directory:location.directory,
          sessionID:result.sessionID,integrationID:result.model.providerID,kind:result.kind,permit});
        current.assertCurrent();
      })));
    }),
  });
  return { overrides, decorateCredential, decorateIntegration, decorateSessionRunnerModel, decorateHooks };
}
