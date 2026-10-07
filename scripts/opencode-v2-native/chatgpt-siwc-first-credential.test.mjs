import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Credential } from '@opencode/core/credential';
import { Database } from '@opencode/core/database/database';
import { CredentialTable } from '@opencode/core/credential/sql';
import { Global } from '@opencode/util/global';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Effect, Logger } from 'effect';
import { createHostChatgptSiwcEnrollment } from '../../packages/web/server/lib/opencode/chatgpt-siwc-host.js';
import { CHATGPT_SIWC_TOKEN_URL, readSiwcRegistrations } from '../../packages/web/server/lib/opencode/chatgpt-siwc.js';
import { createNativeIntegrationOwner } from '../../packages/web/server/lib/opencode/runtime-host/native-integration-owner.js';
import { NativeCommandRefusal } from '../../packages/web/server/lib/opencode/runtime-host/native-command-refusal.js';
import { credentialMutationFingerprint as fingerprint } from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
const webRequire = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(pathToFileURL(webRequire.resolve('jose')).href);

// Run the installed SDK's actual create/activate/remove services behind the real
// host facade, caller grants and reverse commit owner. All OAuth material is
// synthetic; the only HTTP request goes to the fixture's loopback callback.
async function withFixture(action) {
  const root = fs.mkdtempSync(path.resolve('.cache/v2-validation/siwc-sdk-'));
  const layer = LayerNode.compile(LayerNode.group([Credential.node, Database.node]), { replacements: [
    Global.node.replace(Global.layerWith(Object.fromEntries(['home', 'data', 'cache', 'config', 'state', 'tmp', 'bin', 'log', 'repos'].map(key => [key, root])))),
    Database.node.replace(Database.configured({ path: path.join(root, 'native.db') })),
  ] });
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const credentials = yield* Credential.Service, { db } = yield* Database.Service;
      yield* Effect.promise(async () => {
        const run = effect => Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false }))));
        const instanceID = 'siwc_fixture_controller', commits = new Map(), operations = [];
        let integration, tokens, sequence = 0, revoked = false, beforeCommit, failCreatedRead = false;
        const selected = async () => {
          const rows = await run(db.select({ id: CredentialTable.id, active: CredentialTable.active }).from(CredentialTable));
          const active = rows.find(row => row.active);
          if (!active) return null;
          const row = await run(credentials.get(active.id));
          return { directory: root, controllerInstanceID: instanceID, integrationID: 'openai', credentialID: row.id, value: row.value };
        };
        const read = async id => {
          const row = await run(credentials.get(id));
          return row ? { ...row, expectedFingerprint: fingerprint(row) } : null;
        };
        const controller = { instanceID, killAndWaitForExit: async () => { throw Error('fixture must not kill a controller'); }, call: async command => {
          if (command.action === 'openai-read-selected-owned') return selected();
          if (command.action === 'openai-read-credential-owned') {
            if (failCreatedRead) throw new NativeCommandRefusal('fixture_created_read_failed', 503, 'reply');
            return read(command.credentialID);
          }
          if (command.action === 'credential-commit-owned') return commits.get(command.callID)();
          assert.equal(command.action, 'credential-operation-owned');
          const mutation = command.mutation;
          const value = mutation.operation === 'create' ? mutation.input.value : (await read(mutation.id)).value;
          const binding = { kind: 'openai', controllerInstanceID: instanceID, directory: root, integrationID: 'openai',
            operation: mutation.operation, valueType: value.type, methodID: value.methodID,
            ...(mutation.operation === 'create' ? { requestedFingerprint: fingerprint(mutation.input) }
              : { credentialID: mutation.id, expectedFingerprint: (await read(mutation.id)).expectedFingerprint, requestedFingerprint: fingerprint({ id: mutation.id }) }) };
          const { authorizationID } = await integration.handleRpc('integration.capture', { operation: 'mutation', requestAuthorization: command.requestAuthorization,
            binding: { ...binding, acquisitionID: 'siwc_fixture_acquisition', configurationDigest: fingerprint({}) } });
          const callID = `siwc_fixture_commit_${++sequence}`;
          let result;
          commits.set(callID, async () => {
            if (mutation.operation !== 'create') assert.equal((await read(mutation.id)).expectedFingerprint, binding.expectedFingerprint);
            operations.push(mutation.operation);
            if (mutation.operation === 'create') {
              assert.equal(mutation.input.activate, false);
              const [intent] = readSiwcRegistrations(root).accounts.filter(row => row.stagedCredentialID === mutation.input.id);
              assert.ok(intent, 'exact create ID must already have a durable registration');
              const row = await run(credentials.create(mutation.input)); result = { credentialID: row.id };
            } else if (mutation.operation === 'activate') await run(credentials.activate(mutation.id));
            else if (mutation.operation === 'remove') await run(credentials.remove(mutation.id));
            else throw Error('unexpected fixture mutation');
          });
          try {
            if (beforeCommit) await beforeCommit(mutation);
            await integration.handleRpc('credential.mutation.commit', { callID, controllerInstanceID: instanceID, binding, bindingFingerprint: fingerprint(binding), authorizationID });
            return result;
          } catch (error) {
            // The in-process controller reply is settled, like the real process
            // owner's correlated finite refusal. Unknown failures still throw.
            if (typeof error.code === 'string') throw new NativeCommandRefusal(error.code, error.status ?? 403, 'reply');
            throw error;
          } finally { commits.delete(callID); }
        } };
        const snapshot = { locations: [{ directory: root, configuration: { providers: { openai: {} } }, compatibility: { mcp: {} } }] };
        integration = createNativeIntegrationOwner({ instanceID, snapshot,
          stateDirectory: root, controller: () => controller, isReady: () => true, withMutationQueue: callback => callback(), admissionOwner: {},
          captureWebAuthorization: async () => async () => { if (revoked) throw Object.assign(Error('fixture caller revoked'), { code: 'fixture_caller_revoked' }); } });
        const native = { ...integration, isReady: () => true, getConfigurationSnapshot: () => snapshot };
        const keys = await generateKeyPair('RS256'), jwk = await exportJWK(keys.publicKey);
        const runtime = { generation: 2 };
        const enrollment = createHostChatgptSiwcEnrollment({ dataDirectory: root, getNativeRuntimeOwner: () => native, getOpenCodeRuntime: () => runtime,
          jwksImpl: createLocalJWKSet({ keys: [jwk] }), fetchImpl: async url => { assert.equal(String(url), CHATGPT_SIWC_TOKEN_URL); return Response.json(tokens); } });
        const enroll = async ({ registrationRef, expectedActiveCredentialID, callbackOnly = false } = {}) => {
          const start = await enrollment.begin({ directory: root, ...(registrationRef ? { registrationRef } : {}), ...(expectedActiveCredentialID === undefined ? {} : { expectedActiveCredentialID }) });
          const url = new URL(start.url), clientId = url.searchParams.get('client_id') === 'dynamic_agent_client' ? 'fixture-issued-client' : url.searchParams.get('client_id');
          tokens = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct',
            id_token: await new SignJWT({ nonce: url.searchParams.get('nonce'), email: 'fixture@example.test' }).setProtectedHeader({ alg: 'RS256' })
              .setIssuer('https://auth.openai.com').setAudience(clientId).setSubject('fixture-subject').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey) };
          const callback = new URL(url.searchParams.get('redirect_uri'));
          assert.equal(callback.hostname, '127.0.0.1');
          callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('client_id', clientId);
          assert.equal((await fetch(callback)).status, 200);
          return callbackOnly ? start : enrollment.complete(start.enrollmentID, {}, { directory: root });
        };
        try {
          assert.equal((await run(credentials.all())).length, 0);
          await action({ root, enrollment, enroll, selected, operations, credentials, run,
            revoke: () => { revoked = true; }, beforeCommit: hook => { beforeCommit = hook; }, failCreatedRead: value => { failCreatedRead = value; } });
        } finally { await enrollment.close(); await integration.invalidate(); }
      });
    })).pipe(Effect.provide(layer), Effect.provide(Logger.layer([], { mergeWithExisting: false }))));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('actual SDK first credential autoactivation completes through original native caller and row guards; established account replacement still uses CAS', async () => {
  await withFixture(async f => {
    const first = await f.enroll();
    assert.equal(first.status, 'enrolled'); assert.equal((await f.selected()).credentialID, first.credentialID);
    assert.deepEqual(f.operations, ['create', 'activate']);
    assert.equal((await f.enrollment.status({ directory: f.root })).registrations[0].cleanupRequired, false);
    const next = await f.enroll({ registrationRef: first.registrationRef, expectedActiveCredentialID: first.credentialID });
    assert.notEqual(next.credentialID, first.credentialID); assert.equal((await f.selected()).credentialID, next.credentialID);
    assert.deepEqual(f.operations, ['create', 'activate', 'create', 'activate', 'remove']);
    assert.equal((await f.run(f.credentials.all())).length, 1);
  });
});

