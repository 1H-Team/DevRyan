import {buildResult} from '../../quota/utils/formatters.js';
const fail=()=>Object.assign(new Error('native_claude_quota_unavailable'),{code:'native_claude_quota_unavailable',statusCode:502});

/** Read-only OAuth usage: no CLI, inference, credential discovery or refresh. */
export async function fetchSelectedClaudeQuota({accessToken,signal,fetchImpl}){
 const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
 try{
  const response=await fetchImpl('https://api.anthropic.com/api/oauth/usage',{method:'GET',redirect:'error',signal:bounded,
   headers:{Authorization:`Bearer ${accessToken}`,'anthropic-beta':'oauth-2025-04-20'}});
  if(!response.ok){await response.body?.cancel();throw fail();}
  const reader=response.body?.getReader();if(!reader)throw fail();const chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>64*1024)throw fail();chunks.push(part.value);}}
  finally{try{await reader.cancel();}finally{reader.releaseLock();}}
  const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const {buildOAuthUsage}=await import('../../quota/providers/claude.js');
  bounded.throwIfAborted();
  const usage=buildOAuthUsage(payload);if(!usage.windows['5h']&&!usage.windows['7d'])throw fail();
  return buildResult({providerId:'claude',providerName:'Claude',ok:true,configured:true,usage,usageUpdatedAt:Date.now()});
 }catch{signal?.throwIfAborted();throw fail();}

}

export const unavailableClaudeInspection=(kind,code)=>kind==='status'
 ?{installed:code!=='native_claude_external_unavailable',path:null,loggedIn:false,authStatus:'unavailable',errorCode:code,error:'Selected Claude account is unavailable.'}
 :buildResult({providerId:'claude',providerName:'Claude',ok:false,configured:false,errorCode:code,error:'Selected Claude account is unavailable.'});
export const isClaudeInspectionUnavailable=code=>['claude_credentials_missing','claude_credentials_expired','claude_credentials_unreadable','native_claude_update_required','native_claude_account_ambiguous','native_claude_profile_unreviewed','native_claude_quota_unavailable','native_claude_refresh_unsettled','native_claude_refresh_failed','native_claude_persistence_failed','native_claude_account_changed','native_claude_external_unavailable'].includes(code);

/** The existing HTTP route grant is rechecked by the native runtime owner. */
export async function inspectClaudeRequest({req,res,kind,directory,getNativeRuntimeOwner,isExternalOpenCode}){
 if(isExternalOpenCode())throw Object.assign(new Error('native_claude_external_unavailable'),{code:'native_claude_external_unavailable',statusCode:409});
 const owner=getNativeRuntimeOwner();
 if(typeof owner?.inspectClaude!=='function')throw Object.assign(new Error('native_runtime_not_ready'),{code:'native_runtime_not_ready',statusCode:503});
 const controller=new AbortController(),abort=()=>controller.abort();
 req.once('aborted',abort);res.once('close',abort);
 try{return await owner.inspectClaude({kind,directory},{signal:controller.signal});}
 finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
}
export const sendClaudeInspectionError=(res,error)=>{
 const code=['native_runtime_not_ready','native_provider_configuration_changed','native_provider_configuration_location_unreviewed','native_provider_owner_expired','web_authorization_revoked','permission_denied','forbidden'].includes(error?.code)?error.code:'native_claude_inspection_refused';
 return res.status(error?.statusCode===403||error?.status===403?403:503).json({code,error:'Selected Claude inspection was refused.'});
};
