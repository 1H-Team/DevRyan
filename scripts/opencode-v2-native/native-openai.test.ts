import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import { Agent } from '@opencode/core/agent';
import { SessionSchema } from '@opencode/core/session/schema';
import { Model } from '@opencode/schema/model';
import type { SessionHttpRequest } from '@opencode/plugin/effect/session';
import { Location } from '@opencode/core/location';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import { Global } from '@opencode/util/global';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Effect, Layer, Schema, type Scope } from 'effect';
import { createNativeOpenAi, type NativeOpenAiOptions } from '../../packages/web/server/lib/opencode/runtime-host/native-openai.js';
import { CredentialMutationReauthorizeRef, CredentialResolutionScopeRef } from '../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.js';
import { OperationPermitRef } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { RegistrationOriginRef } from '../../packages/web/server/lib/opencode/runtime-host/registration-origin.js';

const openai = Integration.ID.make('openai'), methodID = Integration.MethodID.make('chatgpt-token-sharing');
const origin = { kind: 'native', id: 'opencode.provider.chatgpt', manifestDigest: 'b'.repeat(64), capabilities: ['provider'] } as const;
const codexOrigin = { ...origin, id: 'opencode.provider.openai' } as const;
const legacyMethodID = Integration.MethodID.make('chatgpt-browser');
const permit = { token: 'a'.repeat(64), revision: 0, sessionID: 'ses_openai_fixture' };
const oauth = (method = methodID): Credential.OAuth => Schema.decodeUnknownSync(Credential.OAuth)({ type: 'oauth', methodID: method,
  access: 'fixture-access', refresh: 'fixture-refresh', expires: 1, metadata: method === legacyMethodID ? { accountID: 'fixture-account' } : { clientID: 'fixture-client' } });

