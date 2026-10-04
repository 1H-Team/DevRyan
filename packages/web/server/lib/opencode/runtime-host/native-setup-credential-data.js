const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Data-only projection matching the pinned SDK's legacy credential mapping. */
export function projectNativeSetupCredentials(auth){
 if(!record(auth)||Object.keys(auth).length>128||Buffer.byteLength(JSON.stringify(auth))>1024*1024)throw fail('native_setup_credentials_invalid');
 const credentials=[];
 for(const [rawID,input] of Object.entries(auth)){
  const integrationID=rawID.replace(/\/+$/,'');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(integrationID)||!record(input))throw fail('native_setup_credentials_invalid');
  let value;
  if(input.type==='api'&&typeof input.key==='string'&&input.key) value={type:'key',key:input.key,...record(input.metadata)?{metadata:input.metadata}:{}};
  else if(input.type==='wellknown'&&typeof input.token==='string'&&input.token)value={type:'key',key:input.token};
  else if(input.type==='oauth'&&typeof input.access==='string'&&typeof input.refresh==='string'&&Number.isSafeInteger(input.expires)){
   // Same compatibility mapping as the pinned SDK's legacy credential migration.
   const methodID=integrationID==='openai'?'chatgpt-browser':['github-copilot','opencode','xai'].includes(integrationID)?'device':'oauth';
   const metadata={...typeof input.accountId==='string'?{accountID:input.accountId}:{},...typeof input.enterpriseUrl==='string'?{enterpriseUrl:input.enterpriseUrl}:{}};
   value={type:'oauth',methodID,access:input.access,refresh:input.refresh,expires:input.expires,...Object.keys(metadata).length?{metadata}:{}};
  }else throw fail('native_setup_credentials_invalid');
  if(credentials.some(item=>item.integrationID===integrationID))throw fail('native_setup_credentials_invalid');
  credentials.push({integrationID,value,label:value.type==='oauth'?'OAuth':'API key'});
 }
 return {schema:1,credentials};
}
