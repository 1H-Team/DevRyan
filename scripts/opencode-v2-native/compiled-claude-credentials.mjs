import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createNativeProviderProcess } from '../../packages/web/server/lib/opencode/runtime-host/native-provider-process.js';
import { createNativeClaudeCredentialOwner } from '../../packages/web/server/lib/opencode/runtime-host/native-provider-runtime-owner.js';
import { createNativeClaudeLifecycleClient } from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle-client.js';
import { claudeRecordFingerprint, claudeGrantFingerprint } from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import { claudeKeychainService } from '../../packages/web/server/lib/opencode/claude-credential-projection.js';
import { projectNativeClaudeWorkerProfiles } from '../../packages/web/server/lib/opencode/runtime-host/native-claude-worker-profiles.js';

/** Original compiled entry and confined provider worker, with synthetic host
 * Keychain/issuer backends. Every HTTP inference is rejected before auth status
 * or SDK acquisition; no live provider or saved account is consulted. */
export async function runCompiledClaudeCredentialBridge({ artifacts, root, controller, environment = {}, observations = [] }) {
 assert.ok(artifacts.reviewedClaudeCredentials && artifacts.reviewedClaude, 'Reviewed Claude assets required');
 assert.ok(controller && !controller.hasExited(), 'Owned compiled controller required for original lifecycle KV');
 const lifecycle = createNativeClaudeLifecycleClient({ controller: () => controller, isCurrent: () => !controller.hasExited() });
 const bundle = path.join(root, 'compiled-claude-credential-bridge');
 await fs.mkdir(bundle, { mode: 0o700 });
 const databaseDirectory = path.join(bundle, 'opencode'), global = path.join(bundle, 'global');
 await fs.mkdir(databaseDirectory, { mode: 0o700 }); await fs.mkdir(global, { mode: 0o700 });
 const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp'].map(key => [key, path.join(global, key)]));
 for (const directory of Object.values(globals)) await fs.mkdir(directory, { mode: 0o700 });
 const controlRoot = path.join(bundle,'control'), enrollmentRoot = path.join(controlRoot,'claude-enrollments');
 await fs.mkdir(enrollmentRoot,{recursive:true,mode:0o700});
 const directory = globals.repos, profiles = [randomUUID(),randomUUID()].map(enrollmentID => {
  const claudeConfigDir = path.join(enrollmentRoot,enrollmentID);
  return { id: 'devryan-'+enrollmentID, type: 'claude-max', claudeConfigDir, keychainService: claudeKeychainService(claudeConfigDir,globals.home) };
 });
 for (const profile of profiles) await fs.mkdir(profile.claudeConfigDir, { mode: 0o700 });
 const values = new Map(profiles.map(profile => [profile.keychainService, { claudeAiOauth: { accessToken: `synthetic-old-access-${profile.id}`, refreshToken: `synthetic-independent-refresh-${profile.id}`, expiresAt: Date.now() + 1000 } }]));
 const initial = await lifecycle.read(); let enrolled = initial;
 for (const profile of profiles) {
  const value = values.get(profile.keychainService);
  assert.equal(enrolled.accounts.some(row => row.profileID === profile.id || row.service === profile.keychainService), false);
  enrolled = await lifecycle.transition(enrolled.revision, { kind: 'enroll', account: {
   profileID: profile.id, service: profile.keychainService, configDirectory: profile.claudeConfigDir,
   enrollmentID: path.basename(profile.claudeConfigDir), generation: randomUUID(), grantFingerprint: claudeGrantFingerprint(value.claudeAiOauth.refreshToken), recordFingerprint: claudeRecordFingerprint(value),
  } });
 }
 assert.deepEqual((await lifecycle.read()).accounts, enrolled.accounts);
 const otherEnrollment = enrolled.accounts.find(row => row.profileID === profiles[1].id);
 const otherCredential = structuredClone(values.get(profiles[1].keychainService));
 let exchanges = 0, mutations = 0, reads = 0, requests = 0, chain = Promise.resolve(), worker, mode = 'refuse';
 const actual = [], publications = [], active = new Map();
 const backend = {
  async execFile(file, args) {
   assert.equal(file, '/usr/bin/security'); const service = args[args.indexOf('-s') + 1]; assert.equal(service, profiles[0].keychainService);
   if (args[0] === 'find-generic-password') { reads++; return { stdout: JSON.stringify(values.get(service)) }; }
   assert.equal(args[0], 'add-generic-password'); assert.equal(args[1], '-U'); mutations++; const value=JSON.parse(args[args.indexOf('-w') + 1]); publications.push(value); values.set(service, value); return { stdout: '' };
  },
  async fetch(url, options) {
   assert.equal(url, 'https://platform.claude.com/v1/oauth/token'); assert.equal(options.method, 'POST');
   assert.equal(JSON.parse(options.body).grant_type, 'refresh_token'); exchanges++;
   return Response.json({ access_token: 'synthetic-renewed-access', refresh_token: 'synthetic-renewed-refresh', expires_in: 3600 });
  },
 };
 const owner = createNativeClaudeCredentialOwner({ profiles, home: globals.home, asset: artifacts.reviewedClaudeCredentials, backend, lifecycle,
  withMutationQueue: action => { const work = chain.then(action); chain = work.catch(() => {}); return work; } });
 const requestAuthorization = randomBytes(32).toString('hex'), instanceID = randomUUID();
 const workerProfiles = await projectNativeClaudeWorkerProfiles({profiles,globals,controlRoot,workerInstanceID:instanceID,lifecycle},{recheck:async()=>{assert.equal(controller.hasExited(),false);}});
 for(let index=0;index<profiles.length;index++){
  assert.equal(profiles[index].claudeConfigDir.startsWith(globals.home+path.sep),false);
  assert.deepEqual(workerProfiles[index],{...profiles[index],claudeConfigDir:workerProfiles[index].claudeConfigDir});
  assert.equal(workerProfiles[index].claudeConfigDir.startsWith(globals.home+path.sep),true);
  assert.equal(await fs.realpath(workerProfiles[index].claudeConfigDir),workerProfiles[index].claudeConfigDir);
  assert.deepEqual(await fs.readdir(workerProfiles[index].claudeConfigDir),[]);
 }
 const boot = { protocol: 1, type: 'provider-boot', provider: 'anthropic', instanceID, buildId: artifacts.manifest.buildId, requestAuthorization, globals, profiles:workerProfiles, defaultProfile: profiles[1].id,
  assets: artifacts.reviewedClaude, transport: { launcher: artifacts.launcher, storage: globals.state, directories: [directory] } };
 const send = (attempt, changes = {}) => fetch(worker.bound.url + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(15000),
  headers: { authorization: 'Bearer ' + requestAuthorization, 'content-type': 'application/json', 'x-meridian-profile': profiles[0].id,
   'x-devryan-provider-attempt': attempt.attemptID, 'x-opencode-session': attempt.sessionID,
   'x-devryan-directory': encodeURIComponent(directory), 'x-opencode-directory': encodeURIComponent(directory), ...changes },
  body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'Synthetic credential bridge contract' }], max_tokens: 1, stream: false }) });
 const authorize = async () => {
  const input = { attemptID: randomBytes(32).toString('hex'), sessionID: 'ses_credentialbridge', directory };
  await worker.authorizeAttempt(input); active.set(input.attemptID, input); return input;
 };
 const release = async input => { await worker.releaseAttempt(input); active.delete(input.attemptID); };
 let failure, termination;
 try {
  worker = await createNativeProviderProcess({ binary: artifacts.controller, cwd: directory, databasePath: path.join(databaseDirectory, 'opencode.db'),
   supervisor: { launcher: artifacts.launcher }, environment: { PATH: environment.PATH ?? process.env.PATH, LANG: 'en_US.UTF-8',
    HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp }, boot,
   onExit: async receipt => { termination = receipt; observations.push({ phase: 'compiled_claude_provider_exit', ...receipt }); },
   resolveCredential: async (request, { signal }) => {
    requests++; const attempt = active.get(request.attemptID); assert.ok(attempt); assert.equal(request.sessionID, attempt.sessionID); assert.equal(request.directory, directory);
    assert.equal(request.profileID, profiles[0].id); assert.equal(request.purpose, 'request'); assert.equal(request.failedFingerprint, undefined);
    const result = await owner(request, { signal, retried: new Set(), recheck: async () => { signal.throwIfAborted(); assert.equal(active.get(request.attemptID), attempt); } });
    actual.push({ profileID: result.profileID, purpose: request.purpose, keys: Object.keys(result).sort() });
    if (mode === 'refuse') throw Object.assign(new Error('claude_credentials_expired'), { code: 'claude_credentials_expired' });
    // Release the exact constructor-issued worker attempt before the successful
    // access-only reply. Its second authority check must stop before the SDK.
    await release(attempt); return result;
   } });
  observations.push({ phase: 'compiled_claude_provider_bound', pid: worker.pid, instanceID, health: worker.bound.health });
  const first = await authorize(); const denied = await send(first); assert.ok(!denied.ok); await denied.body?.cancel();
  assert.equal(requests, 1); assert.equal(exchanges, 1); assert.equal(mutations, 1); assert.ok(reads >= 3); assert.equal(publications.length,1);
  assert.equal(publications[0].devryanRefreshBlock,undefined);
  assert.equal(publications[0].claudeAiOauth.accessToken,'synthetic-renewed-access');
  const settled = await lifecycle.read(), selected = settled.accounts.find(row => row.profileID === profiles[0].id);
  assert.equal(settled.revision, enrolled.revision + 3);
  assert.equal(selected.recordFingerprint, claudeRecordFingerprint(publications[0]));
  assert.equal(selected.grantFingerprint, claudeGrantFingerprint(publications[0].claudeAiOauth.refreshToken));
  assert.equal(selected.generation, enrolled.accounts.find(row => row.profileID === profiles[0].id).generation);
  assert.deepEqual(settled.unresolved, initial.unresolved);
  assert.deepEqual(settled.accounts.find(row => row.profileID === profiles[1].id), otherEnrollment);
  assert.deepEqual(values.get(profiles[1].keychainService), otherCredential);
  await assert.rejects(lifecycle.transition(enrolled.revision, { kind: 'begin', account: selected, attemptID: randomUUID() }));
  assert.deepEqual(await lifecycle.read(), settled); await release(first);
  const untouched = await authorize(); const foreign = await send(untouched, { 'x-opencode-session': 'ses_foreign' });
  assert.equal(foreign.status, 403); await foreign.body?.cancel(); assert.equal(requests, 1); await release(untouched);
  mode = 'release'; const second = await authorize(); const revoked = await send(second); assert.ok(!revoked.ok); await revoked.body?.cancel();
  assert.equal(requests, 2); assert.equal(exchanges, 1); assert.equal(mutations, 1); assert.equal(active.size, 0);
  assert.deepEqual(await lifecycle.read(), settled);
  for (const row of actual) assert.deepEqual(row.keys, ['accessToken', 'expiresAt', 'fingerprint', 'profileID']);
 } catch (error) { failure = error; }
 finally {
  const failures = [];
  for (const attempt of active.values()) { try { await release(attempt); } catch (error) { failures.push(error); } }
  if (worker) { try { await worker.close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError([...failure ? [failure] : [], ...failures], 'compiled_claude_credential_cleanup_failed');
 }
 if (failure) throw failure;
 assert.equal(termination.code, 0); assert.equal(termination.signal, null); assert.equal(termination.receipt.terminated, true); assert.equal(termination.receipt.confined, true);
 return [{ id: 'compiled-claude-selected-profile-credential-ipc', status: 'passed', requests, exchanges, mutations, termination,
  lifecycle: { controllerInstanceID: controller.instanceID, originalKV: true, independentEnrollments: 2, staleRevisionRefused: true, vendorTombstones: 0, externalProfilesProjected: true },
  scope: 'actual confined compiled entry/profile validation/reverse IPC and original controller lifecycle KV; external synthetic enrollments projected to empty worker directories; synthetic Keychain/issuer; refused and revoked before auth-status/SDK; no live provider qualification' }];
}