async function fixture(action: (input: { adapter: ReturnType<typeof createNativeOpenAi>; raw: Credential.Interface;
  integration: Integration.Interface; hooks: PluginHooks.Interface; directory: string; location: Location.Interface;
  refreshed: () => number; writes: () => number }) => Effect.Effect<void, unknown, Credential.Service | Scope.Scope>, options: Partial<NativeOpenAiOptions> = {}) {
  const parent = path.resolve('.cache/v2-validation'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'builtin-openai-'));
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: 'global', directory, canonical: directory } });
  let raw: Credential.Interface | undefined, refreshes = 0, writes = 0;
  const adapter = createNativeOpenAi({ controllerIdentity: () => 'controller-fixture', isBound: () => true, isExecutionReady: () => true,
    assertAttempt: () => Effect.void, assertResolution: () => Effect.void,
    captureLocation: () => ({ acquisitionID: 'fixture', configurationDigest: 'c'.repeat(64), assertCurrent: () => {} }),
    withCredentialResolution: (_binding, reauthorize, work) => reauthorize.pipe(Effect.andThen(work)),
    withCredentialMutation: (_binding, work) => work.pipe(Effect.provideService(CredentialMutationReauthorizeRef, Effect.void)),
    captureOAuthGrant: () => Effect.succeed({ authorizationID: 'fixture', reauthorize: Effect.void }), reviewedNativeProviderOrigin: origin, reviewedNativeCodexOrigin: codexOrigin, ...options });
  const layer = LayerNode.compile(LayerNode.group([Credential.node, Integration.node, PluginHooks.node]), { replacements: [
    Global.node.replace(Global.layerWith({ home: directory, data: directory, cache: directory, config: directory, state: directory, tmp: directory, bin: directory, log: directory, repos: directory })),
    Location.node.replace(Layer.succeed(Location.Service, location)),
    Credential.node.replace(Credential.node.mapLayer(original => Layer.effect(Credential.Service, Effect.gen(function* () {
      raw = yield* Credential.Service;
      const originalStore = raw;
      return adapter.decorateCredential({ ...originalStore, update: (id, updates) => Effect.suspend(() => { writes++; return originalStore.update(id, updates); }) });
    })).pipe(Layer.provide(original)))),
    Integration.node.replace(Integration.node.mapLayer(original => Layer.effect(Integration.Service, Effect.gen(function* () {
      return adapter.decorateIntegration(yield* Integration.Service, location);
    })).pipe(Layer.provide(original)))),
  ] });
  try { await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const integration = yield* Integration.Service, hooks = yield* PluginHooks.Service;
    if (!raw) throw Error('Credential fixture unavailable');
    yield* integration.transform(editor => {
      editor.method.update({ integrationID: openai, method: { type: 'key', label: 'API key' } });
      for (const method of ['chatgpt-siwc', 'chatgpt-headless', 'other-oauth']) editor.method.update({ integrationID: openai,
        method: { id: Integration.MethodID.make(method), type: 'oauth', label: method }, authorize: () => Effect.die('Retired authorize called'), refresh: () => Effect.die('Retired refresh called') });
      editor.method.update({ integrationID: openai, method: { id: methodID, type: 'oauth', label: 'Sign in with ChatGPT' },
        authorize: () => Effect.succeed({ mode: 'auto', url: 'http://127.0.0.1:9', instructions: 'Fixture', callback: Effect.succeed(oauth()) }),
        refresh: value => Effect.sync(() => { refreshes++; return { ...value, access: 'fixture-new-access', refresh: 'fixture-new-refresh', expires: Date.now() + 3600_000 }; }) });
    }).pipe(Effect.provideService(RegistrationOriginRef, origin));
    yield* integration.transform(editor => editor.method.update({ integrationID: openai,
      method: { id: legacyMethodID, type: 'oauth', label: 'Codex browser (legacy)' },
      authorize: () => Effect.succeed({ mode: 'auto', url: 'http://127.0.0.1:9', instructions: 'Fixture', callback: Effect.succeed(oauth(legacyMethodID)) }),
      refresh: value => Effect.sync(() => { refreshes++; return { ...value, access: 'fixture-new-access', refresh: 'fixture-new-refresh', expires: Date.now() + 3600_000 }; })
    })).pipe(Effect.provideService(RegistrationOriginRef, codexOrigin));
    yield* action({ adapter, raw, integration, hooks, directory, location, refreshed: () => refreshes, writes: () => writes });
  }).pipe(Effect.provide(layer)))); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const scoped = <A, E, R>(directory: string, work: Effect.Effect<A, E, R>) => work.pipe(
  Effect.provideService(CredentialResolutionScopeRef, { directory, sessionID: permit.sessionID, permit, active: true }));
const event = (request: Request): SessionHttpRequest => ({ request, sessionID: Schema.decodeUnknownSync(SessionSchema.ID)(permit.sessionID), kind: 'primary', model: Schema.decodeUnknownSync(Model.Ref)({ providerID: 'openai', id: 'gpt-5.5' }), agent: Schema.decodeUnknownSync(Agent.ID)('build') });

test('catalog exposes native Codex browser and API key', async () => fixture(({ integration }) => Effect.gen(function* () {
  const info = yield* integration.get(openai); expect(info?.methods.map(method => method.type === 'oauth' ? String(method.id) : method.type).sort()).toEqual(['chatgpt-browser', 'key']);
})));

test('unscoped reads never refresh; scoped resolution commits OpenCode refresh exactly once', async () => fixture(({ adapter, raw, integration, directory, refreshed, writes }) => Effect.gen(function* () {
  const row = yield* raw.create({ integrationID: openai, value: oauth() });
  const connection = yield* integration.connection.active(openai); if (!connection) throw Error('Missing selection');
  expect(yield* integration.connection.resolve(connection)).toEqual(row.value); expect(refreshed()).toBe(0);
  expect(yield* adapter.requiresOpenAiHttp(directory)).toBe(true);
  const resolved = yield* scoped(directory, integration.connection.resolve(connection));
  expect(resolved).toMatchObject({ access: 'fixture-new-access', refresh: 'fixture-new-refresh' });
  expect(refreshed()).toBe(1); expect(writes()).toBe(1);
  yield* scoped(directory, integration.connection.resolve(connection)); expect(refreshed()).toBe(1);
})));

