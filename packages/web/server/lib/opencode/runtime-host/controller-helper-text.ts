import type {OperationPermit} from './native-admission-contract.js';
import {requestPermit} from './native-admission-contract.js';
import {nativeHelperInput,nativeHelperTitleInput,type NativeHelperTitleInput,type NativeHelperInput} from './native-helper-contract.js';
import {readResponseBody} from '../opencode-client/envelope.js';

/** HTTP cancellation interrupts the real provider Effect, then acknowledges its finalizers. */
export function createControllerHelperText(options:{readonly generate:(input:NativeHelperInput,permit:OperationPermit,signal:AbortSignal,recheck:()=>Promise<void>)=>Promise<{text:string}>;
 readonly rename:(input:NativeHelperTitleInput&{readonly permit:OperationPermit})=>Promise<void>;
 readonly rpc:(method:string,input:unknown)=>Promise<unknown>;readonly isCurrent:()=>boolean}){
 const active=new Map<string,AbortController>();
 const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;
 const failureStatus=(error:unknown)=>{
  if(error instanceof Error&&error.message==='native_helper_model_unavailable')return 404;
  const reason=record(error)&&record(error.reason)?error.reason:undefined;
  const status=reason&&record(reason.http)?reason.http.status:record(error)?error.statusCode:undefined;
  return typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=599?status:503;
 };
 return async(request:Request):Promise<Response>=>{
  if(request.method!=='POST')return Response.json({code:'method_not_allowed'},{status:405});
  const permit=requestPermit();
  if(!permit||!options.isCurrent())return Response.json({code:'native_helper_unavailable'},{status:503});
  if(new URL(request.url).pathname==='/devryan/helper-text/cancel'){
   active.get(permit.token)?.abort(new Error('native_helper_cancelled'));return Response.json({ok:true});
  }
  if(active.has(permit.token))return Response.json({code:'native_helper_duplicate'},{status:409});
  const abort=new AbortController();active.set(permit.token,abort);
  try{
   const body=await readResponseBody({status:200,body:request.body,text:()=>request.text()},{maxResponseBytes:524288,signal:request.signal});
   if(new URL(request.url).pathname==='/devryan/helper-title'){
    const input=nativeHelperTitleInput(body.value);await options.rpc('native.helper.assert',{input,permit});
    await options.rename({...input,permit});return Response.json({title:input.title});
   }
   const input=nativeHelperInput(body.value);
   const signal=AbortSignal.any([request.signal,abort.signal,AbortSignal.timeout(input.timeoutMs)]);
   const recheck=async()=>{if(!options.isCurrent())throw Error('native_helper_expired');signal.throwIfAborted();await options.rpc('native.helper.assert',{input,permit});signal.throwIfAborted();};
   await recheck();return Response.json(await options.generate(input,permit,signal,recheck));
  }catch(error){const status=failureStatus(error);return Response.json({code:record(error)&&record(error.reason)?'native_helper_provider_failed':error instanceof Error&&/^native_[a-z0-9_]+$/.test(error.message)?error.message:'native_helper_failed'},{status});}
  finally{active.delete(permit.token);await options.rpc('native.helper.settled',{permit});}
 };
}
