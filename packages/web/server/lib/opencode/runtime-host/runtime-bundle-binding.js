import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {readRollbackIntentSync,rollbackIntentUnresolved} from './bundle-rollback-intent.js';

const fail = () => Object.assign(new Error('runtime_bundle_binding_invalid'), { code: 'runtime_bundle_binding_invalid', status: 503 });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const read = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw fail();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

/** Bind immutable launch paths before importing store owners. Full resume verification still precedes admission. */
export function readRuntimeBundleBinding(environment = process.env,{allowHeldInspection=false}={}) {
  const configured = environment.DEVRYAN_RUNTIME_BUNDLE_ROOT;
  if (configured === undefined) return null;
  if (typeof configured !== 'string' || !path.isAbsolute(configured) || /[\u0000-\u001f]/.test(configured)) throw fail();
  const controlRoot = fs.realpathSync(configured), selection = read(path.join(controlRoot, 'selection.json'));
  if (selection?.schema !== 1 || !Number.isSafeInteger(selection.revision) || selection.revision < 1 || !id(selection.selectedBundleID)
    || !(selection.previousBundleID === null || id(selection.previousBundleID)) || !['activate','rollback'].includes(selection.transition)
    || typeof selection.reconciliationRequired !== 'boolean' || !/^[a-f0-9]{64}$/.test(selection.preparedManifestSha256)) throw fail();
  let rollbackRecovery=null;
  try{const intent=readRollbackIntentSync(controlRoot);if(rollbackIntentUnresolved(intent,selection))rollbackRecovery={reason:'bundle_rollback_pending',candidateBundleID:intent.candidateBundleID,targetBundleID:intent.targetBundleID};}
  catch{rollbackRecovery={reason:'bundle_rollback_proof_invalid'};}
  if ((selection.reconciliationRequired||rollbackRecovery)&&!allowHeldInspection) throw Object.assign(new Error('bundle_rollback_reconciliation_required'), {code:'bundle_rollback_reconciliation_required',status:503});
  const bundleRoot = path.join(controlRoot, 'bundles', selection.selectedBundleID);
  if (fs.realpathSync(bundleRoot) !== bundleRoot) throw fail();
  const descriptor = read(path.join(bundleRoot, 'descriptor.json'));
  if (descriptor?.schema !== 1 || descriptor.bundleID !== selection.selectedBundleID || descriptor.generation !== 2
    || !Number.isFinite(descriptor.createdAt) || !descriptor.checkpoint || !id(descriptor.checkpoint.checkpointID)
    || !id(descriptor.checkpoint.ownerID) || ![1,2].includes(descriptor.checkpoint.generation)
    || !Number.isFinite(descriptor.checkpoint.settledAt) || descriptor.checkpoint.settledAt<=0
    || (descriptor.sourceBundleID!==undefined && !id(descriptor.sourceBundleID))
    || !descriptor.launch || !Array.isArray(descriptor.projectMap) || !descriptor.projectMap.length) throw fail();
  const launch = descriptor.launch;
  const absolute = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/.test(value) || path.resolve(value) !== value) throw fail();
    return value;
  };
  const owned = value => {
    absolute(value);
    if (!value.startsWith(`${bundleRoot}${path.sep}`) || fs.realpathSync(value) !== value) throw fail();
    return value;
  };
  for (const key of ['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory','reviewedNativeConfigPath','reviewedPluginManifestPath']) owned(launch[key]);
  const expected={opencodeDatabasePath:path.join(bundleRoot,'opencode','opencode.db'),
    webDataDirectory:path.join(bundleRoot,'web-data'),webConfigDirectory:path.join(bundleRoot,'config','openchamber'),
    opencodeConfigDirectory:path.join(bundleRoot,'config','opencode'),reviewedNativeConfigPath:path.join(bundleRoot,'config','reviewed-native.json'),
    reviewedPluginManifestPath:path.join(bundleRoot,'config','reviewed-plugins.json')};
  for (const [key,file] of Object.entries(expected)) if (launch[key]!==file) throw fail();
  for (const key of ['home','config','data','state','cache','bin','log','repos','tmp']) owned(launch.global?.[key]);
  if (launch.global.config !== launch.opencodeConfigDirectory || launch.webConfigDirectory === launch.opencodeConfigDirectory
    || !/^[a-f0-9]{64}$/.test(launch.artifactManifestSha256)) throw fail();
  absolute(launch.controllerBinary); absolute(launch.artifactManifestPath);
  if (descriptor.generation === 2) { absolute(launch.writerBinary); owned(descriptor.migrationReceiptPath); }
  owned(descriptor.preparedManifestPath);
  if (descriptor.preparedManifestPath!==path.join(bundleRoot,'prepared.json') || descriptor.generation===2 && descriptor.migrationReceiptPath!==path.join(bundleRoot,'sources','migration.json')) throw fail();
  for (const [key,file] of Object.entries(launch.global)) if (key!=='config'
    && file!==path.join(bundleRoot,'global',key,)) throw fail();
  for (const key of ['databasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory']) absolute(descriptor.checkpoint[key]);
  const manifest=read(descriptor.preparedManifestPath);
  if (selection.preparedManifestSha256!==createHash('sha256').update(fs.readFileSync(descriptor.preparedManifestPath)).digest('hex')) throw fail();
  if (manifest?.schema!==1 || manifest.bundleID!==descriptor.bundleID || manifest.checkpointID!==descriptor.checkpoint.checkpointID
    || manifest.descriptorSha256!==createHash('sha256').update(fs.readFileSync(path.join(bundleRoot,'descriptor.json'))).digest('hex')) throw fail();
  for (const mapping of descriptor.projectMap) {
    absolute(mapping.sourceDirectory); absolute(mapping.targetDirectory);
    if (!['identity','synthetic-copy'].includes(mapping.mode) || fs.realpathSync(mapping.targetDirectory) !== mapping.targetDirectory) throw fail();
  }
  return freeze({ controlRoot, bundleRoot, selection, descriptor,admission:selection.reconciliationRequired||rollbackRecovery?'held':'pending',...(rollbackRecovery?{rollbackRecovery}:{}) });
}