test.each(['chatgpt-siwc', 'chatgpt-headless'])('retired %s is unavailable, immutable and removable', async method => fixture(({ adapter, raw, integration, directory, writes }) => Effect.gen(function* () {
  const row = yield* raw.create({ integrationID: openai, value: oauth(Integration.MethodID.make(method)) });
  const connection = yield* integration.connection.active(openai); if (!connection) throw Error('Missing selection');
  expect(yield* integration.connection.resolve(connection)).toBeUndefined(); expect(yield* adapter.requiresOpenAiHttp(directory)).toBe(false);
  const store = yield* Credential.Service;
  yield* store.update(row.id, { value: oauth() }); expect((yield* raw.get(row.id))?.value).toEqual(row.value); expect(writes()).toBe(0);
  yield* store.remove(row.id).pipe(Effect.provideService(Location.Service, Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: 'global', directory, canonical: directory } })));
  expect(yield* raw.get(row.id)).toBeUndefined();
})));

test('mislabeled token-sharing browser rows remain unavailable without a refresh', async () => fixture(({ raw, integration, refreshed }) => Effect.gen(function* () {
  yield* raw.create({ integrationID: openai, value: { ...oauth(legacyMethodID), metadata: { clientID: 'fixture-client' } } });
  const connection = yield* integration.connection.active(openai); if (!connection) throw Error('Missing selection');
  expect(yield* integration.connection.resolve(connection)).toBeUndefined(); expect(refreshed()).toBe(0);
})));

test('OAuth updates outside the resolution commit refuse before write', async () => fixture(({ raw, writes, location }) => Effect.gen(function* () {
  const row = yield* raw.create({ integrationID: openai, value: oauth() }); const store = yield* Credential.Service;
  // A settings grant is not authority to rotate a native OAuth credential.
  const result = yield* Effect.exit(store.update(row.id, { value: { ...oauth(), access: 'injected' } }).pipe(Effect.provideService(Location.Service, location)));
  expect(result._tag).toBe('Failure'); expect(writes()).toBe(0);
}), { withCredentialMutation: () => Effect.die('settings-mutation-refused') }));

test('physical OAuth hook requires proof from this permit', async () => fixture(({ adapter, raw, integration, directory, location, hooks: innerHooks }) => Effect.gen(function* () {
  yield* raw.create({ integrationID: openai, value: { ...oauth(), expires: Date.now() + 3600_000 } });
  const hooks = adapter.decorateHooks({ ...innerHooks, has: () => Effect.succeed(false), trigger: (_domain, _name, value) => Effect.succeed(value) });
  const attempt = event(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }));
  const refused = yield* Effect.exit(hooks.trigger('session', 'http.request', attempt).pipe(Effect.provideService(OperationPermitRef, permit), Effect.provideService(Location.Service, location)));
  expect(refused._tag).toBe('Failure');
  const connection = yield* integration.connection.active(openai); if (!connection) throw Error('Missing selection');
  yield* scoped(directory, integration.connection.resolve(connection));
  const other = { ...permit, token: 'd'.repeat(64) };
  const foreign = yield* Effect.exit(hooks.trigger('session', 'http.request', attempt).pipe(Effect.provideService(OperationPermitRef, other), Effect.provideService(Location.Service, location)));
  expect(foreign._tag).toBe('Failure');
})));

