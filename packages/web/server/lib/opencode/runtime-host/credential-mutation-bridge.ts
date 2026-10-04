import { randomUUID } from 'node:crypto';
import { Effect, Exit, Fiber } from 'effect';
import type { CredentialMutationBinding, CredentialResolutionBinding, WithCredentialMutation, WithCredentialResolution } from './credential-mutation-contract.js';
import { CredentialMutationReauthorizeRef } from './credential-mutation-contract.js';
import { credentialMutationFingerprint, parseCredentialMutationBinding, parseCredentialResolutionBinding, type CredentialMutationControl, type CredentialMutationRequest } from './native-credential-mutation-owner.js';
import { HostRefusal } from './host-refusal.js';

export interface CredentialMutationAuthorization { readonly authorizationID: string; readonly reauthorize: Effect.Effect<void> }
export interface CredentialMutationBridgeOptions {
  readonly controllerInstanceID: string;
  readonly rpc: (method: string, input: CredentialMutationRequest, options: { readonly signal: AbortSignal }) => Promise<unknown>;
  readonly captureAuthorization: (binding: CredentialMutationBinding) => Effect.Effect<CredentialMutationAuthorization>;
}
interface PendingAction { readonly fingerprint: string; state: 'queued' | 'running' | 'settled' | 'closed';
  readonly run: () => Promise<void>; readonly stop: () => Promise<void> }
const refused = (code: string) => new HostRefusal(code, 403, 'credential.mutation');

/** Store the native action privately. The queue owner sees only its settled
 * acknowledgement; the original generic value/error remains in this Effect. */
export function createCredentialMutationBridge(options: CredentialMutationBridgeOptions) {
  const pending = new Map<string, PendingAction>();
  let closed = false;
  const queued = <A,E,R>(binding:CredentialMutationBinding|CredentialResolutionBinding, authorization:CredentialMutationAuthorization|undefined,
    reauthorize:Effect.Effect<void>, method:'credential.mutation.commit'|'credential.resolution.commit', action:Effect.Effect<A,E,R>) => Effect.gen(function*(){
    if(closed||binding.controllerInstanceID!==options.controllerInstanceID)throw refused('native_credential_mutation_closed');
    yield* reauthorize;
    const context = yield* Effect.context<R>();
    const callID = randomUUID(), fingerprint = credentialMutationFingerprint(binding);
    let result: Exit.Exit<A, E> | undefined;
    let fiber: Fiber.Fiber<A, E> | undefined;
    let settlement: Promise<void> | undefined;
    const entry: PendingAction = {
      fingerprint, state: 'queued',
      run: () => {
        if (closed || entry.state !== 'queued') return Promise.reject(refused('native_credential_mutation_replayed'));
        entry.state = 'running';
        fiber = Effect.runForkWith(context)(reauthorize.pipe(Effect.andThen(action.pipe(
          Effect.provideService(CredentialMutationReauthorizeRef, reauthorize)))));
        settlement = Effect.runPromise(Fiber.await(fiber)).then(exit => {
          result = exit; entry.state = 'settled';
          if (Exit.isFailure(exit)) throw refused('native_credential_mutation_failed');
        });
        return settlement;
      },
      stop: async () => {
        if (entry.state === 'queued') entry.state = 'closed';
        if (fiber && entry.state === 'running') await Effect.runPromise(Fiber.interrupt(fiber));
        if (settlement) await settlement.catch(() => {});
      },
    };
    if (closed) throw refused('native_credential_mutation_closed');
    pending.set(callID, entry);
    return yield* Effect.gen(function* () {
      const rpcResult = yield* Effect.exit(Effect.promise(signal => options.rpc(method, {
        callID, controllerInstanceID: options.controllerInstanceID, binding, bindingFingerprint: fingerprint,
        authorizationID: authorization?.authorizationID ?? callID,
      }, { signal })));
      if (result && Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      if (Exit.isFailure(rpcResult)) return yield* Effect.failCause(rpcResult.cause);
      if (result && Exit.isSuccess(result)) return result.value;
      throw refused('native_credential_mutation_not_committed');
    }).pipe(Effect.ensuring(Effect.promise(async () => { await entry.stop(); if (pending.get(callID) === entry) pending.delete(callID); })));
  });
  const withCredentialMutation:WithCredentialMutation=<A,E,R>(input:CredentialMutationBinding,action:Effect.Effect<A,E,R>)=>Effect.gen(function*(){
    const binding=parseCredentialMutationBinding(input);
    if(closed||binding.controllerInstanceID!==options.controllerInstanceID)throw refused('native_credential_mutation_closed');
    const authorization=yield* options.captureAuthorization(binding);
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(authorization.authorizationID))throw refused('native_credential_mutation_authorization_required');
    return yield* queued(binding,authorization,authorization.reauthorize,'credential.mutation.commit',action);
  });
  const withCredentialResolution:WithCredentialResolution=<A,E,R>(input:CredentialResolutionBinding,reauthorize:Effect.Effect<void>,action:Effect.Effect<A,E,R>)=>
    queued(parseCredentialResolutionBinding(input),undefined,reauthorize,'credential.resolution.commit',action);
  const commitOwned = async (control: CredentialMutationControl): Promise<void> => {
    if (closed || control.controllerInstanceID !== options.controllerInstanceID) throw refused('native_credential_mutation_closed');
    const entry = pending.get(control.callID);
    if (!entry || entry.fingerprint !== control.bindingFingerprint) throw refused('native_credential_mutation_binding_invalid');
    await entry.run();
  };
  const close = async () => { closed = true; await Promise.all([...pending.values()].map(entry => entry.stop())); pending.clear(); };
  return { withCredentialMutation, withCredentialResolution, commitOwned, close };
}
