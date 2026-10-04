import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes} from 'node:crypto';
import {credentialMutationFingerprint as fingerprint} from './native-credential-mutation-owner.js';
const fail=code=>Object.assign(new Error(code),{code,status:403,statusCode:403});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=['controllerInstanceID','directory','sessionID','userMessageID','assistantMessageID','agent','modelID','variant'];

/** Private external-Cursor scope. The existing owner still runs and publishes its process. */
export function createNativeCursorOwner({instanceID,admissionOwner,runtime,controller,isReady,abortAndWait,onStarted,recovery}){
 const context=new AsyncLocalStorage(),grants=new Map(),records=new Map(),settlements=new Map(),keyReads=new Map();let closing=false,closePromise;
 const readOnlyContext=new AsyncLocalStorage(),readOnlyKeys=new Map(),readOnlyGrants=new Set();
 const live=()=>{if(closing||!isReady()||controller().instanceID!==instanceID)throw fail('native_cursor_owner_expired');};
 const current=()=>{live();const grant=context.getStore();if(!grant||grant.closed||grants.get(grant.scope.sessionID)!==grant)throw fail('native_cursor_grant_required');return grant;};
 const check=async grant=>{
  live();if(grant.closed||grants.get(grant.scope.sessionID)!==grant)throw fail('native_cursor_grant_expired');
  await grant.recheck();live();
  if(grant.execution){
   const lease=await runtime.leaseForCall({directory:grant.scope.directory,sessionID:grant.scope.sessionID,callID:`cursor_${grant.scope.assistantMessageID}`});
   const captured=await runtime.capturedSessionState(grant.scope);
   if(!lease||lease.token!==grant.execution.lease.token||lease.executionKind!=='process'||lease.preparation==='none'
    ||lease.scope.userMessageID!==grant.scope.userMessageID||lease.scope.messageID!==grant.scope.assistantMessageID
    ||!captured.captured||captured.pending||captured.generation!==lease.generation)throw fail('native_cursor_lease_invalid');
  }
  await grant.recheck();live();
 };
 const assertRecord=async input=>{
  live();if(!object(input)||Object.keys(input).some(key=>![...fields,'permit','recordFingerprint'].includes(key)))throw fail('native_cursor_record_invalid');
  const entry=records.get(input.permit?.token);
  if(!entry||fingerprint(input.permit)!==fingerprint(entry.payload.permit)||input.recordFingerprint!==entry.fingerprint
    ||fields.some(field=>input[field]!==entry.payload[field]))throw fail('native_cursor_record_scope_invalid');
  await check(entry.grant);return null;
 };
 const assertSettlement=async input=>{
  if(!object(input)||Object.keys(input).some(key=>![...fields,'permit'].includes(key)))throw fail('native_cursor_settlement_invalid');
  const entry=settlements.get(input.permit?.token);
  if(!entry||controller().instanceID!==instanceID||fingerprint(input)!==fingerprint(entry))throw fail('native_cursor_settlement_invalid');return null;
 };
 const assertKey=async input=>{
  const entry=keyReads.get(input?.permit?.token);
  if(!entry||fingerprint(input)!==fingerprint(entry.input))throw fail('native_cursor_key_scope_invalid');
  await check(entry.grant);return null;
 };
 const readKey=async grant=>{
  await check(grant);
  const input={...grant.scope,permit:{token:randomBytes(32).toString('hex'),sessionID:grant.scope.sessionID,revision:grant.revision}};
  keyReads.set(input.permit.token,{grant,input});
  try{
   const value=await controller().call({action:'cursor-key-owned',...input});
   await check(grant);
   if(!object(value)||Object.keys(value).some(key=>!['key','credentialID','expectedFingerprint'].includes(key))
    ||typeof value.key!=='string'||!value.key||value.key.length>16384||typeof value.credentialID!=='string'||!value.credentialID
    ||typeof value.expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedFingerprint))throw fail('native_cursor_key_invalid');
   return value;
  }finally{keyReads.delete(input.permit.token);}
 };
 const readOnly=()=>{live();const grant=readOnlyContext.getStore();if(!grant||grant.closed)throw fail('native_cursor_readonly_scope_required');return grant;};
 const assertReadOnlyKey=async input=>{
  live();const entry=readOnlyKeys.get(input?.permit?.token);
  if(!entry||entry.grant.closed||fingerprint(input)!==fingerprint(entry.input))throw fail('native_cursor_readonly_scope_required');
  await entry.grant.recheck();live();return null;
 };
 const readReadOnlyKey=async grant=>{
  await grant.recheck();live();
  const input={...grant.scope,controllerInstanceID:instanceID,permit:{token:randomBytes(32).toString('hex'),revision:grant.revision}};
  readOnlyKeys.set(input.permit.token,{grant,input});
  try{
   const result=await controller().call({action:'cursor-readonly-key-owned',...input});
   await assertReadOnlyKey(input);
   if(!object(result)||typeof result.key!=='string'||!result.key||result.key.length>16384
    ||typeof result.credentialID!=='string'||!result.credentialID||!/^[a-f0-9]{64}$/.test(result.expectedFingerprint))throw fail('native_cursor_key_invalid');
   return result;
  }finally{readOnlyKeys.delete(input.permit.token);}
 };
 const beforeReadOnlyExecution=async()=>{
  const grant=readOnly(),selected=await readReadOnlyKey(grant);
  if(grant.keyBinding&&(selected.credentialID!==grant.keyBinding.credentialID||selected.expectedFingerprint!==grant.keyBinding.expectedFingerprint))
   throw fail('native_cursor_credential_changed');
  return grant;
 };
 const settleReadOnly=async grant=>{
  await Promise.allSettled([...grant.starting]);
  const handles=[...grant.handles];
  const cancellations=await Promise.allSettled(handles.filter(entry=>!entry.settled).map(entry=>{
   entry.cancellation??=Promise.resolve().then(()=>entry.handle.cancel());return entry.cancellation;
  }));
  const results=await Promise.allSettled(handles.map(entry=>entry.receipt));
  const errors=[...cancellations,...results].filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw Object.assign(new AggregateError(errors,'native_cursor_readonly_settlement_failed'),{nativeProcessUnsettled:true});
 };
 const finish=async grant=>{
  if(grant.finish)return grant.finish;
  grant.finish=(async()=>{
   await Promise.allSettled([...grant.work]);
   if(grant.startError?.nativeProcessUnsettled)throw grant.startError;
   if(grant.execution){
    const outcome=await grant.settlement,lease=await runtime.leaseForCall({directory:grant.scope.directory,sessionID:grant.scope.sessionID,callID:`cursor_${grant.scope.assistantMessageID}`});
    if(!lease||lease.token!==grant.execution.lease.token||!['published','cancelled'].includes(lease.state)
      ||lease.state==='cancelled'&&!outcome.ok&&!['execution_cancelled','execution_reverted'].includes(outcome.error?.code))
      throw Object.assign(fail('native_cursor_termination_unconfirmed'),{nativeProcessUnsettled:true});
   }
   let target;try{target=controller();}catch{return;}
   if(target.instanceID!==instanceID)throw fail('native_cursor_owner_expired');
   const input={...grant.scope,permit:{token:randomBytes(32).toString('hex'),sessionID:grant.scope.sessionID,revision:grant.revision}};
   settlements.set(input.permit.token,input);
   try{await target.call({action:'cursor-settle-owned',...input});await recovery?.complete(grant.scope);}
   catch(error){if(!target.hasExited?.())throw error;}
   finally{settlements.delete(input.permit.token);}
  })();
  try{await grant.finish;grant.done.resolve();}catch(error){grant.done.reject(error);throw error;}
  finally{grant.closed=true;if(grants.get(grant.scope.sessionID)===grant)grants.delete(grant.scope.sessionID);}
 };
 return {
  async ownedPrompt(scope){
   live();if(!object(scope)||Object.keys(scope).some(key=>!fields.includes(key))||grants.has(scope.sessionID)||grants.size>=128)throw fail('native_cursor_scope_invalid');
   const captured=await admissionOwner.captureCursorAuthorization(scope);live();
   if(grants.has(scope.sessionID)||grants.size>=128)throw fail('native_cursor_scope_invalid');
   const done=Promise.withResolvers(),grant={...captured,scope:Object.freeze({...scope,controllerInstanceID:instanceID}),done,work:new Set(),closed:false,ran:false};void done.promise.catch(()=>{});
   grants.set(scope.sessionID,grant);
   try{await recovery?.stage({scope:grant.scope,revision:grant.revision});}
   catch(error){grants.delete(scope.sessionID);throw error;}
   return {run:async action=>{if(grant.ran)throw fail('native_cursor_scope_used');grant.ran=true;return context.run(grant,action);},
    close:()=>finish(grant)};
  },
  async withExecution(input,action){
   const grant=current(),scope=grant.scope;
   if(input.directory!==scope.directory||input.sessionID!==scope.sessionID||input.messageID!==scope.userMessageID
     ||input.assistantMessageID!==scope.assistantMessageID||grant.started)throw fail('native_cursor_execution_scope_invalid');
   await check(grant);grant.started=Promise.withResolvers();void grant.started.promise.catch(()=>{});
   let handle;
   try{
    if(grant.keyBinding){const selected=await readKey(grant);
     if(selected.credentialID!==grant.keyBinding.credentialID||selected.expectedFingerprint!==grant.keyBinding.expectedFingerprint)
      throw fail('native_cursor_credential_changed');}
    await recovery?.starting(scope);
    handle=await action();const lease=handle?.lease;
    if(!lease||lease.scope.sessionID!==scope.sessionID||lease.scope.userMessageID!==scope.userMessageID
      ||lease.scope.messageID!==scope.assistantMessageID||lease.scope.callID!==`cursor_${scope.assistantMessageID}`)throw fail('native_cursor_lease_invalid');
    grant.execution=handle;grant.settlement=Promise.resolve(handle.result).then(value=>({ok:true,value}),error=>({ok:false,error}));
    await recovery?.bind(scope,lease);
    await check(grant);grant.started.resolve();return handle;
   }catch(error){
    grant.startError=error;grant.started.reject(error);
    if(handle){
     const stopped=await Promise.allSettled([Promise.resolve().then(()=>handle.cancel?.()),handle.result]);
     if(stopped[0].status==='rejected'){
      const failure=new AggregateError([error,stopped[0].reason],'native_cursor_start_cleanup_failed');
      failure.nativeProcessUnsettled=Boolean(error.nativeProcessUnsettled||stopped[0].reason?.nativeProcessUnsettled);
      grant.startError=failure;throw failure;
     }
    }
    throw error;
   }
  },
  async persist({sessionID,directory,record}){
   const grant=current(),scope=grant.scope,info=record?.info;
   if(sessionID!==scope.sessionID||directory!==scope.directory||!object(info)||info.sessionID!==scope.sessionID
    ||!['user','assistant'].includes(info.role)||info.providerID!=='cursor-acp'||info.modelID!==scope.modelID
    ||info.agent!==scope.agent||(info.variant||'default')!==(scope.variant||'default')||!Array.isArray(record.parts)
    ||info.role==='user'&&info.id!==scope.userMessageID||info.role==='assistant'&&(info.id!==scope.assistantMessageID||info.parentID!==scope.userMessageID))throw fail('native_cursor_record_scope_invalid');
   const terminal=info.role==='assistant'&&Number.isFinite(info.time?.completed);
   if(grant.startError?.nativeProcessUnsettled)throw grant.startError;
   if(grant.started&&!grant.startError)await grant.started.promise;
   if(terminal&&grant.settlement)await grant.settlement;
   if(!grant.execution&&info.role==='assistant'&&(record.parts.length||terminal&&!info.error))throw fail('native_cursor_process_required');
   await check(grant);
   if(terminal&&grant.execution){
    const lease=await runtime.leaseForCall({directory,sessionID,callID:`cursor_${scope.assistantMessageID}`});
    if(!['published','cancelled'].includes(lease?.state))throw fail('native_cursor_settlement_required');
   }
   const permit={token:randomBytes(32).toString('hex'),sessionID,revision:grant.revision};
   const payload={...scope,accepted:grant.accepted,record:structuredClone(record),permit};
   const entry={grant,payload,fingerprint:fingerprint(payload.record)};records.set(permit.token,entry);
   const work=(async()=>{
    await assertRecord({...scope,permit,recordFingerprint:entry.fingerprint});
    const result=await controller().call({action:'cursor-record-owned',...payload});
    await check(grant);
    if(info.role==='assistant'&&!grant.tracked){
      if(terminal)throw fail('native_cursor_start_required');
      await onStarted(scope,()=>check(grant));grant.tracked=true;
    }
    return result;
   })();
   grant.work.add(work);
   try{return await work;}finally{records.delete(permit.token);grant.work.delete(work);}
  },
  assertRecord,
  assertKey,
  assertReadOnlyKey,
  async withReadOnly(scope,captured,action){
   live();if(!object(scope)||!['title','text','catalog','verify'].includes(scope.kind)||typeof captured.recheck!=='function')throw fail('native_cursor_readonly_scope_required');
   const grant={scope:Object.freeze({...scope}),revision:captured.revision,recheck:captured.recheck,closed:false,starting:new Set(),handles:new Set()};
   await grant.recheck();live();
   readOnlyGrants.add(grant);
   const work=readOnlyContext.run(grant,async()=>{
    try{const result=await action();await grant.recheck();live();return result;}
    finally{grant.closed=true;await settleReadOnly(grant);}
   });grant.work=work;
   try{return await work;}finally{readOnlyGrants.delete(grant);}
  },
  async beforeReadOnlyExecution(){await beforeReadOnlyExecution();},
  async withReadOnlyExecution(action){
   const grant=await beforeReadOnlyExecution();readOnly();
   const started=(async()=>{
    const handle=await action();
    if(!object(handle)||typeof handle.cancel!=='function'||!handle.result||typeof handle.result.then!=='function')throw fail('native_cursor_readonly_handle_invalid');
    const entry={handle,settled:false};grant.handles.add(entry);
    entry.receipt=handle.result.then(receipt=>{
     if(receipt?.terminated!==true||receipt?.confined!==true)throw fail('native_cursor_termination_unconfirmed');
     entry.settled=true;entry.receiptValue=receipt;return receipt;
    });void entry.receipt.catch(()=>{});
    await grant.recheck();readOnly();return handle;
   })();grant.starting.add(started);
   try{return await started;}finally{grant.starting.delete(started);}
  },
  async resolveApiKey(input){
   if(input?.kind!=='prompt'){
    const grant=readOnly();
    if(input?.kind!==grant.scope.kind||input.directory!==grant.scope.directory||(input.sessionID||undefined)!==grant.scope.sessionID)throw fail('native_cursor_readonly_scope_required');
    const selected=await readReadOnlyKey(grant);grant.keyBinding={credentialID:selected.credentialID,expectedFingerprint:selected.expectedFingerprint};return selected.key;
   }
   const grant=current();
   if(!object(input)||input.kind!=='prompt'||Object.keys(input).some(key=>!['kind',...fields].includes(key))
     ||fields.filter(field=>field!=='controllerInstanceID').some(field=>input[field]!==grant.scope[field]))throw fail('native_cursor_key_scope_invalid');
   const selected=await readKey(grant);
   grant.keyBinding={credentialID:selected.credentialID,expectedFingerprint:selected.expectedFingerprint};return selected.key;
  },
  assertSettlement,
  async recover({directory}){
   if(!recovery)return;
   await recovery.recover({directory,settle:async(scope,revision)=>{
    const target=controller();if(target.instanceID!==instanceID)throw fail('native_cursor_owner_expired');
    const input={...scope,controllerInstanceID:instanceID,permit:{token:randomBytes(32).toString('hex'),sessionID:scope.sessionID,revision}};
    settlements.set(input.permit.token,input);
    try{await target.call({action:'cursor-settle-owned',...input});}finally{settlements.delete(input.permit.token);}
   }});
  },
  close(){
   if(closePromise)return closePromise;closing=true;
   closePromise=(async()=>{
   const active=[...grants.values()];
   const stopped=await Promise.allSettled(active.map(grant=>abortAndWait(grant.scope.sessionID)));
   const readonly=[...readOnlyGrants];
   const readOnlyStopped=await Promise.allSettled(readonly.map(settleReadOnly));
   const finished=await Promise.allSettled(active.map(grant=>grant.done.promise));
   const readOnlyFinished=await Promise.allSettled(readonly.map(grant=>grant.work));records.clear();keyReads.clear();readOnlyKeys.clear();
   const readonlyFailures=readOnlyFinished.filter((result,index)=>result.status==='rejected'&&!(
    ['execution_cancelled','native_cursor_owner_expired'].includes(result.reason?.code)
    &&readonly[index].handles.size>0&&[...readonly[index].handles].every(entry=>entry.settled&&entry.receiptValue.cancelled===true)));
   const failures=[...stopped,...readOnlyStopped,...finished,...readonlyFailures].filter(result=>result.status==='rejected').map(result=>result.reason);
   if(failures.length)throw new AggregateError(failures,'native_cursor_cleanup_failed');
   })();return closePromise;
  },
 };
}
