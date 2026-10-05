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
// Development/packaging redirections of packaged resources (native artifacts, default
// config, dev user-data); a packaged app honours them only from its launch environment.
const PACKAGED_REDIRECTIONS=new Set(['OPENCHAMBER_ELECTRON_DEV','OPENCHAMBER_ELECTRON_USER_DATA_DIR','DEVRYAN_EXECUTION_ARTIFACTS','DEVRYAN_DEFAULT_CONFIG_ROOT']);

/** Login-shell variables absent from the launch environment, except PATH (merged
 * separately), refused values and, when packaged, redirections. `dropped` holds names only, never values. */
export function selectInheritedShellEnv(launchEnv,shellEnv,{packaged=false}={}){
 const inherited={},dropped=[];
 for(const [key,value] of Object.entries(shellEnv)){
  if(key==='PATH'||typeof launchEnv[key]!=='undefined')continue;
  if(isDesktopRefusedShellValue(key,value)||packaged&&PACKAGED_REDIRECTIONS.has(key))dropped.push(key);else inherited[key]=value;
 }
 return {inherited,dropped:dropped.sort()};
}
