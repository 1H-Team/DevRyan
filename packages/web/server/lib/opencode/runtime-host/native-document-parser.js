import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startReadOnlySessionExecution} from '../../../../../harness-runtime/lib/session-execution.js';

const protocol='devryan-document-parser/1',MIB=1024*1024;
const fail=code=>Object.assign(new Error(code),{code});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,names)=>record(value)&&Object.keys(value).every(key=>names.includes(key));

/** The original two-parser budget, with actual supervisor settlement before any result is returned. */
export function createNativeDocumentParser({launcher,command,args=[],storage,windowsOwner,onStarted,onTermination,deniedReadDirectories=[]}){
 let active=0;const waiters=[];
 const acquire=async signal=>{
  signal.throwIfAborted();
  if(active<2){active++;return;}
  await new Promise((resolve,reject)=>{
   const waiter={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
   const abort=()=>{const index=waiters.indexOf(waiter);if(index!==-1)waiters.splice(index,1);reject(signal.reason);};
   signal.addEventListener('abort',abort,{once:true});waiters.push(waiter);
  });
 };
 const release=()=>{const next=waiters.shift();if(next)next.resolve();else active--;};
 return async(payload,signal)=>{
  if(!(signal instanceof AbortSignal)||!fields(payload,['bytes','name','type'])||!(payload.bytes instanceof Uint8Array)
   ||payload.bytes.byteLength>20*MIB||typeof payload.name!=='string'||payload.name.length>1024
   ||!['text','pdf','docx','zip'].includes(payload.type))throw fail('native_document_parser_input_invalid');
  await acquire(signal);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(fail('DOCUMENT_WORKER_TIMEOUT')),payload.type==='zip'?60_000:20_000);
  const combined=AbortSignal.any([signal,controller.signal]),chunks=[],hash=createHash('sha256');
  let pending='',size=0,result,failure,stderr=0,started=false,verifiedReceipt=false;
  const reject=cause=>{failure??=cause;controller.abort(cause);};
  const output=({stream,data})=>{
   if(stream==='stderr'){stderr+=data.length;if(stderr>64*1024)reject(fail('native_document_parser_protocol_invalid'));return;}
   pending+=data.toString();
   let newline;
   while((newline=pending.indexOf('\n'))!==-1){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
    try{
     if(Buffer.byteLength(line)>64*1024)throw fail('native_document_parser_protocol_invalid');
     const event=JSON.parse(line);
     if(event.protocol!==protocol||result)throw fail('native_document_parser_protocol_invalid');
     if(event.type==='chunk'){
      if(!fields(event,['protocol','type','index','data'])||event.index!==chunks.length||typeof event.data!=='string'
       ||event.data.length>44*1024||!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data))throw fail('native_document_parser_protocol_invalid');
      const buffer=Buffer.from(event.data,'base64');size+=buffer.length;
      if(size>385*MIB)throw fail('native_document_parser_output_invalid');chunks.push(buffer);hash.update(buffer);
     }else if(event.type==='result'&&event.ok===true){
      if(!fields(event,['protocol','type','ok','chunks','bytes','sha256'])||event.chunks!==chunks.length||event.bytes!==size
       ||typeof event.sha256!=='string'||event.sha256!==hash.digest('hex'))throw fail('native_document_parser_protocol_invalid');result=event;
     }else if(event.type==='result'&&event.ok===false){
      if(!fields(event,['protocol','type','ok','error'])||!fields(event.error,['code'])||typeof event.error.code!=='string'
       ||!/^(?:DOCUMENT_[A-Z_]{1,80}|native_document_[a-z_]{1,80})$/.test(event.error.code))throw fail('native_document_parser_protocol_invalid');result=event;
     }else throw fail('native_document_parser_protocol_invalid');
    }catch(cause){reject(cause);}
   }
   if(Buffer.byteLength(pending)>64*1024)reject(fail('native_document_parser_protocol_invalid'));
  };
  try{
   const handle=await startReadOnlySessionExecution({launcher,command,args:[...args,'--parse-document'],storage,windowsOwner,
    signal:combined,socketDirectory:null,workerBrowsers:false,deniedReadDirectories,onOutput:output,
    env:{PATH:'/usr/bin:/bin'},inputForLease:async lease=>{
     const inputPath=path.join(lease.viewDirectory,'attachment.bin');
     if(process.platform==='win32'){
      if(typeof windowsOwner?.write!=='function')throw fail('private_windows_publication_authority_unavailable');
      await windowsOwner.write(inputPath,Buffer.from(payload.bytes),{expected:null});
     }else await fs.writeFile(inputPath,payload.bytes,{mode:0o600});
     return JSON.stringify({protocol,path:inputPath,name:payload.name,type:payload.type,home:path.join(path.dirname(lease.viewDirectory),'scratch')})+'\n';
    }});
   started=true;
   try{onStarted?.(handle);}catch(cause){handle.cancel();failure=cause;}
   const receipt=await handle.result;
   verifiedReceipt=receipt.terminated===true&&receipt.confined===true;
   await onTermination?.(receipt);
   if(failure)throw failure;
   if(receipt.cancelled||combined.aborted)throw combined.reason??fail('DOCUMENT_WORKER_FAILED');
   if(!receipt.terminated||!receipt.confined||pending||!result)throw fail('DOCUMENT_WORKER_FAILED');
   if(!result.ok)throw fail(result.error.code);
   if(receipt.exitCode!==0)throw fail('DOCUMENT_WORKER_FAILED');
   const parsed=JSON.parse(Buffer.concat(chunks,size).toString());
   if(!fields(parsed,['sourceType','documents','manifest'])||!['text','pdf','docx','zip'].includes(parsed.sourceType)
    ||!Array.isArray(parsed.documents)||parsed.documents.length>50||!Array.isArray(parsed.manifest)||parsed.manifest.length>200)throw fail('native_document_parser_output_invalid');
   for(const document of parsed.documents)if(!record(document)||typeof document.name!=='string'||typeof document.type!=='string'
    ||typeof document.text!=='string'||Buffer.byteLength(document.text)>16*MIB)throw fail('native_document_parser_output_invalid');
   return parsed;
  }catch(cause){
   if(!verifiedReceipt&&(started||cause?.code==='mutation_termination_unconfirmed')){
    throw Object.assign(fail('native_document_termination_unconfirmed'),{nativeProcessUnsettled:true,cause});
   }
   throw cause;
  }finally{clearTimeout(timeout);release();}
 };
}
