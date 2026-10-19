import path from 'node:path';
import { canonicalEnvironmentName } from '@openchamber/shared-runtime/lib/legacy-environment.js';

// The single login-shell filter shared by Electron main's merge
// (packages/electron/shell-env-inheritance.mjs) and the server's re-merge
// (env-runtime.js applyLoginShellEnvSnapshot). It judges login-shell values only;
// launch-environment values are never passed through it.

// Login-shell values that would make provisionDefaultNativeBundle refuse to start
// (mirrors its refusal predicate), plus the bundle root that bypasses provisioning.
// Filtered in every runtime. Names are canonical; an OPENCHAMBER_* alias is judged
// as its DEVRYAN_* name.
const PROVISIONING_REFUSES={
 OPENCODE_DB:value=>!path.isAbsolute(value),OPENCODE_HOST:Boolean,OPENCODE_BINARY:Boolean,
 OPENCODE_SKIP_START:value=>value==='true',DEVRYAN_SKIP_OPENCODE_START:value=>value==='true',
 DEVRYAN_OPENCODE_GENERATION:value=>value!=='2',DEVRYAN_RUNTIME_BUNDLE_ROOT:()=>true,
 XDG_STATE_HOME:value=>value!==''&&(!path.isAbsolute(value)||path.normalize(value)!==value||/[\u0000-\u001f]/.test(value)),
};
export const isDesktopRefusedShellValue=(name,value)=>{
 const canonical=canonicalEnvironmentName(name);
 return Object.hasOwn(PROVISIONING_REFUSES,canonical)&&PROVISIONING_REFUSES[canonical](value);
};
// Development/packaging redirections of packaged resources (native artifacts, default
// config, dev user-data); a packaged app honours them only from its launch environment.
const PACKAGED_REDIRECTIONS=new Set(['DEVRYAN_ELECTRON_DEV','DEVRYAN_ELECTRON_USER_DATA_DIR','DEVRYAN_EXECUTION_ARTIFACTS','DEVRYAN_DEFAULT_CONFIG_ROOT']);

/** Set to '1' by Electron main (from app.isPackaged) before it imports the server,
 * so the server's re-merge applies the packaged filter without inferring it. */
export const PACKAGED_DESKTOP_ENV='DEVRYAN_PACKAGED_DESKTOP';
export const isPackagedDesktopEnv=(env=process.env)=>env[PACKAGED_DESKTOP_ENV]==='1';

/** True when a login-shell value must not be inherited. */
export const isUnsupportedLoginShellValue=(name,value,{packaged=false}={})=>
 isDesktopRefusedShellValue(name,value)||packaged&&PACKAGED_REDIRECTIONS.has(canonicalEnvironmentName(name));
