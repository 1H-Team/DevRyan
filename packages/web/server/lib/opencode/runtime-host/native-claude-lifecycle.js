import {createHash} from 'node:crypto';
import path from 'node:path';

export const CLAUDE_LIFECYCLE_PROTOCOL='devryan.claude-lifecycle/1';
export const CLAUDE_LIFECYCLE_KEY=CLAUDE_LIFECYCLE_PROTOCOL;
export const CLAUDE_LIFECYCLE_LIMITS=Object.freeze({accounts:64,unresolved:128,bytes:61440});
const fail=code=>{throw Object.assign(new Error(code),{code,status:503,statusCode:503});};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,fields)=>{if(!record(value)||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key)))fail('native_claude_lifecycle_invalid');};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const bindingFields=['profileID','service','configDirectory','enrollmentID','generation'];
const accountFields=[...bindingFields,'grantFingerprint','recordFingerprint'];
const binding=value=>{if(!record(value)||['profileID','service','enrollmentID','generation'].some(key=>!text(value[key]))
 ||typeof value.configDirectory!=='string'||value.configDirectory.length>4096||/[\u0000-\u001f]/.test(value.configDirectory)||!path.isAbsolute(value.configDirectory)||path.normalize(value.configDirectory)!==value.configDirectory
 ||!/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(value.service))fail('native_claude_lifecycle_invalid');};
const account=value=>{binding(value);if(!digest(value.grantFingerprint)||!digest(value.recordFingerprint))fail('native_claude_lifecycle_invalid');};
const canonical=(value,depth=0)=>{
 if(depth>64)fail('native_claude_record_invalid');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value))return value.map(item=>canonical(item,depth+1));
 if(record(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1)]));
 return fail('native_claude_record_invalid');
};
/** Fingerprint the parsed record, never its formatting or property insertion order. */
export function claudeRecordFingerprint(value){
 if(!record(value))fail('native_claude_record_invalid');
 const bytes=JSON.stringify(canonical(value));if(Buffer.byteLength(bytes)>1024*1024)fail('native_claude_record_invalid');
 return createHash('sha256').update(bytes).digest('hex');
}
/** Independent of profile/service: the same ambiguous grant cannot enter by an alias. */
export function claudeGrantFingerprint(refreshToken){
 if(typeof refreshToken!=='string'||!refreshToken||refreshToken.length>60000)fail('claude_credentials_unreadable');
 return createHash('sha256').update('devryan.claude-refresh-grant/1\0').update(refreshToken).digest('hex');
}
export function hasLegacyClaudeFence(value){
 if(!record(value))fail('claude_credentials_unreadable');
 if(value.devryanRefreshBlock===undefined)return false;
 const marker=value.devryanRefreshBlock;
 exact(marker,['protocol','generation']);
 if(marker.protocol!=='devryan.claude-refresh-block/1'||!digest(marker.generation))fail('native_claude_legacy_fence_invalid');
 const {devryanRefreshBlock,...original}=value;void devryanRefreshBlock;
 if(claudeRecordFingerprint(original)!==marker.generation)fail('native_claude_legacy_fence_invalid');
 return true;
}
export const sameClaudeEnrollment=(left,right)=>bindingFields.every(key=>left[key]===right[key]);
export const emptyClaudeLifecycle=()=>({protocol:CLAUDE_LIFECYCLE_PROTOCOL,revision:0,accounts:[],unresolved:[]});
export function parseClaudeLifecycle(value){
 exact(value,['protocol','revision','accounts','unresolved']);
 if(value.protocol!==CLAUDE_LIFECYCLE_PROTOCOL||!Number.isSafeInteger(value.revision)||value.revision<0
  ||!Array.isArray(value.accounts)||value.accounts.length>64||!Array.isArray(value.unresolved)||value.unresolved.length>128
  ||Buffer.byteLength(JSON.stringify(value))>CLAUDE_LIFECYCLE_LIMITS.bytes)fail('native_claude_lifecycle_invalid');
 for(const row of value.accounts){exact(row,accountFields);account(row);}
 for(const row of value.unresolved){
  exact(row,[...accountFields,'attemptID','phase',...(row.phase==='replacement-prepared'?['replacementRecordFingerprint','replacementGrantFingerprint']:[])]);account(row);
  if(!text(row.attemptID)||!['in-flight','replacement-prepared','blocked'].includes(row.phase)
   ||row.phase==='replacement-prepared'&&(!digest(row.replacementRecordFingerprint)||!digest(row.replacementGrantFingerprint)))fail('native_claude_lifecycle_invalid');
 }
 for(const key of ['profileID','service','configDirectory','enrollmentID','grantFingerprint'])if(new Set(value.accounts.map(row=>row[key])).size!==value.accounts.length)fail('native_claude_lifecycle_invalid');
 for(const key of ['attemptID','grantFingerprint'])if(new Set(value.unresolved.map(row=>row[key])).size!==value.unresolved.length)fail('native_claude_lifecycle_invalid');
 for(let index=0;index<value.unresolved.length;index++){
  const left=value.unresolved[index];
  if(value.unresolved.slice(index+1).some(right=>left.replacementGrantFingerprint!==undefined&&(left.replacementGrantFingerprint===right.grantFingerprint||left.replacementGrantFingerprint===right.replacementGrantFingerprint)
   ||right.replacementGrantFingerprint===left.grantFingerprint))fail('native_claude_lifecycle_invalid');
 }
 return structuredClone(value);
}
export function parseClaudeLifecycleOperation(value){
 if(!record(value))fail('native_claude_lifecycle_invalid');
 if(value.kind==='enroll'){exact(value,['kind','account']);exact(value.account,accountFields);account(value.account);}
 else if(['begin','block-legacy'].includes(value.kind)){exact(value,['kind','account','attemptID']);exact(value.account,accountFields);account(value.account);if(!text(value.attemptID))fail('native_claude_lifecycle_invalid');}
 else if(['prepare','settle','cancel-before-dispatch'].includes(value.kind)){
  exact(value,['kind','binding','attemptID',...(value.kind==='prepare'?['recordFingerprint','grantFingerprint']:value.kind==='settle'?['recordFingerprint']:[])]);
  exact(value.binding,bindingFields);binding(value.binding);
  if(!text(value.attemptID)||value.kind!=='cancel-before-dispatch'&&!digest(value.recordFingerprint)||value.kind==='prepare'&&!digest(value.grantFingerprint))fail('native_claude_lifecycle_invalid');
 }else fail('native_claude_lifecycle_invalid');
 return structuredClone(value);
}
/** Only the host's fresh-enrollment owner issues enroll; these private operations
 * never accept credentials or confer authority from imported profile properties. */
