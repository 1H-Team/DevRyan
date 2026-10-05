import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {selectInheritedShellEnv} from '../shell-env-inheritance.mjs';
import {provisionDefaultNativeBundle} from '@openchamber/web/server/lib/opencode/runtime-host/native-default-bundle.js';

const mainSource=await fs.readFile(new URL('../main.mjs',import.meta.url),'utf8');
const REFUSED='native_runtime_configuration_unsupported';

test('login-shell merge drops only refused or provisioning-bypassing values and never touches the launch environment',()=>{
 const launchEnv=Object.freeze({PATH:'/usr/bin',HOME:'/fixture/home',EDITOR:'nano',OPENCODE_SKIP_START:'true',XDG_STATE_HOME:'/fixture/state'});
 // A v1 desktop user's rc exports: README external-server recipe, the onboarding
 // OPENCODE_BINARY hint, a stray relative DB and documented rollback/diagnostic switches.
 const {inherited,dropped}=selectInheritedShellEnv(launchEnv,{OPENCODE_PORT:'4096',OPENCODE_SKIP_START:'true',OPENCODE_HOST:'https://fixture.invalid:4096',
  OPENCHAMBER_SKIP_OPENCODE_START:'true',OPENCODE_BINARY:'/fixture/bin/opencode',OPENCODE_DB:'relative.db',DEVRYAN_OPENCODE_GENERATION:'1',
  DEVRYAN_RUNTIME_BUNDLE_ROOT:'/fixture/other-bundles',OPENCHAMBER_DATA_DIR:'/fixture/other-data',XDG_STATE_HOME:'/fixture/other-state',
  DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy',DEVRYAN_DUPLICATE_OUTPUTS:'1',EDITOR:'vim',PATH:'/fixture/shell/bin'});
 assert.deepEqual(inherited,{OPENCODE_PORT:'4096',OPENCHAMBER_DATA_DIR:'/fixture/other-data',DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy',DEVRYAN_DUPLICATE_OUTPUTS:'1'});
 // Launch-set names (OPENCODE_SKIP_START, XDG_STATE_HOME) are kept by the ordinary rule, not reported.
 assert.deepEqual(dropped,['DEVRYAN_OPENCODE_GENERATION','DEVRYAN_RUNTIME_BUNDLE_ROOT','OPENCHAMBER_SKIP_OPENCODE_START','OPENCODE_BINARY','OPENCODE_DB','OPENCODE_HOST']);
 assert.deepEqual(selectInheritedShellEnv({},{XDG_STATE_HOME:'/fixture/s',OPENCHAMBER_DATA_DIR:'/fixture/d'}),{inherited:{XDG_STATE_HOME:'/fixture/s',OPENCHAMBER_DATA_DIR:'/fixture/d'},dropped:[]});
});

test('a packaged app also drops login-shell dev/packaging redirections; dev runs and the launch environment keep them',()=>{
 const redirections={OPENCHAMBER_ELECTRON_DEV:'1',OPENCHAMBER_ELECTRON_USER_DATA_DIR:'/fixture/user-data',
  DEVRYAN_EXECUTION_ARTIFACTS:'/fixture/dev-artifacts',DEVRYAN_DEFAULT_CONFIG_ROOT:'/fixture/default-config'};
 const shellEnv={...redirections,OPENCODE_HOST:'https://fixture.invalid:4096',OPENCHAMBER_DATA_DIR:'/fixture/d',DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy',PATH:'/fixture/shell/bin'};
 assert.deepEqual(selectInheritedShellEnv({PATH:'/usr/bin'},shellEnv,{packaged:true}),{inherited:{OPENCHAMBER_DATA_DIR:'/fixture/d',DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy'},
  dropped:['DEVRYAN_DEFAULT_CONFIG_ROOT','DEVRYAN_EXECUTION_ARTIFACTS','OPENCHAMBER_ELECTRON_DEV','OPENCHAMBER_ELECTRON_USER_DATA_DIR','OPENCODE_HOST']});
 for(const options of [undefined,{packaged:false}])assert.deepEqual(selectInheritedShellEnv({PATH:'/usr/bin'},shellEnv,options),
  {inherited:{...redirections,OPENCHAMBER_DATA_DIR:'/fixture/d',DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy'},dropped:['OPENCODE_HOST']});
 // Launch-set redirections are the packaged app's own decision and stay untouched, not reported.
 assert.deepEqual(selectInheritedShellEnv(Object.freeze({...redirections}),shellEnv,{packaged:true}),{inherited:{OPENCHAMBER_DATA_DIR:'/fixture/d',DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy'},dropped:['OPENCODE_HOST']});
});

test('every shell-only value is dropped exactly when provisioning would refuse it or be bypassed by it',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-shell-env-')));
 try{
  const home=path.join(root,'home');await fs.mkdir(home);
  const launchEnv=Object.freeze({PATH:'/usr/bin',HOME:home});
  const provision=async env=>{
   try{return {root:await provisionDefaultNativeBundle({env,home,cwd:home,artifactDirectory:path.join(root,'no-artifacts')})};}
   catch(error){return {code:error.code};}
  };
  const cases=[['OPENCODE_DB','relative.db'],['OPENCODE_DB',''],['OPENCODE_DB',path.join(root,'opencode.db')],
   ['OPENCODE_HOST','https://fixture.invalid:4096'],['OPENCODE_HOST',''],['OPENCODE_SKIP_START','true'],['OPENCODE_SKIP_START','false'],
   ['OPENCHAMBER_SKIP_OPENCODE_START','true'],['OPENCHAMBER_SKIP_OPENCODE_START','1'],['OPENCODE_BINARY','/fixture/bin/opencode'],['OPENCODE_BINARY',''],
   ['DEVRYAN_OPENCODE_GENERATION','1'],['DEVRYAN_OPENCODE_GENERATION',''],['DEVRYAN_OPENCODE_GENERATION','2'],
   ['DEVRYAN_RUNTIME_BUNDLE_ROOT',path.join(root,'other-bundles')],['DEVRYAN_RUNTIME_BUNDLE_ROOT',''],
   ['OPENCODE_PORT','4096'],['OPENCHAMBER_DATA_DIR',path.join(root,'data')],['XDG_STATE_HOME',path.join(root,'state')],
   ['XDG_STATE_HOME',''],['XDG_STATE_HOME','state'],['XDG_STATE_HOME',root+'/../foreign'],['XDG_STATE_HOME',root+'/\nforeign'],
   ['OPENCHAMBER_ELECTRON_DEV','1'],['OPENCHAMBER_ELECTRON_USER_DATA_DIR',path.join(root,'user-data')],
   ['DEVRYAN_PRIMARY_RECOVERY_MODE','legacy'],['DEVRYAN_MANAGED_RESULT_MODE','full']];
  const control=await provision(launchEnv);
  assert.ok(control.code&&control.code!==REFUSED,JSON.stringify(control));
  for(const [name,value] of cases){
   const label=`${name}=${JSON.stringify(value)}`;
   const {inherited,dropped}=selectInheritedShellEnv(launchEnv,{[name]:value});
   const merged=await provision({...launchEnv,...inherited});
   assert.ok(merged.code&&merged.code!==REFUSED,`${label} after merge: ${JSON.stringify(merged)}`);
   const launched=await provision({...launchEnv,[name]:value});
   const refusedOrBypassed=launched.code===REFUSED||launched.code==='bundle_recovery_owner_required'||launched.root===value;
   assert.deepEqual(dropped,refusedOrBypassed?[name]:[],`${label} launched: ${JSON.stringify(launched)}`);
   if(!dropped.length)assert.deepEqual(inherited,{[name]:value},label);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('main inherits the login shell through the filtered merge and logs names only',()=>{
 const start=mainSource.indexOf('const inheritUserShellEnv = ');
 const body=mainSource.slice(start,mainSource.indexOf('\n};\n',start));
 assert.ok(start>=0);
 assert.match(body,/selectInheritedShellEnv\(process\.env, shellEnv, \{ packaged: app\.isPackaged \}\)/);
 assert.doesNotMatch(body,/process\.env\[key\] = value/);
 const logLine=body.split('\n').find(line=>/log\.(info|warn)\(/.test(line));
 assert.ok(logLine&&/dropped\.join\(/.test(logLine)&&!/inherited|shellEnv\[/.test(logLine));
});

test('main marks a packaged app for the server re-merge before importing the server',()=>{
 const marker=mainSource.indexOf("if (app.isPackaged) process.env[PACKAGED_DESKTOP_ENV] = '1'; else delete process.env[PACKAGED_DESKTOP_ENV];");
 assert.ok(marker>0);
 // The server entry is evaluated (imported) by its loader at this call.
 const serverImport=mainSource.indexOf('await webServerEntry.load()');
 assert.ok(serverImport>0);
 assert.ok(marker<serverImport);
 assert.match(mainSource,/import \{ PACKAGED_DESKTOP_ENV \} from '@openchamber\/web\/server\/lib\/opencode\/login-shell-env-filter\.js';/);
});
