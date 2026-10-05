import {isUnsupportedLoginShellValue} from '@openchamber/web/server/lib/opencode/login-shell-env-filter.js';

export {isDesktopRefusedShellValue} from '@openchamber/web/server/lib/opencode/login-shell-env-filter.js';

/** Login-shell variables absent from the launch environment, except PATH (merged
 * separately) and values the shared login-shell filter rejects (refused values and,
 * when packaged, redirections). `dropped` holds names only, never values. */
export function selectInheritedShellEnv(launchEnv,shellEnv,{packaged=false}={}){
 const inherited={},dropped=[];
 for(const [key,value] of Object.entries(shellEnv)){
  if(key==='PATH'||typeof launchEnv[key]!=='undefined')continue;
  if(isUnsupportedLoginShellValue(key,value,{packaged}))dropped.push(key);else inherited[key]=value;
 }
 return {inherited,dropped:dropped.sort()};
}

/** Login-shell names that choose the shell's data root or the native bundle selector. */
export const SHELL_DATA_ROOT_NAMES=Object.freeze(['OPENCHAMBER_DATA_DIR','XDG_STATE_HOME']);

/** The data-root subset of the login-shell merge. Main adopts it before capturing its
 * roots, so Electron and the server (which inherits the full merge) resolve one root. */
export function selectShellDataRoots(launchEnv,shellEnv,{packaged=false}={}){
 if(!shellEnv)return {};
 const {inherited}=selectInheritedShellEnv(launchEnv,shellEnv,{packaged});
 return Object.fromEntries(SHELL_DATA_ROOT_NAMES.filter(name=>Object.hasOwn(inherited,name)).map(name=>[name,inherited[name]]));
}
