import {provisionDefaultNativeBundle} from './native-default-bundle.js';
import {initializeRuntimeBundleBinding} from './runtime-bundle-binding.js';
import os from 'node:os';
import path from 'node:path';
import {captureNativeSetupOwners,restoreNativeSetupOwners} from './native-setup-local-owners.js';
import {timeStartupPhase} from '../startup-timing.js';
import {assertStartupBundleUpgradeSucceeded} from './bundle-startup-upgrade-status.js';

// This dependency executes before the entrypoint imports any data-store owner.
const sourceDataDirectory=path.resolve(process.env.OPENCHAMBER_DATA_DIR||path.join(os.homedir(),'.config','openchamber'));
const controlRoot=await provisionDefaultNativeBundle({captureLogicalSetup:()=>captureNativeSetupOwners(sourceDataDirectory)});
assertStartupBundleUpgradeSucceeded();
process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT=controlRoot;
const binding=await timeStartupPhase('bundle_prepared_bound',()=>initializeRuntimeBundleBinding(process.env,{allowHeldInspection:true}));
if(binding.admission!=='held')await restoreNativeSetupOwners(binding.descriptor.launch.webDataDirectory);
