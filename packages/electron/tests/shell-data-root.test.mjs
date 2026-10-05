import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {selectShellDataRoots} from '../shell-env-inheritance.mjs';

const mainSource=await fs.readFile(new URL('../main.mjs',import.meta.url),'utf8');

test('only login-shell data-root names absent from the launch environment are adopted early',()=>{
 const shellEnv={OPENCHAMBER_DATA_DIR:'/fixture/shell-data',XDG_STATE_HOME:'/fixture/shell-state',OPENCODE_PORT:'4096',PATH:'/fixture/bin'};
 assert.deepEqual(selectShellDataRoots({},shellEnv,{packaged:true}),{OPENCHAMBER_DATA_DIR:'/fixture/shell-data',XDG_STATE_HOME:'/fixture/shell-state'});
 assert.deepEqual(selectShellDataRoots({XDG_STATE_HOME:'/launch/state'},shellEnv,{packaged:true}),{OPENCHAMBER_DATA_DIR:'/fixture/shell-data'});
 assert.deepEqual(selectShellDataRoots({},null,{packaged:true}),{});
 assert.deepEqual(selectShellDataRoots({},{PATH:'/fixture/bin'},{packaged:false}),{});
});

// End to end through a real login shell (/bin/sh reading a private HOME's .profile):
// main's early adoption and root capture, then main's full merge and the server's
// import-time re-merge, which the server's data owners read.
const inheritance=new URL('../shell-env-inheritance.mjs',import.meta.url).href;
const settingsDirectory=new URL('../native-settings-directory.mjs',import.meta.url).href;
const envRuntime=new URL('../../web/server/lib/opencode/env-runtime.js',import.meta.url).href;
const CHILD=`
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const {selectInheritedShellEnv,selectShellDataRoots}=await import(${JSON.stringify(inheritance)});
const {readNativeShellBundleBinding}=await import(${JSON.stringify(settingsDirectory)});
const {createOpenCodeEnvRuntime}=await import(${JSON.stringify(envRuntime)});
const raw=spawnSync('/bin/sh',['-il','-c','env -0'],{stdio:['ignore','pipe','ignore']}).stdout.toString();
const shellEnv=Object.fromEntries(raw.split('\\0').filter(Boolean).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
Object.assign(process.env,selectShellDataRoots(process.env,shellEnv,{packaged:true}));
const electronDataRoot=path.resolve(process.env.OPENCHAMBER_DATA_DIR||path.join(os.homedir(),'.config','openchamber'));
let electronControlRoot=null;
readNativeShellBundleBinding({environment:{...process.env},home:os.homedir(),existsSync:file=>{electronControlRoot=path.dirname(file);return false;},readRuntimeBundleBinding:()=>null});
Object.assign(process.env,selectInheritedShellEnv(process.env,shellEnv,{packaged:true}).inherited);
process.env.DEVRYAN_PACKAGED_DESKTOP='1';
createOpenCodeEnvRuntime({state:{},shellCandidates:['/bin/sh'],logger:{info:()=>{}}}).applyLoginShellEnvSnapshot();
const serverDataRoot=path.resolve(process.env.OPENCHAMBER_DATA_DIR||path.join(os.homedir(),'.config','openchamber'));
const serverControlRoot=path.resolve(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local','state'),'devryan','runtime-bundles');
console.log(JSON.stringify({electronDataRoot,serverDataRoot,electronControlRoot,serverControlRoot}));
`;

test('Electron and the server resolve the same data and bundle-control roots when only the login shell sets them',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-shell-data-root-')));
 try{
  const home=path.join(root,'home');
  await fs.mkdir(home);
  const run=async profile=>{
   await fs.writeFile(path.join(home,'.profile'),profile);
   const result=spawnSync(process.execPath,['--input-type=module','-e',CHILD],
    {cwd:fileURLToPath(new URL('..',import.meta.url)),env:{PATH:'/usr/bin:/bin',HOME:home,SHELL:'/bin/sh'},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);
   return JSON.parse(result.stdout.trim().split('\n').pop());
  };
  const shellData=path.join(root,'shell-data'),shellState=path.join(root,'shell-state');
  const exported=await run(`export OPENCHAMBER_DATA_DIR=${shellData}\nexport XDG_STATE_HOME=${shellState}\n`);
  assert.equal(exported.electronDataRoot,shellData);
  assert.equal(exported.serverDataRoot,shellData);
  assert.equal(exported.electronControlRoot,path.join(shellState,'devryan','runtime-bundles'));
  assert.equal(exported.serverControlRoot,exported.electronControlRoot);
  const unset=await run('');
  assert.equal(unset.electronDataRoot,path.join(home,'.config','openchamber'));
  assert.equal(unset.serverDataRoot,unset.electronDataRoot);
  assert.equal(unset.serverControlRoot,unset.electronControlRoot);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('main adopts the login-shell data roots before capturing its roots or reading the bundle binding',()=>{
 const adoption=mainSource.indexOf('Object.assign(process.env, selectShellDataRoots(process.env, loadShellEnv(), { packaged: app.isPackaged }));');
 assert.ok(adoption>0,'main adopts the login-shell data roots');
 const capture=mainSource.search(/^const hostDataRootDirectory\s*=/m);
 const binding=mainSource.indexOf("await import('@openchamber/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js')");
 assert.ok(capture>adoption&&binding>adoption);
 // The status-only control probe never runs the login shell.
 assert.match(mainSource.slice(mainSource.lastIndexOf('\n',adoption-1)-80,adoption),/if \(!isRuntimeServiceControlProbe\)/);
});
