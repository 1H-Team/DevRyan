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