test('actual SDK active first record survives a later authorization failure and existing selection finalizes only that staged record', async () => {
  await withFixture(async f => {
    f.beforeCommit(mutation => { if (mutation.operation === 'activate') throw Object.assign(Error('fixture refused'), { code: 'fixture_activate_refused' }); });
    await assert.rejects(f.enroll(), { code: 'native_chatgpt_siwc_registration_cleanup_required' });
    assert.deepEqual(f.operations, ['create']);
    const current = await f.selected(), [registration] = readSiwcRegistrations(f.root).accounts;
    assert.equal(registration.credentialID, null); assert.equal(registration.stagedCredentialID, current.credentialID);
    f.beforeCommit(undefined);
    await f.enrollment.select(registration.registrationRef, { directory: f.root, expectedActiveCredentialID: current.credentialID });
    assert.equal((await f.enrollment.status({ directory: f.root })).registrations[0].cleanupRequired, false);
    assert.equal((await f.run(f.credentials.all())).length, 1); assert.deepEqual(f.operations, ['create', 'activate']);
  });
});

test('actual SDK established account switching and original caller revocation still refuse before credential mutation', async () => {
  await withFixture(async f => {
    const first = await f.enroll(), start = await f.enroll({ registrationRef: first.registrationRef, callbackOnly: true });
    const foreign = await f.run(f.credentials.create({ integrationID: 'openai', value: { type: 'key', key: 'synthetic-other-account' } }));
    await assert.rejects(f.enrollment.complete(start.enrollmentID, {}, { directory: f.root }), { code: 'native_chatgpt_siwc_registration_cleanup_required' });
    assert.equal((await f.selected()).credentialID, foreign.id); assert.deepEqual(f.operations, ['create', 'activate']);
    const another = await f.enroll({ callbackOnly: true }); f.revoke();
    await assert.rejects(f.enrollment.complete(another.enrollmentID, {}, { directory: f.root }), { code: 'native_chatgpt_siwc_registration_cleanup_required' });
    assert.deepEqual(f.operations, ['create', 'activate']);
  });
});

