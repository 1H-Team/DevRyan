const fail=code=>Object.assign(new Error(code),{code,status:403});
const allowedEndpoints=new Set([
  'https://chatgpt.com/backend-api/codex/responses',
  'https://api.openai.com/v1/responses',
]);
const codexEndpoint='https://chatgpt.com/backend-api/codex/responses';
const apiEndpoint='https://api.openai.com/v1/responses';
const limit=36*1024*1024;

/** Original image request/parser; credentials and cancellation stay in Node.
 * SIWC image generation is unsupported and refuses before provider traffic. */
export function createNativeImageGeneration({withImageGeneration,originals,fetchImpl=globalThis.fetch}){
  if(typeof withImageGeneration!=='function'||typeof originals?.withReviewedImagegenOwner!=='function'
    ||typeof originals.callReviewedImagegenResponses!=='function')throw fail('native_image_generation_owner_required');
  return (invocation,args,{signal}={})=>withImageGeneration(invocation,async owner=>{
    const currentSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(240_000)]):AbortSignal.timeout(240_000);
    const readers=new Set();let apiKeyBilling=false;
    try{
      const base64=await originals.withReviewedImagegenOwner({fetch:async(url,init)=>{
        if(!allowedEndpoints.has(url)||init?.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>limit)
          throw fail('native_image_generation_request_invalid');
        currentSignal.throwIfAborted();const credential=await owner.access();currentSignal.throwIfAborted();
        if(credential.methodID==='chatgpt-siwc')throw fail('native_image_generation_siwc_unsupported');
        const apiKey=credential.valueType==='key';
        if(apiKey&&credential.methodID!=='api-key')throw fail('native_image_generation_credential_invalid');
        apiKeyBilling=apiKey;
        if(!apiKey&&url!==codexEndpoint)throw fail('native_image_generation_request_invalid');
        const targetEndpoint=apiKey?apiEndpoint:codexEndpoint;
        const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${credential.accessToken}`);
        if(apiKey){headers.delete('ChatGPT-Account-Id');headers.delete('chatgpt-account-id');}
        else headers.set('ChatGPT-Account-Id',credential.accountId);
        await owner.recheck();currentSignal.throwIfAborted();
        const response=await fetchImpl(targetEndpoint,{...init,headers,redirect:'error',signal:currentSignal});
        try{await owner.recheck();currentSignal.throwIfAborted();if(!response.ok||!response.body)throw fail('native_image_generation_provider_failed');}
        catch(error){await response.body?.cancel().catch(()=>{});throw error;}
        const reader=response.body.getReader();readers.add(reader);let bytes=0;
        return new Response(new ReadableStream({async pull(controller){
          try{
            currentSignal.throwIfAborted();const item=await reader.read();currentSignal.throwIfAborted();
            if(item.done){readers.delete(reader);reader.releaseLock();controller.close();return;}
            bytes+=item.value.byteLength;if(bytes>limit)throw fail('native_image_generation_response_overflow');
            controller.enqueue(item.value);
          }catch(error){controller.error(error);await reader.cancel().catch(()=>{});readers.delete(reader);reader.releaseLock();}
        },async cancel(){await reader.cancel().catch(()=>{});readers.delete(reader);reader.releaseLock();}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
      }},()=>originals.callReviewedImagegenResponses({access:'',accountId:''},args,args.referenceImages));
      await owner.recheck();currentSignal.throwIfAborted();
      if(typeof base64!=='string'||!base64||base64.length>32*1024*1024||base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
        ||Buffer.from(base64,'base64').toString('base64')!==base64)
        throw fail('native_image_generation_result_invalid');
      return {base64,...(apiKeyBilling?{billing:'api-key'}:{})};
    }finally{await Promise.allSettled([...readers].map(async reader=>{await reader.cancel();reader.releaseLock();}));}
  });
}
