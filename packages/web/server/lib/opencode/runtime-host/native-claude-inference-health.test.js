import {expect,test} from 'vitest';
import {createClaudeInferenceHealth} from './native-claude-inference-health.js';
test('process failure is separate from saved credentials and only canonical token-bearing success clears it',()=>{
 const health=createClaudeInferenceHealth({directories:['/fixture'],now:()=>2000}),scope={directory:'/fixture',sessionID:'ses_one'};
 health.process({...scope,type:'claude-process-diagnostic',receipt:{code:125,transportError:'native_claude_transport_identity_failed',clues:['spawn']}});
 expect(health.status('/fixture')).toEqual({lastSuccessfulInferenceAt:null,lastLaunchFailure:{at:2000,code:'native_claude_transport_identity_failed'}});
 const info={sessionID:'ses_one',role:'assistant',providerID:'anthropic',time:{completed:2000},tokens:{input:1,output:1}};
 for(const changed of [{...info,providerID:'openai'},{...info,sessionID:'ses_other'},{...info,tokens:{input:0,output:0}},{...info,time:{completed:3000}}])health.result(scope,{info:changed});
 expect(health.status('/fixture').lastSuccessfulInferenceAt).toBeNull();
 health.result(scope,{info});expect(health.status('/fixture')).toEqual({lastSuccessfulInferenceAt:2000,lastLaunchFailure:null});
});
test('specific launch diagnostics survive generic internal errors and auth errors remain explicit',()=>{
 const health=createClaudeInferenceHealth({directories:['/fixture'],now:()=>2000}),scope={directory:'/fixture',sessionID:'ses_one'};
 health.process({...scope,type:'claude-process-diagnostic',receipt:{code:1,clues:['permission']}});
 const info={sessionID:'ses_one',role:'assistant',providerID:'anthropic',time:{completed:2000},error:{data:{v2Type:'provider.internal'}}};
 health.result(scope,{info});expect(health.status('/fixture').lastLaunchFailure.code).toBe('claude_process_permission');
 health.result(scope,{info:{...info,error:{data:{v2Type:'provider.auth'}}}});expect(health.status('/fixture').lastLaunchFailure.code).toBe('provider_authentication');
 expect(JSON.stringify(health.status('/fixture'))).not.toMatch(/session|prompt|credential/);
});
