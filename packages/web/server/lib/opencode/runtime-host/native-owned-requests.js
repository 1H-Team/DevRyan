const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** RPC cancellation must wait for the same owned work and its real supervisor.
 * Request IDs correlate settlement; they never issue execution authority. */
export function createNativeOwnedRequests(prefix){
 const fail=suffix=>Object.assign(new Error(prefix+'_'+suffix),{code:prefix+'_'+suffix,status:403,statusCode:403});
 const requests=new Map();let closed=false;
 const identity=input=>JSON.stringify([input.directory,input.sessionID,input.permit]);
 const valid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
 return {
  run(input,context,action){
   if(closed||!valid(input?.requestID))throw fail('request_invalid');
   const existing=requests.get(input.requestID);
   if(existing){
    if(existing.cancelled&&existing.identity===identity(input)){requests.delete(input.requestID);throw fail('cancelled');}
    throw fail('request_duplicate');
   }
   if(requests.size>=128)throw fail('capacity');
   const controller=new AbortController(),entry={identity:identity(input),controller};requests.set(input.requestID,entry);
   const signal=AbortSignal.any([controller.signal,...context?.signal?[context.signal]:[]]);
   entry.work=Promise.resolve().then(()=>action(input,{signal}));void entry.work.catch(()=>{});return entry.work;
  },
  async settle(input){
   if(!record(input)||Object.keys(input).some(key=>!['requestID','permit','directory','sessionID'].includes(key))||!valid(input.requestID))throw fail('request_invalid');
   const entry=requests.get(input.requestID);
   if(!entry){
    // A finalizer can arrive before the interrupted HTTP request body.
    if(requests.size>=128)throw fail('capacity');requests.set(input.requestID,{identity:identity(input),cancelled:true});return null;
   }
   if(entry.identity!==identity(input))throw fail('request_mismatch');
   entry.controller?.abort(fail('cancelled'));
   try{await entry.work;}catch(cause){if(cause?.nativeProcessUnsettled)throw cause;}
   requests.delete(input.requestID);return null;
  },
  async close(){
   closed=true;for(const entry of requests.values())entry.controller?.abort(fail('closed'));
   const results=await Promise.allSettled([...requests.values()].map(entry=>entry.work));
   const failures=results.filter(result=>result.status==='rejected'&&result.reason?.nativeProcessUnsettled).map(result=>result.reason);
   if(failures.length)throw new AggregateError(failures,prefix+'_termination_unconfirmed');requests.clear();
  },
 };
}
