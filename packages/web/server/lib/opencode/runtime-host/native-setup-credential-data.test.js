import {expect,it} from 'vitest';
import {Schema} from 'effect';
import {Credential} from '@opencode/schema/credential';
import {Integration} from '@opencode/schema/integration';
import {projectNativeSetupCredentials} from './native-setup-credential-data.js';
// The controller consumer's exact seed envelope (native-setup-credentials.ts).
const Seed=Schema.Struct({schema:Schema.Literal(1),credentials:Schema.Array(Schema.Struct({
 integrationID:Integration.ID,value:Credential.Value,label:Schema.optionalKey(Schema.String),
}))});
const project=auth=>{const skipped=[];const result=projectNativeSetupCredentials(auth,{onSkip:row=>skipped.push(row)});return {result,skipped};};

it('skips what the pinned SDK legacy import skips and keeps every valid sibling',()=>{
 const {result,skipped}=project({
  openai:{type:'api',key:'fixture-key'},
  'https://user:fixture-pass@opencode.example.com/':{type:'wellknown',key:'FIXTURE_ENV',token:'fixture-wellknown-token'},
  'github-copilot/':{type:'oauth',access:'fixture-access',refresh:'fixture-refresh',expires:0,accountId:''},
  broken:{type:'oauth',access:'fixture-access',expires:1},negative:{type:'oauth',access:'a',refresh:'r',expires:-1},
  odd:{type:'mystery'},nothing:null,'/':{type:'api',key:'fixture-key'},'openai/':{type:'api',key:'fixture-second'},
  'a:b@c/d':{type:'api',key:'',metadata:{region:'eu'}},badmeta:{type:'api',key:'k',metadata:{count:1}},
 });
 expect(result.credentials.map(row=>row.integrationID)).toEqual(['openai','github-copilot','a:b@c/d']);
 expect(result.credentials[0].value).toEqual({type:'key',key:'fixture-key'});
 expect(result.credentials[1].value).toEqual({type:'oauth',methodID:'device',access:'fixture-access',refresh:'fixture-refresh',expires:0});
 expect(skipped).toEqual([{reason:'credential_wellknown_unsupported'},{reason:'credential_invalid',integrationID:'broken'},{reason:'credential_invalid',integrationID:'negative'},
  {reason:'credential_invalid',integrationID:'odd'},{reason:'credential_invalid',integrationID:'nothing'},{reason:'credential_id_invalid'},
  {reason:'credential_duplicate',integrationID:'openai'},{reason:'credential_invalid',integrationID:'badmeta'}]);
 // Diagnostics carry no values and no URL-shaped identifiers.
 expect(JSON.stringify(skipped)).not.toMatch(/fixture|example\.com/);
 // Every projected entry is one the controller accepts, so nothing can fail past selection.
 expect(()=>Schema.decodeUnknownSync(Seed)(result,{onExcessProperty:'error'})).not.toThrow();
});

it('bounds the projection to the controller row limit and keeps strict callers fail-closed',()=>{
 const auth=Object.fromEntries(Array.from({length:130},(_,index)=>['p'+index,{type:'api',key:'k'}]));
 const {result,skipped}=project(auth);expect(result.credentials).toHaveLength(128);expect(skipped.map(row=>row.reason)).toEqual(['credential_limit','credential_limit']);
 expect(()=>projectNativeSetupCredentials({'https://opencode.example.com':{type:'wellknown',key:'K',token:'t'}})).toThrow('native_setup_credentials_invalid');
 expect(()=>project([])).toThrow('native_setup_credentials_invalid');
});

it('keeps the strict (bots) acceptance set of the original projection',()=>{
 expect(projectNativeSetupCredentials({
  openai:{type:'api',key:'k',metadata:{count:1,nested:{a:true}}},plain:{type:'api',key:'k',metadata:'ignored'},
  'opencode.example':{type:'wellknown',key:'ENV',token:'fixture-token'},token:{type:'wellknown',token:'t'},
  'github-copilot/':{type:'oauth',access:'a',refresh:'r',expires:-1,accountId:7,enterpriseUrl:''},anthropic:{type:'oauth',access:'a',refresh:'',expires:0,accountId:''},
 })).toEqual({schema:1,credentials:[
  {integrationID:'openai',value:{type:'key',key:'k',metadata:{count:1,nested:{a:true}}},label:'API key'},{integrationID:'plain',value:{type:'key',key:'k'},label:'API key'},
  {integrationID:'opencode.example',value:{type:'key',key:'fixture-token'},label:'API key'},{integrationID:'token',value:{type:'key',key:'t'},label:'API key'},
  {integrationID:'github-copilot',value:{type:'oauth',methodID:'device',access:'a',refresh:'r',expires:-1,metadata:{enterpriseUrl:''}},label:'OAuth'},
  {integrationID:'anthropic',value:{type:'oauth',methodID:'oauth',access:'a',refresh:'',expires:0,metadata:{accountID:''}},label:'OAuth'},
 ]});
 for(const auth of [{x:{type:'api',key:''}},{'a:b':{type:'api',key:'k'}},{x:null},{x:{type:'wellknown',token:''}},{x:{type:'oauth',access:'a',refresh:'r',expires:1.5}},
  Object.fromEntries(Array.from({length:129},(_,index)=>['p'+index,{type:'api',key:'k'}]))])expect(()=>projectNativeSetupCredentials(auth)).toThrow('native_setup_credentials_invalid');
});
