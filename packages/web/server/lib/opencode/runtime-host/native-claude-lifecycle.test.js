import {describe,it,expect} from 'vitest';
import {CLAUDE_LIFECYCLE_LIMITS,emptyClaudeLifecycle,parseClaudeLifecycle,parseClaudeLifecycleOperation,transitionClaudeLifecycle,claudeRecordFingerprint,claudeGrantFingerprint,hasLegacyClaudeFence} from './native-claude-lifecycle.js';
import {createNativeClaudeLifecycleClient} from './native-claude-lifecycle-client.js';
import {parseNativeCommand} from './native-process-protocol.js';

const digest=index=>index.toString(16).padStart(64,'0');
const account=(index=1)=>({profileID:'p'+index,service:'Claude Code-credentials-'+index.toString(16).padStart(8,'0'),configDirectory:'/owned/enrolled/'+index,
 enrollmentID:'enrollment-'+index,generation:'generation-'+index,grantFingerprint:digest(index),recordFingerprint:digest(index+1000)});
const binding=({profileID,service,configDirectory,enrollmentID,generation})=>({profileID,service,configDirectory,enrollmentID,generation});
const next=(state,operation)=>transitionClaudeLifecycle(state,state.revision,operation);

describe('Claude lifecycle contract',()=>{
 it('reserves fresh enrollment without renewal authority and settles only its exact prepared record',()=>{
  const selected=account();let state=next(emptyClaudeLifecycle(),{kind:'prepare-enrollment',account:selected,attemptID:'fresh'});
  expect(state.accounts).toEqual([]);expect(state.unresolved[0].phase).toBe('enrollment-prepared');
  expect(()=>next(state,{kind:'enroll',account:selected})).toThrow('native_claude_enrollment_conflict');
  expect(()=>next(state,{kind:'begin',account:selected,attemptID:'renew'})).toThrow('native_claude_refresh_unsettled');
  expect(()=>next(state,{kind:'settle-enrollment',binding:binding(selected),attemptID:'fresh',recordFingerprint:digest(999)})).toThrow('native_claude_lifecycle_conflict');
  expect(()=>next(state,{kind:'cancel-before-dispatch',binding:binding(selected),attemptID:'fresh'})).toThrow('native_claude_lifecycle_conflict');
  state=next(state,{kind:'settle-enrollment',binding:binding(selected),attemptID:'fresh',recordFingerprint:selected.recordFingerprint});
  expect(state.accounts).toEqual([selected]);expect(state.unresolved).toEqual([]);
 });
 it('never admits a new account that cannot hold its complete renewal intent at the byte ceiling',()=>{
  let state=emptyClaudeLifecycle(),accepted=0;
  for(let index=1;index<100;index++){
   const selected={...account(index),configDirectory:'/owned/'+String(index)+'/'+ 'x'.repeat(450)};
   let enrolled;try{enrolled=next(state,{kind:'enroll',account:selected});}catch(error){expect(error.code).toBe('native_claude_lifecycle_capacity');break;}
   accepted++;const begun=next(enrolled,{kind:'begin',account:selected,attemptID:'0'.repeat(36)});
   const prepared=next(begun,{kind:'prepare',binding:binding(selected),attemptID:'0'.repeat(36),recordFingerprint:digest(index+10000),grantFingerprint:digest(index+20000)});
   expect(Buffer.byteLength(JSON.stringify(prepared))).toBeLessThanOrEqual(CLAUDE_LIFECYCLE_LIMITS.bytes);
   state=next(enrolled,{kind:'begin',account:selected,attemptID:'attempt-'+index});
  }
  expect(accepted).toBeGreaterThan(1);expect(accepted).toBeLessThan(64);
 });
 it('canonicalizes parsed JSON and separates refresh-grant identity from record edits and aliases',()=>{
  expect(claudeRecordFingerprint({z:[{b:2,a:1}],a:3})).toBe(claudeRecordFingerprint(JSON.parse('{"a":3,"z":[{"a":1,"b":2}]}')));
  expect(claudeGrantFingerprint('synthetic')).toBe(claudeGrantFingerprint('synthetic'));
  expect(claudeGrantFingerprint('synthetic')).not.toBe(claudeRecordFingerprint({refreshToken:'synthetic'}));
  for(const value of [{bad:undefined},{bad:NaN},new Date(),{bad:()=>{}}])expect(()=>claudeRecordFingerprint(value)).toThrow('native_claude_record_invalid');
 });
 it('persists enrollment and the exact prepared replacement before permitting settlement',()=>{
  const original=account();let state=next(emptyClaudeLifecycle(),{kind:'enroll',account:original});
  const begin={kind:'begin',account:original,attemptID:'attempt-1'};state=next(state,begin);
  expect(state.unresolved[0].phase).toBe('in-flight');
  expect(()=>next(state,{kind:'settle',binding:binding(original),attemptID:'attempt-1',recordFingerprint:digest(20)})).toThrow();
  state=next(state,{kind:'prepare',binding:binding(original),attemptID:'attempt-1',recordFingerprint:digest(20),grantFingerprint:digest(21)});
  expect(()=>next(state,{kind:'cancel-before-dispatch',binding:binding(original),attemptID:'attempt-1'})).toThrow();
  expect(()=>next(state,{kind:'settle',binding:binding(original),attemptID:'attempt-1',recordFingerprint:digest(22)})).toThrow();
  const before=structuredClone(state);state=next(state,{kind:'settle',binding:binding(original),attemptID:'attempt-1',recordFingerprint:digest(20)});
  expect(state.accounts[0]).toEqual({...original,recordFingerprint:digest(20),grantFingerprint:digest(21)});
  expect(state.unresolved).toEqual([]);expect(before.unresolved[0].phase).toBe('replacement-prepared');
  expect(()=>transitionClaudeLifecycle(state,state.revision-1,{kind:'enroll',account:account(2)})).toThrow('native_claude_lifecycle_conflict');
 });
 it('never releases an ambiguous grant by changing profile, service, generation, access token or enrollment',()=>{
  const first=account();let state=next(emptyClaudeLifecycle(),{kind:'enroll',account:first});
  state=next(state,{kind:'begin',account:first,attemptID:'ambiguous'});
  expect(()=>next(state,{kind:'enroll',account:{...account(2),grantFingerprint:first.grantFingerprint}})).toThrow('native_claude_enrollment_conflict');
  const replacement={...account(3),profileID:first.profileID};state=next(state,{kind:'enroll',account:replacement});
  expect(state.unresolved[0].grantFingerprint).toBe(first.grantFingerprint);
  expect(()=>next(state,{kind:'begin',account:{...first,recordFingerprint:digest(222)},attemptID:'repeat'})).toThrow('native_claude_refresh_unsettled');
  expect(()=>next(state,{kind:'prepare',binding:binding(first),attemptID:'ambiguous',recordFingerprint:digest(30),grantFingerprint:replacement.grantFingerprint})).toThrow('native_claude_refresh_unsettled');
 });
 it('bounds unresolved entries without eviction and does not couple them to OpenAI state',()=>{
  let state=emptyClaudeLifecycle();for(let index=1;index<=CLAUDE_LIFECYCLE_LIMITS.unresolved;index++)state=next(state,{kind:'block-legacy',account:account(index),attemptID:'legacy-'+index});
  const before=structuredClone(state);expect(()=>next(state,{kind:'block-legacy',account:account(129),attemptID:'overflow'})).toThrow('native_claude_lifecycle_capacity');
  expect(state).toEqual(before);expect(state.unresolved).toHaveLength(128);expect(JSON.stringify(state)).not.toContain('openai');
 });
 it('rejects extra fields, secrets, malformed phases, duplicate authority and changed legacy fences',()=>{
  const first=account(),state=next(emptyClaudeLifecycle(),{kind:'enroll',account:first});
  for(const value of [{...state,secret:'forbidden'},{...state,accounts:[first,first]},{...state,revision:-1},{...state,accounts:[{...first,configDirectory:'/owned/../foreign'}]}])expect(()=>parseClaudeLifecycle(value)).toThrow();
  for(const value of [{kind:'enroll',account:{...first,refreshToken:'forbidden'}},{kind:'delete',attemptID:'x'},{kind:'prepare',binding:binding(first),attemptID:'x',recordFingerprint:digest(1)}])expect(()=>parseClaudeLifecycleOperation(value)).toThrow();
  const original={claudeAiOauth:{accessToken:'synthetic',refreshToken:'synthetic-refresh',expiresAt:1000}};
  const marked={...original,devryanRefreshBlock:{protocol:'devryan.claude-refresh-block/1',generation:claudeRecordFingerprint(original)}};
  expect(hasLegacyClaudeFence(marked)).toBe(true);expect(hasLegacyClaudeFence(original)).toBe(false);
  expect(()=>hasLegacyClaudeFence({...marked,claudeAiOauth:{...original.claudeAiOauth,accessToken:'changed'}})).toThrow();
  expect(()=>hasLegacyClaudeFence({...marked,devryanRefreshBlock:{protocol:'other',generation:digest(1)}})).toThrow();
 });
 it('strict private commands carry only typed operations and reject foreign controllers after suspension',async()=>{
  const operation={kind:'enroll',account:account()};const wire={protocol:1,id:'call',action:'claude-lifecycle-transition-owned',controllerInstanceID:'controller-1',expectedRevision:0,operation};
  expect(parseNativeCommand(wire)).toEqual(wire);
  for(const value of [{...wire,expectedRevision:-1},{...wire,operation:{...operation,token:'forbidden'}},{...wire,path:'/arbitrary'}])expect(()=>parseNativeCommand(value)).toThrow('Invalid native process protocol');
  let current;const original={instanceID:'controller-1',call:async()=>{current={...original,instanceID:'controller-2'};return emptyClaudeLifecycle();}};current=original;
  const client=createNativeClaudeLifecycleClient({controller:()=>current,isCurrent:()=>true});await expect(client.read()).rejects.toThrow('native_claude_lifecycle_owner_expired');
 });
});
