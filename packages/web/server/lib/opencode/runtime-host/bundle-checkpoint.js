import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {processIdentity,captureRollbackRegistries} from './bundle-rollback-intent.js';
import {canonicalJSON,sha256} from './bundle-migration-inventory.js';

const fail = code => Object.assign(new Error(code), { code, status: 503 });

/** Constructor-owned source fence. Callback lifetime covers the whole coherent copy. */
export function createRuntimeBundleCheckpoint({ ownerID, generation, launch, closeAdmission, getController,
  stopProducers, drainStores, executionHost, afterExit, beforeControllerStop,assertAdmissionClosed, readProcessIdentity=processIdentity, neverStarted = false }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerID ?? '') || ![1,2].includes(generation)
    || [closeAdmission, getController, stopProducers, drainStores].some(value => typeof value !== 'function')
    || typeof executionHost?.drain !== 'function') throw fail('bundle_checkpoint_owner_required');
  let copying = false, settled = false,settledController,settlement, activeScope;
  return async (source, action) => {
    if (copying) throw fail('bundle_checkpoint_busy');
    if (source.kind === 'bundle' ? source.bundleID !== ownerID : source.kind !== 'legacy'
      || ['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory'].some(key => source.launch?.[key] !== launch[key])) {
      throw fail('bundle_checkpoint_source_mismatch');
    }
    copying = true;
    const scopeIdentity = Symbol('held-checkpoint');
    activeScope = scopeIdentity;
    try {
      if (!settled) {
        await closeAdmission();
        const controller = getController();
        const hostIdentity=controller?.pid?await readProcessIdentity(process.pid):null;
        const controllerIdentity=controller?.pid?await readProcessIdentity(controller.pid):null;
        let controllerExit;
        if (!controller && !neverStarted) throw fail('bundle_checkpoint_controller_unknown');
        if (controller && !controller.hasExited()) {
          if (generation === 2) await controller.call({ action: 'quiesce' });
          else await controller.close();
        }
        await stopProducers();
        await beforeControllerStop?.();
        if (controller && !controller.hasExited()) controllerExit=await controller.close();
        if (controller && !controller.hasExited()) throw fail('bundle_checkpoint_exit_unconfirmed');
        await executionHost.drain();
        await afterExit?.();
        await drainStores();
        if(controllerExit?.receipt&&hostIdentity&&controllerIdentity&&typeof beforeControllerStop==='function'){
          if(controllerExit.expected!==true||controllerExit.pid!==controller.pid||controllerExit.code!==0||controllerExit.signal!==null||controllerExit.receipt.terminated!==true||controllerExit.receipt.confined!==true||controllerExit.receipt.cancelled!==false||controllerExit.receipt.exitCode!==0)throw fail('bundle_checkpoint_exit_unconfirmed');
          const {path:receiptPath,...receipt}=controllerExit.receipt;
          const registries=await captureRollbackRegistries(launch.global?.state);
          settlement={registries,host:hostIdentity,controller:{pid:controllerExit.pid,startIdentity:controllerIdentity.startIdentity,instanceID:controllerExit.instanceID,
            code:controllerExit.code,signal:controllerExit.signal,receipt:{path:receiptPath,...receipt},receiptSha256:sha256(canonicalJSON(receipt))},credentialDrained:true,storesDrained:true};
        }
        settledController=controller;
        settled = true;
      }
      for (const key of ['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory']) {
        if (await fs.realpath(launch[key]) !== launch[key]) throw fail('bundle_checkpoint_path_changed');
      }
      const assertHeld=async()=>{
        const current=getController();
        if(!copying||activeScope!==scopeIdentity||!settled||current&&current!==settledController||settledController&&!settledController.hasExited())throw fail('bundle_checkpoint_scope_expired');
        await assertAdmissionClosed?.();
        if(!copying||activeScope!==scopeIdentity)throw fail('bundle_checkpoint_scope_expired');
      };
      await assertHeld();
      return await action({ checkpointID: randomUUID(), ownerID, generation, databasePath: launch.opencodeDatabasePath,
        webDataDirectory: launch.webDataDirectory, webConfigDirectory: launch.webConfigDirectory,
        opencodeConfigDirectory: launch.opencodeConfigDirectory, settledAt: Date.now() },{assertHeld,...settlement?{settlement}:{}});
    } finally { copying = false; activeScope = undefined; }
  };
}
