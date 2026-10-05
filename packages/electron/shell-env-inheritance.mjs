import path from 'node:path';

// Login-shell values that would make provisionDefaultNativeBundle refuse to start
// (mirrors its refusal predicate), plus the bundle root that bypasses provisioning.
// Every other login-shell export, including documented DEVRYAN_* switches, is inherited.
const PROVISIONING_REFUSES={
 OPENCODE_DB:value=>!path.isAbsolute(value),OPENCODE_HOST:Boolean,OPENCODE_BINARY:Boolean,
 OPENCODE_SKIP_START:value=>value==='true',OPENCHAMBER_SKIP_OPENCODE_START:value=>value==='true',
 DEVRYAN_OPENCODE_GENERATION:value=>value!=='2',DEVRYAN_RUNTIME_BUNDLE_ROOT:()=>true,
};
export const isDesktopRefusedShellValue=(name,value)=>Object.hasOwn(PROVISIONING_REFUSES,name)&&PROVISIONING_REFUSES[name](value);

/** Login-shell variables absent from the launch environment, except PATH (merged
 * separately) and refused values. `dropped` holds names only, never values. */
export function selectInheritedShellEnv(launchEnv,shellEnv){
 const inherited={},dropped=[];
 for(const [key,value] of Object.entries(shellEnv)){
  if(key==='PATH'||typeof launchEnv[key]!=='undefined')continue;
  if(isDesktopRefusedShellValue(key,value))dropped.push(key);else inherited[key]=value;
 }
 return {inherited,dropped:dropped.sort()};
}
