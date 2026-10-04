import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runReadOnlySessionExecution} from '../../packages/harness-runtime/lib/session-execution.js';
import {createCursorHttpProvider} from './cursor-http-provider.mjs';
import {repositoryRoot,DEFAULT_RG} from './artifacts.mjs';

/** Native prerequisite check: original SDK store and transport in a long,
 * confined private lease. Unavailable launchers fail this explicit check. */
export async function verifyConfinedCursorStore({artifactRoot}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(repositoryRoot,'.cache/v2-validation/cursor-confined-store-')));
 const storage=path.join(root,'bundles/bundles/candidate/web-data/harness/session-mutations', 'a'.repeat(64),'views');
 const requests=[],provider=await createCursorHttpProvider({expectedApiKey:()=> 'owned-loopback-store-key',onRequest:row=>requests.push(row),
  models:[{id:'composer',displayName:'Owned Composer'},{id:'auto',displayName:'Owned Auto'}]});
 let failure,result,title;
 try{
  result=await runReadOnlySessionExecution({launcher:path.join(artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`),storage,
   command:process.execPath,args:[path.join(repositoryRoot,'packages/cursor-sdk-runtime/node-worker.mjs')],socketDirectory:null,workerBrowsers:false,
   env:{PATH:'/usr/bin:/bin',CURSOR_BACKEND_URL:provider.baseURL,OPENCHAMBER_CURSOR_SETTING_SOURCES:'none',CURSOR_SDK_RIPGREP_PATH:DEFAULT_RG},
   inputForLease:lease=>JSON.stringify({sessionID:'ses_confined_store',apiKey:'owned-loopback-store-key',directory:lease.workingDirectory,
    modelID:'composer',prompt:'Owned SQLite and transport check'}),signal:AbortSignal.timeout(30_000)});
  assert.equal(result.receipt.terminated,true);assert.equal(result.receipt.confined,true);assert.equal(result.receipt.cancelled,false);assert.equal(result.receipt.exitCode,0);
  assert.equal(result.stderr.toString(),'');
  const events=result.stdout.toString().trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events.some(row=>row.type==='error'),false);
  assert.equal(events.find(row=>row.type==='final-result')?.result.finalText,'Owned Cursor transport reply');
  assert.equal(events.find(row=>row.type==='final-result')?.result.finalStatus,'success');
  assert.equal(requests.filter(row=>row.pathname==='/agent.v1.AgentService/RunSSE').length,1);
  assert.equal(requests.find(row=>row.pathname==='/auth/exchange_user_api_key')?.selectedCredentialObserved,true);
  title=await runReadOnlySessionExecution({launcher:path.join(artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`),storage,
   command:process.execPath,args:[path.join(repositoryRoot,'packages/cursor-sdk-runtime/node-worker.mjs')],socketDirectory:null,workerBrowsers:false,
   env:{PATH:'/usr/bin:/bin',CURSOR_BACKEND_URL:provider.baseURL,OPENCHAMBER_CURSOR_SETTING_SOURCES:'none',CURSOR_SDK_RIPGREP_PATH:DEFAULT_RG},
   inputForLease:lease=>JSON.stringify({type:'title',apiKey:'owned-loopback-store-key',directory:lease.workingDirectory,text:'Owned title store check'}),
   signal:AbortSignal.timeout(30_000)});
  assert.equal(title.receipt.terminated,true);assert.equal(title.receipt.confined,true);assert.equal(title.receipt.cancelled,false);assert.equal(title.receipt.exitCode,0);
  assert.equal(title.stderr.toString(),'');
  const titleEvents=title.stdout.toString().trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(titleEvents.some(row=>row.type==='error'),false);
  assert.equal(titleEvents.find(row=>row.type==='title-result')?.title,'Owned Cursor transport reply');
  assert.equal(requests.filter(row=>row.pathname==='/agent.v1.AgentService/RunSSE').length,2);
 }catch(error){failure={code:error.code??error.name,message:error.message};}
 finally{await provider.close();}
 const proof={root,receipt:result?.receipt,titleReceipt:title?.receipt,requests,...failure?{failure}:{}};
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(JSON.stringify(proof));if(failure)process.exitCode=1;return proof;
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const at=process.argv.indexOf('--artifact-root');assert.ok(at>=0&&process.argv[at+1]);
 await verifyConfinedCursorStore({artifactRoot:await fs.realpath(path.resolve(process.argv[at+1]))});
}
