// The desktop app manages its own runtime. Login-shell exports must not select
// another runtime (provisioning refuses these) or move the data/state roots the
// shell already derived from the launch environment before inheritance.
const MANAGED_NAMES=new Set(['OPENCODE_BINARY','OPENCODE_HOST','OPENCODE_PORT','OPENCODE_SKIP_START','OPENCHAMBER_SKIP_OPENCODE_START',
 'OPENCODE_DB','OPENCHAMBER_DATA_DIR','XDG_STATE_HOME','OPENCHAMBER_ELECTRON_DEV','OPENCHAMBER_ELECTRON_USER_DATA_DIR']);
export const isDesktopManagedEnvName=name=>MANAGED_NAMES.has(name)||name.startsWith('DEVRYAN_');

/** Login-shell variables absent from the launch environment, except PATH (merged
 * separately) and desktop-managed names. `dropped` holds names only, never values. */
export function selectInheritedShellEnv(launchEnv,shellEnv){
 const inherited={},dropped=[];
 for(const [key,value] of Object.entries(shellEnv)){
  if(key==='PATH'||typeof launchEnv[key]!=='undefined')continue;
  if(isDesktopManagedEnvName(key))dropped.push(key);else inherited[key]=value;
 }
 return {inherited,dropped:dropped.sort()};
}
