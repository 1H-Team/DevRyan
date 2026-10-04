import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {REVIEWED_CLAUDE_ASSETS} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
const repository=path.resolve(import.meta.dirname,'../..');
const start=async(args:string[])=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/claude-transport-')),home=path.join(root,'home'),directory=path.join(root,'project'),storage=path.join(root,'storage');await Promise.all([home,directory,storage].map(root=>fs.mkdir(root)));
 const instanceID=randomUUID(),buildId='a'.repeat(64),asset={path:path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/assets',REVIEWED_CLAUDE_ASSETS.claude.path),sha256:REVIEWED_CLAUDE_ASSETS.claude.sha256};
 const entry=path.join(root,'entry.ts');await fs.writeFile(entry,`import {runNativeClaudeTransport} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-claude-transport-worker.ts'))};\nconst receipt=await runNativeClaudeTransport(${JSON.stringify({instanceID,buildId})});process.stderr.write(JSON.stringify(receipt)+'\\n');process.exitCode=0;\n`);
 const input={protocol:1,instanceID,buildId,asset,launcher:path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),storage,directories:[directory],profileRoots:[home],keychainAccounts:[{directory:path.join(home,'.claude'),keychainService:'Claude Code-credentials'}],directory,args};
 const child=spawn(process.execPath,[entry],{cwd:directory,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:root,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CLAUDE_CODE_OAUTH_TOKEN:'owned-offline-fixture',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DEVRYAN_PROVIDER_COMMAND:JSON.stringify(input)},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);const ended=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code));});void ended.catch(()=>{});
 return {root,child,ended,output:()=>({stdout,stderr}),asset,directory,async close(){if(child.exitCode===null)child.kill('SIGTERM');await ended;await fs.rm(root,{recursive:true,force:true});}};
};
test('captured Claude executable runs locally through the original confined readonly provider and returns real receipt',async()=>{
 const owned=await start(['--version']);try{expect(await owned.ended).toBe(0);expect(owned.output().stdout).toContain('2.1.251');const receipt=JSON.parse(owned.output().stderr.trim());expect(receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});expect(await fs.readdir(owned.directory)).toEqual([]);}finally{await owned.close();}
},15000);
test('cancelling real Claude while it waits for owned stdin settles the actual supervisor and child before return',async()=>{
 const owned=await start(['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence']);let cliPID:number|undefined;
 try{
  const deadline=Date.now()+10000;while(Date.now()<deadline){const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');const row=rows.find(row=>row.includes(owned.asset.path)&&!row.includes('provider-'));if(row){cliPID=Number(row.trim().split(/\s+/)[0]);break;}await Bun.sleep(20);}
  expect(cliPID).toBeNumber();process.kill(cliPID!,0);expect(owned.child.kill('SIGTERM')).toBe(true);expect(await owned.ended).toBe(0);
  const receipt=JSON.parse(owned.output().stderr.trim());expect(receipt).toMatchObject({terminated:true,confined:true,cancelled:true});expect(()=>process.kill(cliPID!,0)).toThrow();expect(await fs.readdir(owned.directory)).toEqual([]);
 }finally{await owned.close();}
},15000);
