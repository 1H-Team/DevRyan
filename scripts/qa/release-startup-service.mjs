import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireDisposableMacRunner } from './macos-gui-prerequisites.mjs';
import { evaluate } from './cdp.mjs';
import { waitReleaseStartup } from './release-startup-launch.mjs';
import { readRuntimeServiceOwner, createRuntimeServiceCoordinator, waitForRuntimeServiceOwnerStopped } from '../../packages/electron/runtime-service.mjs';
import { startOwnedProcess } from './process.mjs';

const exec = promisify(execFile);
const service = () => `gui/${process.getuid()}/dev.openchamber.desktop.runtime-service`;
const launchctl = args => exec('/bin/launchctl', args, { timeout: 15_000, maxBuffer: 64 * 1024 });
export async function releaseServiceStatus(launch) {
  const result = await evaluate(launch.cdp, 'window.__TAURI__.core.invoke("desktop_runtime_service_status", {})');
  assert.equal(result?.ok, true, 'Runtime service status failed');
  return result.status;
}

/** Only the disposable runner may alter the per-user service registration or launchd environment. */
export async function prepareReleaseService(profile) {
  requireDisposableMacRunner();
  assert.equal(await launchctl(['print', service()]).then(() => true, () => false), false, 'Runner already owns a service');
  const saved = new Map();
  try {
    for (const [key, value] of Object.entries(profile.env)) {
      saved.set(key, await launchctl(['getenv', key]).then(result => result.stdout.replace(/\n$/, ''), () => ''));
      await launchctl(['setenv', key, value]);
    }
  } catch (error) { await restore(); throw error; }
  async function restore() {
    const errors = [];
    for (const [key, value] of saved) {
      try { await launchctl(value ? ['setenv', key, value] : ['unsetenv', key]); }
      catch { errors.push('launchd_environment_restore_failed'); }
    }
    assert.deepEqual(errors, []);
  }
  return {
    enable: async launch => {
      // A successful ownership handoff replaces the document executing this invocation.
      await evaluate(launch.cdp, 'window.__TAURI__.core.invoke("desktop_runtime_service_enable", {allowLegacy:true})')
        .catch(error => { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; });
      return waitReleaseStartup('registered service attachment', async () => {
        const status = await releaseServiceStatus(launch).catch(() => null);
        if (status?.registration?.state === 'requires_approval') throw Error('Service registration requires GUI approval');
        return status?.connected && status.registration.state === 'enabled' ? status : null;
      }, launch.check);
    },
    cold: () => launchctl(['kickstart', '-k', service()]),
    cleanup: async launch => {
      let failure;
      try {
        if (launch) {
          await evaluate(launch.cdp, 'window.__TAURI__.core.invoke("desktop_runtime_service_disable", {})')
            .catch(error => { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; });
          await waitReleaseStartup('service unregister', async () => {
            const status = await releaseServiceStatus(launch).catch(() => null);
            return status?.registration?.state === 'not_registered' && !status.connected;
          }, launch.check);
        }
        assert.equal(await launchctl(['print', service()]).then(() => true, () => false), false, 'Registered service survived cleanup');
      } catch (error) {
        failure = error;
        // This label was proved absent before this run registered it.
        await launchctl(['bootout', service()]).catch(() => {});
      } finally { await restore(); }
      if (failure) throw failure;
    },
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
  } finally { await child.stop(); }
}
