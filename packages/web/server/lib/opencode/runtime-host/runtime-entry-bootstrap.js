import {provisionDefaultNativeBundle} from './native-default-bundle.js';
import {initializeRuntimeBundleBinding} from './runtime-bundle-binding.js';
import os from 'node:os';
import path from 'node:path';
import {captureNativeSetupOwners,restoreNativeSetupOwners} from './native-setup-local-owners.js';

// This dependency executes before the entrypoint imports any data-store owner.
const sourceDataDirectory=path.resolve(process.env.OPENCHAMBER_DATA_DIR||path.join(os.homedir(),'.config','openchamber'));
process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT=await provisionDefaultNativeBundle({captureLogicalSetup:()=>captureNativeSetupOwners(sourceDataDirectory)});
const binding=initializeRuntimeBundleBinding(process.env,{allowHeldInspection:true});
if(binding.admission!=='held')await restoreNativeSetupOwners(binding.descriptor.launch.webDataDirectory);
