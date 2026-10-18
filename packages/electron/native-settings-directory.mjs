import path from 'node:path';
import {readNativeShellBundleBinding} from '@openchamber/web/server/lib/opencode/runtime-host/runtime-bundle-root.js';
export {readNativeShellBundleBinding};
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
