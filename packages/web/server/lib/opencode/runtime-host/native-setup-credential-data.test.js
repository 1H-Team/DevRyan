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