test('actual SDK post-commit read failure retains the exact precommitted ID and recovers without a second OAuth enrollment', async () => {
  await withFixture(async f => {
    f.beforeCommit(mutation => { if (mutation.operation === 'create') f.failCreatedRead(true); });
    await assert.rejects(f.enroll(), { code: 'native_chatgpt_siwc_registration_cleanup_required' });
    assert.deepEqual(f.operations, ['create']);
    const current = await f.selected(), [registration] = readSiwcRegistrations(f.root).accounts;
    assert.equal(registration.stagedCredentialID, current.credentialID);
    f.beforeCommit(undefined); f.failCreatedRead(false);
    await f.enrollment.select(registration.registrationRef, { directory: f.root, expectedActiveCredentialID: current.credentialID });
    assert.equal((await f.enrollment.status({ directory: f.root })).registrations[0].cleanupRequired, false);
    assert.equal((await f.run(f.credentials.all())).length, 1);
  });
});

test('actual SDK autoactivation followed by another account selection cannot bypass the same-ID native commit CAS', async () => {
  await withFixture(async f => {
    let foreign;
    f.beforeCommit(async mutation => {
      if (mutation.operation === 'activate') foreign = await f.run(f.credentials.create({ integrationID: 'openai', value: { type: 'key', key: 'synthetic-racing-account' } }));
    });
    await assert.rejects(f.enroll(), { code: 'native_chatgpt_siwc_registration_cleanup_required' });
    assert.equal((await f.selected()).credentialID, foreign.id); assert.deepEqual(f.operations, ['create']);
    const [registration] = (await f.enrollment.status({ directory: f.root })).registrations;
    assert.equal(registration.active, false); assert.equal(registration.cleanupRequired, true);
    await assert.rejects(f.enrollment.select(registration.registrationRef, { directory: f.root, expectedActiveCredentialID: foreign.id }), { code: 'native_chatgpt_siwc_reauthorization_required' });
    assert.equal((await f.run(f.credentials.all())).length, 2);
  });
});
