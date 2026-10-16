import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireDisposableMacRunner } from './macos-gui-prerequisites.mjs';
import { readThroughNavigation } from './navigation-tolerant.mjs';
import { waitReleaseStartup } from './release-startup-launch.mjs';
import { readRuntimeServiceOwner, createRuntimeServiceCoordinator, waitForRuntimeServiceOwnerStopped } from '../../packages/electron/runtime-service.mjs';
import { startOwnedProcess } from './process.mjs';

const exec = promisify(execFile);
const service = () => `gui/${process.getuid()}/dev.openchamber.desktop.runtime-service`;
const launchctl = args => exec('/bin/launchctl', args, { timeout: 15_000, maxBuffer: 64 * 1024 });
export async function runReleaseCleanup(operation) {
  try { return await operation(); }
  catch (error) { throw Object.assign(new Error('Release cleanup failed', { cause: error }), { code: 'release_startup_cleanup_failed' }); }
}
export async function releaseServiceStatus(launch, deadline = performance.now() + 30_000) {
  const result = await readThroughNavigation(launch.cdp, 'window.__TAURI__.core.invoke("desktop_runtime_service_status", {})', { deadline, check: launch.check });
  assert.equal(result?.ok, true, 'Runtime service status failed');
  return result.status;
}

export async function invokeReleaseServiceHandoff(launch, command, args, poll) {
  assert.ok(['enable', 'disable'].includes(command));
  const binding = `releaseService${command}`;
  let failure;
  const remove = launch.cdp.on('Runtime.bindingCalled', event => {
    if (event.name !== binding) return;
    try {
      const result = JSON.parse(event.payload);
      if (result?.ok !== true) {
        const code = /^(?:runtime_service_|smappservice_)[a-z_]{1,100}$/.test(result?.error?.code ?? '')
          ? result.error.code : 'runtime_service_request_failed';
        failure = Object.assign(Error(`Service ${command} failed: ${code}`), { code });
      }
    } catch { failure = Error(`Service ${command} returned invalid completion evidence`); }
  });
  try {
    await launch.cdp.send('Runtime.addBinding', { name: binding });
    launch.navigation.handoff(`service-${command}`);
    // The promise belongs to a disappearing document; its failures use a CDP binding.
    const result = await launch.cdp.send('Runtime.evaluate', { awaitPromise: false, returnByValue: true,
      expression: `void window.__TAURI__.core.invoke("desktop_runtime_service_${command}", ${JSON.stringify(args)})
        .then(result => window[${JSON.stringify(binding)}](JSON.stringify(result)),
          () => window[${JSON.stringify(binding)}](JSON.stringify({ok:false})))` });
    assert.ok(!result.exceptionDetails, `Service ${command} invocation failed`);
    return await waitReleaseStartup(`service ${command} handoff`, poll, () => {
      launch.check(); if (failure) throw failure;
    });
  } finally { remove(); }
}

export async function cleanupReleaseService({ disable, isRegistered, bootout, waitForStopped, restore, onForced }) {
  return runReleaseCleanup(async () => {
    let failure;
    try {
      await disable();
      assert.equal(await isRegistered(), false, 'Registered service survived cleanup');
    } catch (error) {
      failure = error;
      onForced();
      await bootout();
      assert.equal(await waitForStopped(), true, 'Service owner survived forced cleanup');
      assert.equal(await isRegistered(), false, 'Owned label survived bootout');
    } finally { await restore(); }
    if (failure) throw failure;
  });
}

