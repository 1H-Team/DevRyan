import {test,expect} from 'bun:test';
import {createControllerHelperText} from '../../packages/web/server/lib/opencode/runtime-host/controller-helper-text.js';
import {runWithRequestPermit} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
const permit={token:'d'.repeat(64),sessionID:'ses_helper_http',revision:0};
const input={directory:'/fixture',agent:'devryan-commit',providerID:'fixture',modelID:'chosen',prompt:'Exact'};
const request=()=>new Request('http://fixture/devryan/helper-text',{method:'POST',headers:{'content-type':'application/json','x-devryan-native-permit':JSON.stringify(permit)},body:JSON.stringify(input)});
test('authenticated helper reports provider status only after actual failure settlement and never leaks upstream response details',async()=>{
 const phases:string[]=[];
 const handler=createControllerHelperText({isCurrent:()=>true,rename:async()=>{throw Error('No rename');},rpc:async method=>{phases.push(method);},generate:async()=>{phases.push('provider settled');throw {reason:{http:{status:429,headers:{authorization:'must not publish'}},body:'secret provider payload'}};}});
 const req=request(),response=await runWithRequestPermit(req.headers,()=>handler(req));
 expect(response.status).toBe(429);expect(await response.json()).toEqual({code:'native_helper_provider_failed'});expect(phases.at(-1)).toBe('native.helper.settled');expect(phases).toContain('provider settled');
 const missing=await handler(request());expect(missing.status).toBe(503);
});
test('revoked controller blocks helper provider effects before admission and closes its private settlement handle',async()=>{
 let current=true,calls=0,settled=0;
 const handler=createControllerHelperText({isCurrent:()=>current,rename:async()=>{},rpc:async method=>{if(method==='native.helper.assert')current=false;if(method==='native.helper.settled')settled++;},generate:async(_input,_permit,_signal,recheck)=>{await recheck();calls++;return {text:'forbidden'};}});
 const req=request(),response=await runWithRequestPermit(req.headers,()=>handler(req));expect(response.status).toBe(503);expect(calls).toBe(0);expect(settled).toBe(1);
});