// Store/UI imports may inspect a held selection. This binding never grants
// native admission; the constructing runtime owner must reconcile first.
export let selectedRuntimeBundle = readRuntimeBundleBinding(process.env,{allowHeldInspection:true});
export function initializeRuntimeBundleBinding(environment=process.env,options) {
  const selected=readRuntimeBundleBinding(environment,options);
  if(!selected)throw fail();
  if(selectedRuntimeBundle&&(selectedRuntimeBundle.controlRoot!==selected.controlRoot||selectedRuntimeBundle.bundleRoot!==selected.bundleRoot
    ||selectedRuntimeBundle.selection.revision!==selected.selection.revision))throw fail();
  selectedRuntimeBundle=selected;
  process.env.OPENCHAMBER_DATA_DIR=selected.descriptor.launch.webDataDirectory;
  process.env.OPENCODE_CONFIG_DIR=selected.descriptor.launch.opencodeConfigDirectory;
  const customConfig=path.join(selected.descriptor.launch.opencodeConfigDirectory,'native-custom-config.json');
  if(fs.existsSync(customConfig)){const stat=fs.lstatSync(customConfig);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(customConfig)!==customConfig)throw fail();}
  process.env.OPENCODE_CONFIG=fs.existsSync(customConfig)?customConfig:path.join(selected.descriptor.launch.opencodeConfigDirectory,'config.json');
  return selected;
}
export const getRuntimeHome = () => selectedRuntimeBundle?.descriptor.launch.global.home ?? os.homedir();
if(selectedRuntimeBundle)initializeRuntimeBundleBinding(process.env,{allowHeldInspection:true});
