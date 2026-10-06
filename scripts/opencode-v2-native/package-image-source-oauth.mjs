// Disposable SOURCE SDK fixture only. This is never a compiled runtime override.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Effect, Layer, Logger, Context, Option } from 'effect';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import { Location } from '@opencode/core/location';
import { Plugin } from '@opencode/core/plugin';
import { Global } from '@opencode/util/global';
import { OpenCode } from '../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js';
import { configurationOverrides } from '../../packages/web/server/lib/opencode/runtime-host/configuration.ts';
import { createNativeOpenAi } from '../../packages/web/server/lib/opencode/runtime-host/native-openai.ts';
import { createCredentialMutationBridge } from '../../packages/web/server/lib/opencode/runtime-host/credential-mutation-bridge.ts';
import { CredentialAuthorizationRef } from '../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.ts';
import { createNativeIntegrationAuthorization } from '../../packages/web/server/lib/opencode/runtime-host/native-integration-authorization.js';
import { createNativeCredentialMutationOwner, credentialMutationFingerprint } from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import { createNativeAuthorization } from '../../packages/web/server/lib/opencode/runtime-host/native-authorization.js';
import { createOpenAiOAuthCoordinator } from '../../packages/web/server/lib/opencode/openai-oauth-coordinator.js';

const repository = path.resolve(import.meta.dirname, '../..');
export async function prepareSourceOpenAiFixture({ databasePath, directory, profileRoot, expiresIn = { A: 3600, B: 3600 }, canaryPrefix }) {
  if(canaryPrefix!==undefined)assert.match(canaryPrefix,/^[a-z0-9_-]{16,128}$/);
  assert.deepEqual(Object.keys(expiresIn).sort(), ['A', 'B']);
  for (const value of Object.values(expiresIn)) assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= 3600);
  for (const value of [databasePath, directory, profileRoot]) assert.ok(path.isAbsolute(value) && value.startsWith(repository + path.sep));
  assert.equal(await fs.realpath(databasePath), databasePath); assert.equal(await fs.realpath(directory), directory);
  await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 }); assert.equal(await fs.realpath(profileRoot), profileRoot);
  const globals = Object.fromEntries(['home', 'data', 'cache', 'config', 'state', 'tmp', 'bin', 'log', 'repos'].map(key => [key, path.join(profileRoot, key)]));
  for (const value of Object.values(globals)) await fs.mkdir(value, { recursive: true, mode: 0o700 });
  assert.deepEqual(await fs.readdir(globals.config), [], 'Source preparation config must be empty');
  const previousFetch = globalThis.fetch, requests = [], mutationsSeen = [], accounts = [];
  let account = 'A';
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(typeof url, 'string'); assert.equal(init.method, 'POST'); init.signal?.throwIfAborted();
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token', 'Source fixture attempted an unowned endpoint');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), 'oaiapp_fixture_client');
    assert.equal(body.get('resource'), 'https://api.openai.com/v1');
    requests.push({ account, phase: 'refresh' });
    const claims = Buffer.from(JSON.stringify({ chatgpt_account_id: `owned-image-account-${account}` })).toString('base64url');
    return Response.json({
      access_token: `${canaryPrefix??'owned'}-image-access-${account}`,
      refresh_token: `${canaryPrefix??'owned'}-image-refresh-${account}-rotated`,
      expires_in: expiresIn[account],
      id_token: `owned.${claims}.fixture`,
    });
  };
  const readProof = (selected,metadata) => {
    assert.ok(selected?.credentialID); assert.equal(selected.value.type, 'oauth'); assert.equal(selected.value.methodID, 'chatgpt-siwc');
    assert.equal(metadata?.id,selected.credentialID);assert.equal(metadata.integrationID,'openai');
    return { credentialID: selected.credentialID, methodID: selected.value.methodID, accountID: selected.value.metadata.accountID,
      expectedFingerprint:credentialMutationFingerprint(metadata),valueFingerprint: credentialMutationFingerprint(selected.value), expires: selected.value.expires };
  };
  const run = async prepare => {
    const instanceID = randomUUID(), acquisitionID = randomUUID(), configurationDigest = credentialMutationFingerprint({});
    let active = true, integration, plugins, credentials, location;
    const principal = Object.freeze({ scope: 'local-admin', id: 'owned-source-oauth-fixture' });
    const authorization = createNativeAuthorization({ locations: [{ directory }], manifest: { inputs: { nativeRegistrations: [], reviewedPlugins: [] } },
      getRequestPrincipal: () => principal, captureLocalAuthorization: original => original === principal ? () => active : null,
      getMultiUserRuntime: () => ({ enabled: false, connection: { configured: false, isLocalAccessActive: () => active } }) });
    const full = binding => ({ ...binding, kind: 'openai', integrationID: 'openai', acquisitionID, configurationDigest });
    const verifyBinding = async binding => {
      assert.equal(active, true); assert.equal(binding.controllerInstanceID, instanceID); assert.equal(binding.directory, directory);
      assert.equal(binding.kind, 'openai'); assert.equal(binding.integrationID, 'openai');
      if (binding.acquisitionID !== undefined) assert.equal(binding.acquisitionID, acquisitionID);
      if (binding.configurationDigest !== undefined) assert.equal(binding.configurationDigest, configurationDigest);
      if (binding.methodID !== undefined) assert.equal(binding.methodID, 'chatgpt-siwc');
    };
    const grants = createNativeIntegrationAuthorization({ controllerIdentity: () => active ? instanceID : undefined, verifyBinding,
      captureWebAuthorization: input => authorization.captureWebAuthorization(input), authorizeConfiguredConnection: verifyBinding });
    const queue = createOpenAiOAuthCoordinator({ readAuth: () => undefined });
    let mutationOwner;
    const bridge = createCredentialMutationBridge({ controllerInstanceID: instanceID,
      rpc: (method, input, context) => mutationOwner.handleRpc(method, input, context),
      captureAuthorization: binding => Effect.gen(function* () {
        const authorizationID = yield* CredentialAuthorizationRef;
        if (authorizationID) {
          return { authorizationID, reauthorize: Effect.promise(() => grants.reauthorize({ authorizationID, binding: full(binding) })) };
        }
        const captured = yield* Effect.promise(() => grants.capture({
          binding: full(binding), operation: 'mutation',
          requestAuthorization: grants.requestHeaders()['x-devryan-native-integration-grant'],
        }));
        return { authorizationID: captured.authorizationID,
          reauthorize: Effect.promise(() => grants.reauthorize({ authorizationID: captured.authorizationID, binding: full(binding) })) };
      }) });
    mutationOwner = createNativeCredentialMutationOwner({ controllerInstanceID: instanceID, withMutationQueue: queue.withAuthMutation,
      resolveAuthorization: input => grants.resolveMutation(input), verifyBinding,
      commitOwned: async control => { await bridge.commitOwned(control); mutationsSeen.push({ phase: 'settled-native-mutation' }); } });
    const adapter = createNativeOpenAi({ controllerIdentity: () => active ? instanceID : undefined, isBound: () => true, isExecutionReady: () => false,
      assertAttempt: () => Effect.die(Error('Source preparation cannot infer')), access: async () => { throw Error('Source preparation cannot refresh'); },
      withCredentialMutation: bridge.withCredentialMutation,
      captureOAuthGrant: input => Effect.promise(async () => {
        const binding = full(input), captured = await grants.capture({ binding, operation: 'oauth',
          requestAuthorization: grants.requestHeaders()['x-devryan-native-integration-grant'] });
        return { ...captured, reauthorize: Effect.promise(() => grants.reauthorize({ ...captured, binding })) };
      }) });
    const overrides = [Global.node.replace(Global.layerWith(globals)), ...configurationOverrides({}),
      Credential.node.replace(Credential.node.mapLayer(original => Layer.effect(Credential.Service, Effect.gen(function* () {
        credentials=adapter.decorateCredential(yield* Credential.Service);return credentials;
      })).pipe(Layer.provide(original)))),
      Integration.node.replace(Integration.node.mapLayer(original => Layer.effect(Integration.Service, Effect.gen(function* () {
        const inner = yield* Integration.Service;
        const actual = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
        assert.equal(actual?.directory, directory, 'Actual source native location required');
        location = actual;
        integration = adapter.decorateIntegration(inner, actual);
        yield* Effect.addFinalizer(() => adapter.closeLocation(directory, inner)); return integration;
      })).pipe(Layer.provide(original)))),
      Plugin.node.replace(Plugin.node.mapLayer(original => Layer.effect(Plugin.Service, Effect.gen(function* () {
        plugins = yield* Plugin.Service; return plugins;
      })).pipe(Layer.provide(original)))),
    ];
    try { return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sdk = yield* OpenCode.create({ database: { path: databasePath }, config: { project: false },
        models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, events: { persist: false } }, { overrides });
      yield* sdk.agent.list({ location: { directory } }); yield* plugins.awaitActivation;
      assert.ok(integration); assert.ok(location);
      if (prepare) for (const current of ['A', 'B']) {
        account = current;
        const value = {
          type: 'oauth',
          methodID: 'chatgpt-siwc',
          access: `${canaryPrefix??'owned'}-image-access-${current}`,
          refresh: `${canaryPrefix??'owned'}-image-refresh-${current}`,
          expires: Date.now() + expiresIn[current] * 1000,
          metadata: {
            accountID: `owned-image-account-${current}`,
            clientId: 'oaiapp_fixture_client',
            scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
            subject: `owned-image-account-${current}`,
            extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-0000000000aa',
            planUsage: true,
            idToken: `owned.${Buffer.from(JSON.stringify({ chatgpt_account_id: `owned-image-account-${current}` })).toString('base64url')}.fixture`,
          },
        };
        const input = { integrationID: 'openai', value, activate: true, label: `SIWC ${current}` };
        yield* Effect.promise(() => grants.withCallerOperation({
          kind: 'openai', integrationID: 'openai', directory, configurationDigest,
          methodID: 'chatgpt-siwc', valueType: 'oauth', operation: 'openai.credential.create',
          method: 'POST', path: '/api/credential', body: input,
          requestedFingerprint: credentialMutationFingerprint(input),
        }, () => Effect.runPromise(credentials.create(input).pipe(
          Effect.provideService(Location.Service, location),
          Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)], { mergeWithExisting: false })),
        ))));
        requests.push({ account: current, phase: 'create' });
        const selected = yield* Effect.promise(async () => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const selected = await adapter.readSelectedOwned({ directory });
            if (selected?.value.metadata?.accountID === `owned-image-account-${current}`) return selected;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          throw Error('Original native OAuth did not commit its selected account');
        });
        const records=yield* credentials.list('openai');accounts.push(readProof(selected,records.find(row=>row.id===selected.credentialID)));
      }
      const selected=yield* Effect.promise(() => adapter.readSelectedOwned({ directory })),records=yield* credentials.list('openai');
      return readProof(selected,records.find(row=>row.id===selected.credentialID));
    }).pipe(Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)], { mergeWithExisting: false }))))); }
    finally { await bridge.close(); await mutationOwner.close(); grants.close(); active = false; }
  };
  try {
    const before = await run(true), reopened = await run(false); assert.deepEqual(reopened, before);
    assert.equal(accounts.length, 2); assert.notEqual(accounts[0].credentialID, accounts[1].credentialID);
    assert.deepEqual(requests.map(row => `${row.account}:${row.phase}`), ['A:create','B:create']);
    // Native Credential.create activates atomically; no separate activation is emitted.
    assert.equal(mutationsSeen.length, 2);
    return { source: 'synthetic-siwc-native-credential-create-source-sdk-shared-queue', nativeVersion: '2.0.20',
      accounts, reopened, requestPhases: requests, settledMutations: mutationsSeen.length, compiledOAuthCreation: false };
  } finally { globalThis.fetch = previousFetch; }
}
