import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {selectInheritedShellEnv} from '../shell-env-inheritance.mjs';
import {provisionDefaultNativeBundle} from '@openchamber/web/server/lib/opencode/runtime-host/native-default-bundle.js';

const mainSource=await fs.readFile(new URL('../main.mjs',import.meta.url),'utf8');
// A v1 desktop user's rc exports: README external-server recipe, the onboarding
// OPENCODE_BINARY hint, a stray relative DB and private state/data overrides.
const shellExports={OPENCODE_PORT:'4096',OPENCODE_SKIP_START:'true',OPENCODE_HOST:'https://fixture.invalid:4096',
 OPENCHAMBER_SKIP_OPENCODE_START:'true',OPENCODE_BINARY:'/fixture/bin/opencode',OPENCODE_DB:'relative.db',
 DEVRYAN_OPENCODE_GENERATION:'1',DEVRYAN_RUNTIME_BUNDLE_ROOT:'/fixture/other-bundles',OPENCHAMBER_DATA_DIR:'/fixture/other-data',
 XDG_STATE_HOME:'/fixture/other-state',OPENCHAMBER_ELECTRON_DEV:'1',OPENCHAMBER_ELECTRON_USER_DATA_DIR:'/fixture/other-user-data',
 OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS:'1',EDITOR:'vim',PATH:'/fixture/shell/bin'};

test('login-shell merge drops desktop-managed names, keeps others and never touches the launch environment',()=>{
 const launchEnv=Object.freeze({PATH:'/usr/bin',HOME:'/fixture/home',EDITOR:'nano',OPENCODE_SKIP_START:'true',XDG_STATE_HOME:'/fixture/state'});
 const {inherited,dropped}=selectInheritedShellEnv(launchEnv,shellExports);
 assert.deepEqual(inherited,{OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS:'1'});
 // Launch-set names (OPENCODE_SKIP_START, XDG_STATE_HOME) are kept by the ordinary rule, not reported.
 assert.deepEqual(dropped,['DEVRYAN_OPENCODE_GENERATION','DEVRYAN_RUNTIME_BUNDLE_ROOT','OPENCHAMBER_DATA_DIR','OPENCHAMBER_ELECTRON_DEV',
  'OPENCHAMBER_ELECTRON_USER_DATA_DIR','OPENCHAMBER_SKIP_OPENCODE_START','OPENCODE_BINARY','OPENCODE_DB','OPENCODE_HOST','OPENCODE_PORT']);
 assert.ok(dropped.every(name=>Object.hasOwn(shellExports,name)));
 assert.deepEqual(selectInheritedShellEnv({},{EDITOR:'vim',DEVRYANISH:'1'}),{inherited:{EDITOR:'vim',DEVRYANISH:'1'},dropped:[]});
 assert.deepEqual(selectInheritedShellEnv({},{XDG_STATE_HOME:'/fixture/s',OPENCHAMBER_DATA_DIR:'/fixture/d'}),{inherited:{},dropped:['OPENCHAMBER_DATA_DIR','XDG_STATE_HOME']});
});

test('shell exports reach provisioning as a no-op and the server control root stays the shell control root',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-shell-env-')));
 try{
  const home=path.join(root,'home');await fs.mkdir(home);
  const provision=async(name,exports)=>{
   const launchEnv={PATH:'/usr/bin',HOME:home,XDG_STATE_HOME:path.join(root,name,'state')};
   const env={...launchEnv,...selectInheritedShellEnv(launchEnv,{...exports,XDG_STATE_HOME:path.join(root,name,'shell-state')}).inherited};
   try{await provisionDefaultNativeBundle({env,home,cwd:home,artifactDirectory:path.join(root,'no-artifacts')});return 'ok';}
   catch(error){return error.code;}
  };
  const control=await provision('control',{});
  assert.notEqual(control,'native_runtime_configuration_unsupported');
  assert.equal(await provision('exports',shellExports),control);
  await fs.access(path.join(root,'exports','state','devryan','runtime-bundles'));
  await assert.rejects(fs.access(path.join(root,'exports','shell-state')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('main inherits the login shell through the filtered merge and logs names only',()=>{
 const start=mainSource.indexOf('const inheritUserShellEnv = ');
 const body=mainSource.slice(start,mainSource.indexOf('\n};\n',start));
 assert.ok(start>=0);
 assert.match(body,/selectInheritedShellEnv\(process\.env, shellEnv\)/);
 assert.doesNotMatch(body,/process\.env\[key\] = value/);
 const logLine=body.split('\n').find(line=>/log\.(info|warn)\(/.test(line));
 assert.ok(logLine&&/dropped\.join\(/.test(logLine)&&!/inherited|shellEnv\[/.test(logLine));
});