/** Only the disposable runner may alter the per-user service registration or launchd environment. */
export async function prepareReleaseService(profile, { deadline, signal } = {}) {
  const boundedLaunchctl = (args, options = {}) => {
    const limit = options.deadline ?? deadline;
    options.signal?.throwIfAborted();
    if (limit !== undefined && performance.now() >= limit) throw Object.assign(Error('Release service deadline expired'), { code: 'release_service_deadline' });
    return exec('/bin/launchctl', args, { timeout: limit === undefined ? 15000 : Math.max(1, Math.min(15000, limit - performance.now())), signal: options.signal, maxBuffer: 64 * 1024 });
  };
  const missing = error => { if (error.code === 'release_service_deadline' || error.name === 'AbortError' || error.killed || error.signal) throw error; return false; };
  requireDisposableMacRunner();
  if (await boundedLaunchctl(['print', service()]).then(() => true, missing))
    throw Object.assign(new Error('Runner already owns a service'), { code: 'release_startup_prerequisite_failed' });
  const saved = new Map();
  try {
    for (const [key, value] of Object.entries(profile.env)) {
      saved.set(key, await boundedLaunchctl(['getenv', key], { signal }).then(result => result.stdout.replace(/\n$/, ''), error => { missing(error); return ''; }));
      await boundedLaunchctl(['setenv', key, value], { signal });
    }
  } catch (error) { await restore().catch(() => {}); throw Object.assign(new Error('Launchd environment unavailable', { cause: error }), { code: 'release_startup_prerequisite_failed', restore }); }
  async function restore(options = {}) {
    const errors = [];
    for (const [key, value] of saved) {
      try { await boundedLaunchctl(value ? ['setenv', key, value] : ['unsetenv', key], options); }
      catch { errors.push('launchd_environment_restore_failed'); }
    }
    await runReleaseCleanup(async () => assert.deepEqual(errors, []));
  }
  return {
    enable: async launch => {
      return invokeReleaseServiceHandoff(launch, 'enable', { allowLegacy: true }, async deadline => {
        const status = await releaseServiceStatus(launch, deadline);
        if (status?.registration?.state === 'requires_approval') throw Error('Service registration requires GUI approval');
        const owner = await readRuntimeServiceOwner({ dataDirectory: profile.env.OPENCHAMBER_DATA_DIR });
        return status?.connected && status.registration.state === 'enabled'
          && owner.state === 'valid' && owner.owner.mode === 'service'
          && owner.owner.instanceId === status.handshake?.instanceId ? status : null;
      });
    },
    cold: () => boundedLaunchctl(['kickstart', '-k', service()]),
    cleanup: (launch, options = {}) => cleanupReleaseService({
      disable: async () => {
        if (launch) {
          await invokeReleaseServiceHandoff(launch, 'disable', {}, async deadline => {
            const status = await releaseServiceStatus(launch, deadline);
            const owner = await readRuntimeServiceOwner({ dataDirectory: profile.env.OPENCHAMBER_DATA_DIR });
            return status?.registration?.state === 'not_registered' && !status.connected
              && owner.state === 'valid' && owner.owner.mode === 'app_bound' && owner.owner.pid === launch.app.child.pid;
          });
        }
      },
      isRegistered: () => boundedLaunchctl(['print', service()], options).then(() => true, missing),
      // This label was proved absent before this run registered it.
      bootout: () => boundedLaunchctl(['bootout', service()], options).catch(error => { missing(error); }),
      waitForStopped: () => waitForRuntimeServiceOwnerStopped({ dataDirectory: profile.env.OPENCHAMBER_DATA_DIR, timeoutMs: options.deadline === undefined ? 30000 : Math.max(1, Math.min(30000, options.deadline - performance.now())) }),
      restore: () => restore(options),
      onForced: () => { profile.forcedServiceCleanup = true; },
    }),
  };
}

/** A real process creates the stale record. No fabricated PID can authorize takeover. */
export async function seedStaleReleaseOwner(profile) {
  const dataDirectory = profile.env.OPENCHAMBER_DATA_DIR;
  const source = `import {createRuntimeServiceCoordinator} from ${JSON.stringify(new URL('../../packages/electron/runtime-service.mjs', import.meta.url).href)};
    const owner = await createRuntimeServiceCoordinator({dataDirectory:process.argv[1],safeStorage:{
      isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
    await owner.acquire(); process.stdout.write('owner-ready\\n'); setInterval(()=>{},1000);`;
  const child = startOwnedProcess('node', ['--input-type=module', '-e', source, dataDirectory], { env: profile.env });
  try {
    await waitReleaseStartup('owned service fixture', () => child.getLog().includes('owner-ready'), child.check, 10_000);
    const contender = await createRuntimeServiceCoordinator({ dataDirectory, safeStorage: {
      isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() } });
    await assert.rejects(contender.acquire(), { code: 'runtime_service_owner_exists' });
    child.child.kill('SIGKILL');
    await child.stop();
    const owner = await readRuntimeServiceOwner({ dataDirectory });
    assert.equal(owner.state, 'valid', 'The crashed owner record must remain for guarded recovery');
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory, timeoutMs: 0 }), true);
  } finally { await runReleaseCleanup(() => child.stop()); }
}
