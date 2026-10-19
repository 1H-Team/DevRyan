import path from 'node:path';
import {resolveDevRyanDataRoot} from '../shared-runtime/lib/data-root.js';
import {readNativeShellBundleBinding} from '@devryan/web/server/lib/opencode/runtime-host/runtime-bundle-root.js';
export {readNativeShellBundleBinding};
/** Resolve settings from the existing verified native selection without starting
 * a runtime. The shell's service/Bot storage root remains separately captured. */
export function createNativeSettingsDirectory({environment,home,existsSync,readRuntimeBundleBinding}){
 const original=resolveDevRyanDataRoot({env:environment,home});
 return ()=>{
  // Shell settings reads must also work when the server exposes only its
  // cold recovery page. This grants no runtime or credential authority.
  return readNativeShellBundleBinding({environment,home,existsSync,readRuntimeBundleBinding})?.descriptor.launch.webDataDirectory??original;
 };
}
