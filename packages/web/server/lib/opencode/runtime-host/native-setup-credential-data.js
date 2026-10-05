const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const strings=value=>record(value)&&Object.values(value).every(item=>typeof item==='string');
// Diagnostics carry a plain integration ID only; URL-shaped (wellknown) keys may embed userinfo.
const plainID=value=>/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)?value:undefined;

/** Data-only projection matching the pinned SDK's legacy credential import
 * (20260805200742_import_legacy_credentials): trailing slashes are stripped,
 * undecodable entries, empty IDs and later duplicates are skipped. Wellknown
 * entries are skipped too: the controller seed cannot store their origins.
 * Every projected entry decodes as the controller's Credential.Value. Without
 * `onSkip` (DevRyan-owned auth files) any skipped entry fails closed. */
export function projectNativeSetupCredentials(auth,{onSkip}={}){
 if(!record(auth)||Buffer.byteLength(JSON.stringify(auth))>1024*1024)throw fail('native_setup_credentials_invalid');
 const credentials=[];
 const skip=(reason,integrationID)=>{if(!onSkip)throw fail('native_setup_credentials_invalid');onSkip({reason,...plainID(integrationID)?{integrationID:plainID(integrationID)}:{}});};
 for(const [rawID,input] of Object.entries(auth)){
  const integrationID=rawID.replace(/\/+$/,'');
  if(!integrationID){skip('credential_id_invalid');continue;}
  let value;
  if(record(input)&&input.type==='api'&&typeof input.key==='string'&&(input.metadata===undefined||strings(input.metadata)))
   value={type:'key',key:input.key,...input.metadata!==undefined?{metadata:input.metadata}:{}};
  else if(record(input)&&input.type==='wellknown'&&typeof input.key==='string'&&typeof input.token==='string'){skip('credential_wellknown_unsupported');continue;}
  else if(record(input)&&input.type==='oauth'&&typeof input.access==='string'&&typeof input.refresh==='string'&&Number.isSafeInteger(input.expires)&&input.expires>=0
   &&(input.accountId===undefined||typeof input.accountId==='string')&&(input.enterpriseUrl===undefined||typeof input.enterpriseUrl==='string')){
   // Same compatibility mapping as the pinned SDK's legacy credential migration.
   const methodID=integrationID==='openai'?'chatgpt-browser':['github-copilot','opencode','xai'].includes(integrationID)?'device':'oauth';
   const metadata={...input.accountId?{accountID:input.accountId}:{},...input.enterpriseUrl?{enterpriseUrl:input.enterpriseUrl}:{}};
   value={type:'oauth',methodID,access:input.access,refresh:input.refresh,expires:input.expires,...Object.keys(metadata).length?{metadata}:{}};
  }else{skip('credential_invalid',integrationID);continue;}
  if(credentials.some(item=>item.integrationID===integrationID)){skip('credential_duplicate',integrationID);continue;}
  if(credentials.length>=128){skip('credential_limit',integrationID);continue;}
  credentials.push({integrationID,value,label:value.type==='oauth'?'OAuth':'API key'});
 }
 return {schema:1,credentials};
}
