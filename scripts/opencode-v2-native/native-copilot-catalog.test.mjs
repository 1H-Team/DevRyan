import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createNativeCopilotCatalog} from '../../packages/web/server/lib/opencode/runtime-host/native-copilot-catalog.js';
import {credentialMutationFingerprint as fingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
const directory='/owned/project',instanceID='a'.repeat(32),origin={kind:'plugin',id:'devryan.provider-compat',manifestDigest:'b'.repeat(64),capabilities:['provider']};
const configuration={providers:{'github-copilot':{models:{}}}};
const binding={directory,controllerInstanceID:instanceID,integrationID:'github-copilot',acquisitionID:'actual-acquisition',configurationDigest:fingerprint(configuration.providers['github-copilot']),origin:{id:origin.id,manifestDigest:origin.manifestDigest}};
const fixture=(fetchImpl)=>{
  let selected={...binding,credential:{id:'cred_owned',integrationID:'github-copilot',value:{type:'oauth',methodID:'device',refresh:'synthetic-owned-github-token',access:'',expires:0}}};let chain=Promise.resolve(),reads=0;
  const owner=createNativeCopilotCatalog({instanceID,snapshot:{locations:[{directory,configuration}]},registrationOrigin:origin,isReady:()=>true,controller:()=>({instanceID,async call(input){assert.equal(input.action,'provider-catalog-selection-owned');reads++;return structuredClone(selected);}}),withMutationQueue:action=>{const work=chain.then(action);chain=work.catch(()=>{});return work;},fetchImpl});
  const catalog=input=>owner.handleRpc('provider.catalog',input);
  return {owner,catalog,select:value=>{selected=value;},selected:()=>structuredClone(selected),reads:()=>reads};
};
test('constructor-owned catalog fetch preserves original official URL/headers and same selected credential',async()=>{
  const received=[];const server=http.createServer((request,response)=>{received.push({url:request.url,authorization:request.headers.authorization,version:request.headers['x-github-api-version']});response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'gpt-4o-mini',model_picker_enabled:false}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.notEqual(typeof address,'string');
  const owned=fixture((url,options)=>{assert.equal(url,'https://api.githubcopilot.com/models');assert.equal(options.redirect,'error');return fetch(`http://127.0.0.1:${address.port}/models`,options);});
  try{assert.deepEqual(await owned.catalog(binding),[{id:'gpt-4o-mini',model_picker_enabled:false}]);assert.equal(owned.reads(),2);assert.deepEqual(received,[{url:'/models',authorization:'Bearer synthetic-owned-github-token',version:'2026-06-01'}]);
    await assert.rejects(owned.catalog({...binding,origin:{...binding.origin,manifestDigest:'c'.repeat(64)}}),/native_provider_catalog_binding_invalid/);assert.equal(received.length,1);
  }finally{await owned.owner.close();await new Promise(resolve=>server.close(resolve));}
});
test('catalog refuses account changes, original acquisition changes, expired access-only and owner invalidation',async()=>{
  const owned=fixture(async()=>{const next=owned.selected();next.credential.id='cred_other';owned.select(next);return Response.json({data:[]});});
  await assert.rejects(owned.catalog(binding),/native_provider_catalog_selection_changed/);await owned.owner.close();
  await assert.rejects(owned.catalog(binding),/native_provider_owner_expired/);
  const stale=fixture(async()=>{throw new Error('must not fetch');});const selected=stale.selected();selected.acquisitionID='old-acquisition';stale.select(selected);
  await assert.rejects(stale.catalog(binding),/native_provider_catalog_selection_invalid/);await stale.owner.close();
  const expired=fixture(async()=>{throw new Error('must not fetch');});const value=expired.selected();value.credential.value.refresh='';value.credential.value.access='synthetic-expired';value.credential.value.expires=1;expired.select(value);
  await assert.rejects(expired.catalog(binding),/native_copilot_refresh_required/);await expired.owner.close();
});
test('catalog stays in the shared queue through actual fetch settlement and queued work cannot run after close',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});let fetched=0;
  const owned=fixture(async()=>{fetched++;await blocked;return Response.json({data:[]});});
  const first=owned.catalog(binding);const firstRejected=assert.rejects(first,/native_provider_owner_expired/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(fetched,1);
  const second=owned.catalog(binding);const secondRejected=assert.rejects(second,/native_provider_owner_expired/);
  const closed=owned.owner.close();release();await closed;await Promise.all([firstRejected,secondRejected]);assert.equal(fetched,1);
});
test('the catalog owner answers only provider.catalog; the retired Meridian RPCs are refused',()=>{
  const owned=fixture(async()=>{throw new Error('must not fetch');});
  for(const method of ['provider.meridian.begin','provider.meridian.assert','provider.meridian.end','provider.claude.usage'])assert.throws(()=>owned.owner.handleRpc(method,binding),/native_provider_operation_invalid/);
  assert.equal(owned.reads(),0);
});
