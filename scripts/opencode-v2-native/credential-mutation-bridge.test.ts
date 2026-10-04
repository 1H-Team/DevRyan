import { expect, test } from 'bun:test';
import { Context, Effect, Fiber, Exit } from 'effect';
import { createCredentialMutationBridge } from '../../packages/web/server/lib/opencode/runtime-host/credential-mutation-bridge.js';
import { createNativeCredentialMutationOwner, type CredentialMutationRequest } from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import type { CredentialMutationBinding } from '../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.js';

const instance = '00000000-0000-4000-8000-000000000001';
const binding: CredentialMutationBinding = { kind: 'openai', valueType: 'key', directory: '/owned/project',
  controllerInstanceID: instance, integrationID: 'openai', operation: 'create', requestedFingerprint: 'a'.repeat(64) };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let queue: Promise<unknown> = Promise.resolve(), revoked = false; let request: CredentialMutationRequest | undefined;
  const bridge = createCredentialMutationBridge({ controllerInstanceID: instance,
    captureAuthorization: () => Effect.succeed({ authorizationID: 'owned_grant', reauthorize: Effect.sync(() => { if (revoked) throw new Error('fixture_revoked'); }) }),
    rpc: (method, input, options) => { request = input; return owner.handleRpc(method, input, options); } });
  const owner = createNativeCredentialMutationOwner({ controllerInstanceID: instance,
    withMutationQueue: work => { const next = queue.then(work); queue = next.catch(() => {}); return next; },
    resolveAuthorization: async () => ({ reauthorize: () => { if (revoked) throw new Error('fixture_revoked'); } }),
    verifyBinding: async actual => { expect(actual).toEqual(binding); }, commitOwned: bridge.commitOwned });
  return { bridge, owner, revoke: () => { revoked = true; }, getRequest: () => { if (!request) throw new Error('Actual request required'); return request; } };
}

test('reverse action preserves original Effect context and result without returning credential values over RPC', async () => {
  const f = fixture(); const Value = Context.Reference<string>('Fixture/CredentialContext', { defaultValue: () => 'absent' });
  const result = await Effect.runPromise(f.bridge.withCredentialMutation(binding, Effect.gen(function* () {
    expect(yield* Value).toBe('original'); return { privateValue: 'owned fixture' };
  })).pipe(Effect.provideService(Value, 'original')));
  expect(result).toEqual({ privateValue: 'owned fixture' });
  await expect(f.bridge.commitOwned(f.getRequest())).rejects.toThrow('native_credential_mutation_binding_invalid');
  await f.bridge.close(); await f.owner.close();
});

test('original typed native action error stays local while queue receives sanitized failure', async () => {
  const f = fixture(), failure = { _tag: 'FixtureMutationFailure' as const, detail: 'local-only' };
  const result = await Effect.runPromise(Effect.exit(f.bridge.withCredentialMutation(binding, Effect.fail(failure))));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) expect(result.cause.reasons[0]).toMatchObject({ error: failure });
  await f.bridge.close(); await f.owner.close();
});

test('forged control cannot start stored action, and original grant is rechecked before native mutation', async () => {
  const gate = deferred(), waiting = deferred(); let calls = 0; let captured: CredentialMutationRequest | undefined;
  const bridge = createCredentialMutationBridge({ controllerInstanceID: instance,
    captureAuthorization: () => Effect.succeed({ authorizationID: 'owned_grant', reauthorize: Effect.void }),
    rpc: async (_method, input) => { captured = input; waiting.resolve(); await gate.promise; await bridge.commitOwned(input); return null; } });
  const run = Effect.runPromise(bridge.withCredentialMutation(binding, Effect.sync(() => { calls++; return 7; })));
  await waiting.promise; if (!captured) throw new Error('Actual captured request required');
  await expect(bridge.commitOwned({ ...captured, bindingFingerprint: 'b'.repeat(64) })).rejects.toThrow('native_credential_mutation_binding_invalid');
  expect(calls).toBe(0); gate.resolve(); expect(await run).toBe(7); expect(calls).toBe(1); await bridge.close();
});

test('interrupt and invalidation await actual native action finalizers before releasing shared queue', async () => {
  const f = fixture(), started = deferred(), finishing = deferred(), allowFinish = deferred();
  const action = Effect.promise(() => { started.resolve(); return new Promise<never>(() => {}); }).pipe(
    Effect.ensuring(Effect.promise(async () => { finishing.resolve(); await allowFinish.promise; })));
  const fiber = Effect.runFork(f.bridge.withCredentialMutation(binding, action)); await started.promise;
  const interrupt = Effect.runPromise(Fiber.interrupt(fiber)); await finishing.promise;
  let closed = false; const close = f.owner.invalidate().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); allowFinish.resolve(); await interrupt; await close; expect(closed).toBe(true);
  await f.bridge.close();
});

test('closing while queued prevents reverse mutation and permanently refuses later work', async () => {
  const waiting = deferred(), gate = deferred(); let calls = 0;
  const bridge = createCredentialMutationBridge({ controllerInstanceID: instance,
    captureAuthorization: () => Effect.succeed({ authorizationID: 'owned_grant', reauthorize: Effect.void }),
    rpc: async (_method, input) => { waiting.resolve(); await gate.promise; await bridge.commitOwned(input); return null; } });
  const run = Effect.runPromise(bridge.withCredentialMutation(binding, Effect.sync(() => { calls++; })));
  const outcome = run.then(() => undefined, error => error);
  await waiting.promise; await bridge.close(); gate.resolve();
  expect(String(await outcome)).toContain('native_credential_mutation_closed'); expect(calls).toBe(0);
  await expect(Effect.runPromise(bridge.withCredentialMutation(binding, Effect.void))).rejects.toThrow('native_credential_mutation_closed');
});

test('captured original native grant revoked while queued refuses when reverse action arrives', async () => {
  const waiting = deferred(), gate = deferred(); let revoked = false, calls = 0;
  const bridge = createCredentialMutationBridge({ controllerInstanceID: instance,
    captureAuthorization: () => Effect.succeed({ authorizationID: 'owned_grant', reauthorize: Effect.sync(() => {
      if (revoked) throw new Error('fixture_revoked');
    }) }), rpc: async (_method, input) => { waiting.resolve(); await gate.promise; await bridge.commitOwned(input); return null; } });
  const run = Effect.runPromise(bridge.withCredentialMutation(binding, Effect.sync(() => { calls++; })));
  const outcome = run.then(() => undefined, error => error);
  await waiting.promise; revoked = true; gate.resolve(); expect(String(await outcome)).toContain('fixture_revoked');
  expect(calls).toBe(0); await bridge.close();
});
