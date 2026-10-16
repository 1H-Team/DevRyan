import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
for(const compiled of [false,true])test(`pinned API-key Session WebSocket connect, effective idle, frame reset and Stop compiled=${compiled}`,async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-native-websocket-')));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const entry=path.join(repository,'scripts/opencode-v2-native/native-openai-websocket-fixture.mjs');
  const executable=path.join(root,compiled?'DevRyan-native-websocket-fixture':'fixture.mjs');
  if(compiled)execFileSync('df',['-h',repository],{stdio:'pipe'});
  const built=await Bun.build({entrypoints:[entry],target:'bun',...(compiled?{compile:{target:'bun-darwin-arm64',outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false}}:{outdir:root,naming:{entry:'fixture.mjs',asset:'[name]-[hash].[ext]'}}),
   plugins:[await createNativeAssetFixturePlugin(repository)]});
  if(!built.success)throw new AggregateError(built.logs,'WebSocket fixture build failed');
  if(compiled)await fs.chmod(executable,0o755);else await writeNativeFixtureOutputs(built.outputs);
  const home=path.join(root,'home');await fs.mkdir(home,{recursive:true});
  child=Bun.spawn(compiled?[executable]:[process.execPath,executable],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:home,XDG_CONFIG_HOME:home,XDG_DATA_HOME:home,XDG_STATE_HOME:home,XDG_CACHE_HOME:home},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Fixture pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0)throw Error(JSON.stringify({code,stderr}));
  expect(JSON.parse(stdout)).toEqual({apiKeySessionWebSocket:true,proof:[
   {scenario:'connect',connectTimeoutMs:15000,fallback:'http',bindings:[{idleTimeout:null,modelHttpChunkTimeout:900000}]},
   {scenario:'default-idle',idleTimeoutMs:1800000,heartbeatReset:false,bindings:[{idleTimeout:null,modelHttpChunkTimeout:900000}]},
   {scenario:'configured-idle-reset',idleTimeoutMs:50,heartbeatReset:true,bindings:[{idleTimeout:50,modelHttpChunkTimeout:50}]},
   {scenario:'disabled-idle-stop',idleDisabled:true,stopClosedSocket:true,bindings:[{idleTimeout:false,modelHttpChunkTimeout:false}]},
  ]});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},60000);
