import path from 'node:path';
const fail=()=>Object.assign(new Error('native_provider_protocol_invalid'),{code:'native_provider_protocol_invalid',status:400});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>{if(!record(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail();};
const text=(value,max=8192)=>{if(typeof value!=='string'||!value||value.length>max||value.includes('\0'))throw fail();return value;};
const bounded=(value,max)=>{if(Buffer.byteLength(JSON.stringify(value)??'')>max)throw fail();};
export function parseProviderBoot(value){
  bounded(value,4*1024*1024);keys(value,['protocol','type','provider','instanceID','buildId','globals','profiles','defaultProfile','assets','transport','requestAuthorization']);
  if(value.protocol!==1||value.type!=='provider-boot'||value.provider!=='anthropic'||!/^[a-f0-9-]{32,64}$/.test(text(value.instanceID))||!/^[a-f0-9]{64}$/.test(text(value.buildId)))throw fail();
  if(typeof value.requestAuthorization!=='string'||!/^([a-f0-9]{64})$/.test(value.requestAuthorization))throw fail();
  const globals=['home','config','data','state','cache','bin','log','repos','tmp'];keys(value.globals,globals);
  for(const key of globals)if(!path.isAbsolute(text(value.globals[key])))throw fail();
  keys(value.assets,['claude','libsql']);for(const name of ['claude','libsql']){keys(value.assets[name],['path','sha256']);if(!path.isAbsolute(text(value.assets[name].path))||!/^[a-f0-9]{64}$/.test(text(value.assets[name].sha256)))throw fail();}
  keys(value.transport,['launcher','storage','directories']);if(!path.isAbsolute(text(value.transport.launcher))||!path.isAbsolute(text(value.transport.storage))||!Array.isArray(value.transport.directories)||!value.transport.directories.length||value.transport.directories.length>128||value.transport.directories.some(directory=>!path.isAbsolute(text(directory))))throw fail();
  if(!Array.isArray(value.profiles)||value.profiles.length>64)throw fail();const ids=new Set();
  for(const profile of value.profiles){
    keys(profile,['id','type','claudeConfigDir','keychainService','apiKey','baseUrl','oauthToken','credentialPolicy']);text(profile.id,256);
    if(ids.has(profile.id))throw fail();ids.add(profile.id);
    if(profile.type!==undefined&&!['claude-max','api','oauth-token'].includes(profile.type))throw fail();
    if(profile.credentialPolicy!==undefined&&(profile.credentialPolicy!=='access-only'||profile.type!=='oauth-token'))throw fail();
    if(profile.keychainService!==undefined&&!(typeof profile.keychainService==='string'&&/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(profile.keychainService)))throw fail();
    if(profile.claudeConfigDir!==undefined&&!path.isAbsolute(text(profile.claudeConfigDir)))throw fail();
    for(const key of ['apiKey','oauthToken'])if(profile[key]!==undefined)text(profile[key],1024*1024);
    if(profile.baseUrl!==undefined){const url=new URL(text(profile.baseUrl));if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw fail();}
  }
  // The original loader preserves an explicit default with an empty profile
  // list; Meridian resolves its own implicit profiles in that case.
  if(value.defaultProfile!==undefined&&value.profiles.length>0&&!ids.has(text(value.defaultProfile,256)))throw fail();
  if(value.defaultProfile!==undefined)text(value.defaultProfile,256);
  return structuredClone(value);
}
export function parseProviderCommand(value){
  if(value?.action==='credential-reply')return parseProviderCredentialReply(value);
  bounded(value,65536);keys(value,['protocol','id','action','attemptID','sessionID','directory']);
  if(value.protocol!==1||!['health','close','authorize-attempt','release-attempt'].includes(value.action))throw fail();text(value.id,128);
  if(['authorize-attempt','release-attempt'].includes(value.action)){if(!/^[a-f0-9]{64}$/.test(text(value.attemptID))||!/^ses[0-9A-Za-z_-]{1,128}$/.test(text(value.sessionID))||!path.isAbsolute(text(value.directory)))throw fail();}else if(value.attemptID!==undefined||value.sessionID!==undefined||value.directory!==undefined)throw fail();return value;
}
export const NATIVE_CLAUDE_CREDENTIAL_ERRORS=Object.freeze(['native_provider_attempt_expired','native_provider_owner_expired','native_claude_profile_unreviewed','native_claude_credential_owner_required','native_claude_credentials_unverified','native_claude_account_changed','native_claude_persistence_failed','native_claude_refresh_unsettled','native_claude_refresh_failed','native_claude_retry_exhausted','claude_credentials_missing','claude_credentials_expired','claude_credentials_unreadable','native_claude_credential_failed']);
export function parseProviderCredentialRequest(value){
 bounded(value,4096);keys(value,['protocol','type','id','attemptID','sessionID','directory','profileID','purpose','failedFingerprint']);
 if(value.protocol!==1||value.type!=='credential-request'||!['request','authentication-retry'].includes(value.purpose)||!/^[a-f0-9]{64}$/.test(text(value.attemptID))||!/^ses[0-9A-Za-z_-]{1,128}$/.test(text(value.sessionID))||!path.isAbsolute(text(value.directory)))throw fail();
 text(value.id,128);text(value.profileID,256);
 if(value.purpose==='authentication-retry'?!/^[a-f0-9]{64}$/.test(value.failedFingerprint??''):value.failedFingerprint!==undefined)throw fail();
 return value;
}
export function parseProviderCredentialResult(value){
 bounded(value,65536);keys(value,['profileID','accessToken','expiresAt','fingerprint']);text(value.profileID,256);text(value.accessToken,60000);
 if(!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0||!/^[a-f0-9]{64}$/.test(value.fingerprint??''))throw fail();return value;
}
export function parseProviderCredentialReply(value){
 bounded(value,65536);keys(value,['protocol','id','action','ok','result','error']);text(value.id,128);
 if(value.protocol!==1||value.action!=='credential-reply'||typeof value.ok!=='boolean')throw fail();
 if(value.ok){if(value.error!==undefined)throw fail();parseProviderCredentialResult(value.result);}else{
  if(value.result!==undefined)throw fail();keys(value.error,['code']);if(!NATIVE_CLAUDE_CREDENTIAL_ERRORS.includes(value.error.code))throw fail();
 }
 return value;
}
export function parseProviderBound(value){
  bounded(value,65536);keys(value,['protocol','type','instanceID','buildId','url','port','health']);
  if(value.protocol!==1||value.type!=='provider-bound'||!/^[a-f0-9-]{32,64}$/.test(text(value.instanceID))||!/^[a-f0-9]{64}$/.test(text(value.buildId))||!['healthy','degraded'].includes(value.health))throw fail();
  const url=new URL(text(value.url));if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||Number(url.port)!==value.port||!Number.isSafeInteger(value.port)||value.port<1||value.port>65535)throw fail();return value;
}
