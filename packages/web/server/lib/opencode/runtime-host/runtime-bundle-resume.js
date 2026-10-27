import {createRuntimeBundleStore} from './runtime-bundle.js';
import {runNativeBundleCredentialProcess,NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-process.js';
import {assertPrivateBundleControlRoot} from './bundle-rollback-intent.js';

const fail=code=>Object.assign(new Error(code),{code,status:503});
/** Local OS-owner control only. No HTTP authentication, controller, provider or
 * mutable application owner is constructed to resume a sealed retained B. */
export async function resumeRuntimeBundle({controlRoot,input}){
 if(!input||Object.keys(input).length!==1||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw fail('bundle_selection_revision_conflict');
 await assertPrivateBundleControlRoot(controlRoot);
 const store=createRuntimeBundleStore({controlRoot,allowRecoveredInputStartup:true,
  withQuiescedSource:async()=>{throw fail('bundle_recovery_original_checkpoint_required');},
  runMigration:async()=>{throw fail('bundle_recovery_migration_forbidden');},
  captureCredentials:({descriptor,assertHeld})=>runNativeBundleCredentialProcess({descriptor,assertHeld,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'capture'}}),
 });
 const selection=await store.resume(input);
 return {state:'restart_required',bundleID:selection.selectedBundleID,previousBundleID:selection.previousBundleID,
  revision:selection.revision,reconciliationRequired:false,restartRequired:true};
}