test('native body and response pass through; exact HTTP route and current bearer are required', async () => fixture(({ adapter, raw, integration, directory, location, hooks: innerHooks }) => Effect.gen(function* () {
  yield* raw.create({ integrationID: openai, value: oauth() });
  const connection = yield* integration.connection.active(openai); if (!connection) throw Error('Missing selection');
  yield* scoped(directory, integration.connection.resolve(connection));
  const hooks = adapter.decorateHooks({ ...innerHooks, has: () => Effect.succeed(false), trigger: (_domain, _name, value) => Effect.succeed(value) });
  const body = '{ "tools": [{"type":"function","name":"read"}], "input": [], "temperature": 0.2 }';
  const request = new Request('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: 'Bearer stale', 'x-native': 'preserved' }, body });
  const input = event(request);
  yield* hooks.trigger('session', 'http.request', input).pipe(Effect.provideService(OperationPermitRef, permit), Effect.provideService(Location.Service, location));
  expect(yield* Effect.promise(() => input.request.text())).toBe(body);
  expect(input.request.headers.get('authorization')).toBe('Bearer fixture-new-access'); expect(input.request.headers.get('x-native')).toBe('preserved');
  const response = { ...event(request), response: new Response('unchanged') };
  expect(yield* hooks.trigger('session', 'http.response', response)).toBe(response);
  for (const url of ['https://chatgpt.com/backend-api/codex/responses', 'https://api.openai.com/v1/responses?alternate=1']) {
    const result = yield* Effect.exit(hooks.trigger('session', 'http.request', event(new Request(url))).pipe(Effect.provideService(OperationPermitRef, permit), Effect.provideService(Location.Service, location)));
    expect(result._tag).toBe('Failure');
  }
  const ws = yield* Effect.exit(hooks.trigger('session', 'experimental.ws.handshake', { ...event(request), url: 'wss://api.openai.com/v1/responses', headers: {} }).pipe(Effect.provideService(OperationPermitRef, permit), Effect.provideService(Location.Service, location)));
  expect(ws._tag).toBe('Failure');
})));

test('an unreviewed built-in registration is refused', async () => fixture(({ integration }) => Effect.gen(function* () {
  const result = yield* Effect.exit(integration.transform(editor => editor.method.update({ integrationID: openai,
    method: { id: methodID, type: 'oauth', label: 'Unreviewed' }, authorize: () => Effect.die('Must not run') })));
  expect(result._tag).toBe('Failure');
})));

test('native Codex commits refresh, preserves bytes and binds the account and exact route', async () => fixture(({ adapter, raw, integration, directory, location, hooks: innerHooks, refreshed, writes }) => Effect.gen(function* () {
  yield* raw.create({ integrationID: openai, value: { ...oauth(legacyMethodID), metadata: { accountID: 'fixture-account' } } });
  const connection = yield* integration.connection.active(openai); if (!connection) throw Error('Missing selection');
  expect(yield* adapter.requiresOpenAiHttp(directory)).toBe(true);
  expect(yield* adapter.isOpenAiTokenSharing(directory)).toBe(false);
  yield* scoped(directory, integration.connection.resolve(connection));
  expect(refreshed()).toBe(1); expect(writes()).toBe(1);
  const hooks = adapter.decorateHooks({ ...innerHooks, trigger: (_domain, _name, value) => Effect.succeed(value) });
  const body = '{ "tools": [], "input": [] }';
  const input = event(new Request('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: { authorization: 'Bearer stale', 'chatgpt-account-id': 'wrong' }, body }));
  yield* hooks.trigger('session', 'http.request', input).pipe(Effect.provideService(OperationPermitRef, permit), Effect.provideService(Location.Service, location));
  expect(input.request.headers.get('authorization')).toBe('Bearer fixture-new-access');
  expect(input.request.headers.get('chatgpt-account-id')).toBe('fixture-account');
  expect(yield* Effect.promise(() => input.request.text())).toBe(body);
  for (const url of ['https://api.openai.com/v1/responses', 'https://chatgpt.com/backend-api/codex/responses?alternate=1']) {
    expect((yield* Effect.exit(hooks.trigger('session', 'http.request', event(new Request(url))).pipe(Effect.provideService(OperationPermitRef, permit), Effect.provideService(Location.Service, location))))._tag).toBe('Failure');
  }
})));
