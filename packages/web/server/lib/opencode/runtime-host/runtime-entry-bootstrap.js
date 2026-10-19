import {provisionDefaultNativeBundle} from './native-default-bundle.js';
import {initializeRuntimeBundleBinding} from './runtime-bundle-binding.js';
import {resolveDevRyanDataRoot} from '@devryan/shared-runtime/node/data-root.js';
import {captureNativeSetupOwners,restoreNativeSetupOwners} from './native-setup-local-owners.js';
import {timeStartupPhase} from '../startup-timing.js';

/** The native launcher, run by the entrypoint before it imports any data-store
 * owner, in order: capture the shell-owned setup, provision the bundle (with the
 * cold startup upgrade), verify and bind the selection, which sets the bound
 * DEVRYAN_DATA_DIR/OPENCODE_CONFIG_DIR/OPENCODE_CONFIG. Only then may the
 * entrypoint import a composition. Importing this module does nothing. */
export async function prepareNativeRuntimeEntry(){
 const sourceDataDirectory=resolveDevRyanDataRoot();
 const controlRoot=await provisionDefaultNativeBundle({captureLogicalSetup:()=>captureNativeSetupOwners(sourceDataDirectory)});
 process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT=controlRoot;
 const binding=await timeStartupPhase('bundle_prepared_bound',()=>initializeRuntimeBundleBinding(process.env,{allowHeldInspection:true}));
 if(binding.admission!=='held')await restoreNativeSetupOwners(binding.descriptor.launch.webDataDirectory);
 return binding;
}
