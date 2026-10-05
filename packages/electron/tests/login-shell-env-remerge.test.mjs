import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

// End to end through a real login shell (/bin/sh reading a private HOME's .profile): main's merge, the
// marker main sets before the server import, then the server's import-time re-merge.
const inheritance=new URL('../shell-env-inheritance.mjs',import.meta.url).href;
const envRuntime=new URL('../../web/server/lib/opencode/env-runtime.js',import.meta.url).href;
const CHILD=`
import {spawnSync} from 'node:child_process';
const {selectInheritedShellEnv}=await import(${JSON.stringify(inheritance)});
const {createOpenCodeEnvRuntime}=await import(${JSON.stringify(envRuntime)});
const {packaged,launch,names}=JSON.parse(process.argv[1]);
Object.assign(process.env,launch);
const raw=spawnSync('/bin/sh',['-il','-c','env -0'],{stdio:['ignore','pipe','ignore']}).stdout.toString();
const shellEnv=Object.fromEntries(raw.split('\\0').filter(Boolean).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
const {inherited,dropped}=selectInheritedShellEnv(process.env,shellEnv,{packaged});
Object.assign(process.env,inherited);
if(packaged)process.env.DEVRYAN_PACKAGED_DESKTOP='1';else delete process.env.DEVRYAN_PACKAGED_DESKTOP;
const logs=[];
createOpenCodeEnvRuntime({state:{},shellCandidates:['/bin/sh'],logger:{info:message=>logs.push(message)}}).applyLoginShellEnvSnapshot();
console.log(JSON.stringify({dropped,logs,env:Object.fromEntries(names.map(name=>[name,process.env[name]??null]))}));
`;
const PROVISIONING=['DEVRYAN_OPENCODE_GENERATION','DEVRYAN_RUNTIME_BUNDLE_ROOT','OPENCHAMBER_SKIP_OPENCODE_START','OPENCODE_BINARY','OPENCODE_DB','OPENCODE_HOST','OPENCODE_SKIP_START'];
const REDIRECTIONS=['DEVRYAN_DEFAULT_CONFIG_ROOT','DEVRYAN_EXECUTION_ARTIFACTS','OPENCHAMBER_ELECTRON_DEV','OPENCHAMBER_ELECTRON_USER_DATA_DIR'];
const KEPT={OPENCHAMBER_DATA_DIR:'/fixture/shell-data',DEVRYAN_PRIMARY_RECOVERY_MODE:'legacy'};

test('after main merges the login shell and the server re-merges it, no dropped name is back in process.env',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'devryan-shell-remerge-'));
 try{
  const home=path.join(root,'home');
  await fs.mkdir(home);
  const shell={OPENCODE_HOST:'http://127.0.0.1:4096',OPENCODE_BINARY:'/fixture/bin/opencode',OPENCODE_SKIP_START:'true',OPENCHAMBER_SKIP_OPENCODE_START:'true',
   OPENCODE_DB:'relative.db',DEVRYAN_OPENCODE_GENERATION:'1',DEVRYAN_RUNTIME_BUNDLE_ROOT:'/nonexistent',OPENCHAMBER_ELECTRON_DEV:'1',
   OPENCHAMBER_ELECTRON_USER_DATA_DIR:'/fixture/shell-user-data',DEVRYAN_EXECUTION_ARTIFACTS:'/fixture/shell-artifacts',DEVRYAN_DEFAULT_CONFIG_ROOT:'/fixture/shell-default-config',...KEPT};
  await fs.writeFile(path.join(home,'.profile'),Object.entries(shell).map(([name,value])=>`export ${name}=${value}\n`).join(''));
  const names=[...PROVISIONING,...REDIRECTIONS,...Object.keys(KEPT)];
  const run=(packaged,launch={})=>{
   const result=spawnSync(process.execPath,['--input-type=module','-e',CHILD,JSON.stringify({packaged,launch,names})],
    {cwd:fileURLToPath(new URL('..',import.meta.url)),env:{PATH:'/usr/bin:/bin',HOME:home,SHELL:'/bin/sh'},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);
   return JSON.parse(result.stdout.trim().split('\n').pop());
  };

  const packaged=run(true);
  assert.deepEqual(packaged.dropped,[...PROVISIONING,...REDIRECTIONS].sort());
  for(const name of [...PROVISIONING,...REDIRECTIONS])assert.equal(packaged.env[name],null,name);
  for(const [name,value] of Object.entries(KEPT))assert.equal(packaged.env[name],value,name);
  assert.equal(packaged.logs.length,1);
  for(const value of Object.values(shell))assert.ok(!packaged.logs[0].includes(value),'server log carries names only');

  const dev=run(false);
  for(const name of PROVISIONING)assert.equal(dev.env[name],null,name);
  for(const name of REDIRECTIONS)assert.equal(dev.env[name],shell[name],name);

  const launch={OPENCODE_SKIP_START:'true',OPENCHAMBER_ELECTRON_DEV:'0',DEVRYAN_EXECUTION_ARTIFACTS:'/launch/artifacts'};
  const launched=run(true,launch);
  for(const [name,value] of Object.entries(launch))assert.equal(launched.env[name],value,name);
  for(const name of [...PROVISIONING,...REDIRECTIONS].filter(name=>!(name in launch)))assert.equal(launched.env[name],null,name);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
