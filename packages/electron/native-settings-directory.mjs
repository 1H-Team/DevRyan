import path from 'node:path';
export function readNativeShellBundleBinding({environment,home,existsSync,readRuntimeBundleBinding}){
 const controlRoot=environment.DEVRYAN_RUNTIME_BUNDLE_ROOT||path.resolve(environment.XDG_STATE_HOME||path.join(home,'.local','state'),'devryan','runtime-bundles');
 return existsSync(path.join(controlRoot,'selection.json'))
  ?readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot},{allowHeldInspection:true}):null;
}
/** Resolve settings from the existing verified native selection without starting
 * a runtime. The shell's service/Bot storage root remains separately captured. */
export function createNativeSettingsDirectory({environment,home,existsSync,readRuntimeBundleBinding}){
 const original=path.resolve(environment.OPENCHAMBER_DATA_DIR||path.join(home,'.config','openchamber'));
 return ()=>{
  // Shell settings reads must also work when the server exposes only its
  // cold recovery page. This grants no runtime or credential authority.
  return readNativeShellBundleBinding({environment,home,existsSync,readRuntimeBundleBinding})?.descriptor.launch.webDataDirectory??original;
 };
}