export function transitionClaudeLifecycle(value,expectedRevision,operation){
 const state=parseClaudeLifecycle(value),action=parseClaudeLifecycleOperation(operation);
 if(state.revision!==expectedRevision||state.revision===Number.MAX_SAFE_INTEGER)fail('native_claude_lifecycle_conflict');
 const blocked=grant=>state.unresolved.some(row=>row.grantFingerprint===grant||row.replacementGrantFingerprint===grant);
 if(action.kind==='enroll'){
  const selected=action.account;
  if(blocked(selected.grantFingerprint)||state.accounts.some(row=>row.grantFingerprint===selected.grantFingerprint
   ||row.profileID!==selected.profileID&&(row.service===selected.service||row.configDirectory===selected.configDirectory||row.enrollmentID===selected.enrollmentID)))fail('native_claude_enrollment_conflict');
  const previous=state.accounts.findIndex(row=>row.profileID===selected.profileID);
  if(previous<0){if(state.accounts.length>=64)fail('native_claude_lifecycle_capacity');state.accounts.push(selected);}
  else{if(state.accounts[previous].enrollmentID===selected.enrollmentID||state.accounts[previous].generation===selected.generation)fail('native_claude_enrollment_conflict');state.accounts[previous]=selected;}
 }else if(action.kind==='begin'||action.kind==='block-legacy'){
  if(blocked(action.account.grantFingerprint)||state.unresolved.some(row=>row.attemptID===action.attemptID))fail('native_claude_refresh_unsettled');
  if(state.unresolved.length>=128)fail('native_claude_lifecycle_capacity');
  if(action.kind==='begin'&&!state.accounts.some(row=>sameClaudeEnrollment(row,action.account)&&row.grantFingerprint===action.account.grantFingerprint&&row.recordFingerprint===action.account.recordFingerprint))fail('native_claude_enrollment_required');
  state.unresolved.push({...action.account,attemptID:action.attemptID,phase:action.kind==='begin'?'in-flight':'blocked'});
 }else{
  const index=state.unresolved.findIndex(row=>row.attemptID===action.attemptID&&sameClaudeEnrollment(row,action.binding));
  if(index<0)fail('native_claude_lifecycle_conflict');const pending=state.unresolved[index];
  if(action.kind==='prepare'){
   if(pending.phase!=='in-flight'||state.unresolved.some((row,i)=>i!==index&&(row.grantFingerprint===action.grantFingerprint||row.replacementGrantFingerprint===action.grantFingerprint))
    ||state.accounts.some(row=>!sameClaudeEnrollment(row,pending)&&row.grantFingerprint===action.grantFingerprint))fail('native_claude_refresh_unsettled');
   state.unresolved[index]={...pending,phase:'replacement-prepared',replacementRecordFingerprint:action.recordFingerprint,replacementGrantFingerprint:action.grantFingerprint};
  }else if(action.kind==='settle'){
   const selected=state.accounts.findIndex(row=>sameClaudeEnrollment(row,action.binding));
   if(pending.phase!=='replacement-prepared'||pending.replacementRecordFingerprint!==action.recordFingerprint||selected<0)fail('native_claude_lifecycle_conflict');
   state.accounts[selected]={...state.accounts[selected],recordFingerprint:pending.replacementRecordFingerprint,grantFingerprint:pending.replacementGrantFingerprint};state.unresolved.splice(index,1);
  }else{
   if(pending.phase!=='in-flight')fail('native_claude_lifecycle_conflict');state.unresolved.splice(index,1);
  }
 }
 state.revision++;if(Buffer.byteLength(JSON.stringify(state))>CLAUDE_LIFECYCLE_LIMITS.bytes)fail('native_claude_lifecycle_capacity');return parseClaudeLifecycle(state);
}
