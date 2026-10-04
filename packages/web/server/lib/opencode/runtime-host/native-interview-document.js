import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {StringDecoder} from 'node:string_decoder';
import {startSessionExecution,readSessionExecutionReceipt,verifySessionExecutionLauncher} from '../../../../../harness-runtime/lib/session-execution.js';
import {createNativeReadGuard} from './native-read-paths.js';
const protocol='devryan-interview-document/1',MIB=1024*1024;
const fail=code=>Object.assign(new Error(code),{code,status:409,statusCode:409});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,names)=>object(value)&&Object.keys(value).every(key=>names.includes(key));
const hash=value=>createHash('sha256').update(value).digest('hex');

/** Constructor-only document work shares the existing preparation, supervisor, and durable ledger. */
export async function executeNativeInterviewDocument(input,authority,deps){
 const {runtime,nativeOptions,nativeHandles,preparations,launcher,cleanup,cleanupAfterPublication,recordReceipt,generation}=deps;
 if(!keys(input,['directory','sessionID','messageID','path','operation'])||!['sessionID','messageID'].every(key=>typeof input[key]==='string'&&/^[a-zA-Z0-9_-]{1,512}$/.test(input[key]))
  ||typeof input.directory!=='string'||!path.isAbsolute(input.directory)||typeof input.path!=='string'||!path.isAbsolute(input.path)
  ||!input.path.endsWith('.md')||!object(input.operation))throw fail('native_interview_scope_invalid');
 const relative=path.relative(input.directory,input.path),expected=nativeOptions?.reviewedAstOrigin;
 if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||input.path!==path.resolve(input.path)
  ||typeof authority?.recheck!=='function'||expected?.kind!=='plugin'||expected.id!=='devryan.slim'||!Array.isArray(expected.capabilities)
  ||!expected.capabilities.includes('write')||!expected.capabilities.includes('process')||authority.origin?.kind!==expected.kind
  ||authority.origin.id!==expected.id||authority.origin.manifestDigest!==expected.manifestDigest
  ||JSON.stringify(authority.origin.capabilities)!==JSON.stringify(expected.capabilities)||generation()!==2)throw fail('native_interview_authority_invalid');
 if(input.operation.kind==='claim'?input.operation.sessionID!==input.sessionID:input.operation.record?.sessionID!==input.sessionID||input.operation.record?.markdownPath!==input.path)throw fail('native_interview_scope_invalid');
 if(nativeHandles.size>=128)throw fail('native_execution_capacity_exceeded');
 const guard=createNativeReadGuard({directory:input.directory,protectedRoots:nativeOptions.locations?.find(location=>location.directory===input.directory)?.protectedRoots??[]});
 const {owner,jobs}=await preparations(),controller=new AbortController(),signal=AbortSignal.any([owner.signal,controller.signal,...authority.signal?[authority.signal]:[]]);
 const recheck=async()=>{signal.throwIfAborted();owner.assert();await authority.recheck();await guard(input.path);signal.throwIfAborted();owner.assert();};
 await recheck();
 if(!path.isAbsolute(nativeOptions.workerCommand??'')||!Array.isArray(nativeOptions.workerArgs)||!await verifySessionExecutionLauncher({launcher:launcher()}))throw fail('native_interview_worker_unavailable');
 const scope={directory:input.directory,sessionID:input.sessionID,userMessageID:input.messageID,messageID:input.messageID,callID:'interview_document_'+randomUUID(),kind:'process',
  publicationPolicy:'interview-document',publicationPath:relative.split(path.sep).join('/'),executionFingerprint:hash(JSON.stringify(input)),ownerID:owner.id};
 await recheck();const reserved=await runtime.reserve(scope),id=randomUUID(),job={input:{...scope,kind:'interview-document'},lease:reserved,controller,done:false};nativeHandles.set(id,job);
 const work=(async()=>{
  let launched=false,published=false,result,receipt,decoded;
  const complete=async publication=>{
   if(publication.outcome==='partial')throw fail('native_interview_publication_conflict');
   await recheck();await recordReceipt?.({...await runtime.executionReceipt({directory:input.directory,token:reserved.token}),tool:'interview-document'});
   await cleanupAfterPublication(job.lease);await recheck();return {result:decoded.result,receipt,publication};
  };
  try{
   jobs.start(reserved,scope);let prepared;do{prepared=await jobs.poll(reserved);await recheck();}while(prepared.state==='preparing');
   if(prepared.state!=='ready')throw fail(prepared.error?.code??'execution_not_ready');job.lease=prepared.lease;
   await recheck();await jobs.claim(job.lease,()=>runtime.claimLease({directory:input.directory,token:reserved.token,kind:'process'}));
   const scratch=path.join(path.dirname(job.lease.viewDirectory),'scratch');await fs.mkdir(scratch,{recursive:true});
   const target=path.join(job.lease.workingDirectory,relative),operation=structuredClone(input.operation);
   if(operation.record)operation.record.markdownPath=target;
   const bytes=Buffer.from(JSON.stringify({path:target,operation}));if(bytes.length>16*MIB)throw fail('native_interview_input_invalid');
   const inputPath=path.join(scratch,'interview-document.json');await fs.writeFile(inputPath,bytes,{mode:0o600});
   const env={...nativeOptions.workerEnvironment,HOME:scratch,XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_DATA_HOME:path.join(scratch,'data'),XDG_STATE_HOME:path.join(scratch,'state'),XDG_CACHE_HOME:path.join(scratch,'cache')};
   for(const key of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTHORIZATION|^DEVRYAN_.*URL/i.test(key))delete env[key];
   const chunks=[],digest=createHash('sha256'),decoder=new StringDecoder('utf8');let pending='',size=0,stderr=0,failure;
   const reject=cause=>{failure??=cause;controller.abort(cause);};
   const onOutput=({stream,data})=>{
    if(stream==='stderr'){stderr+=data.length;if(stderr>64*1024)reject(fail('native_interview_protocol_invalid'));return;}
    pending+=decoder.write(data);let newline;
    while((newline=pending.indexOf('\n'))!==-1){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
     try{const event=JSON.parse(line);if(Buffer.byteLength(line)>64*1024||event.protocol!==protocol||result)throw fail('native_interview_protocol_invalid');
      if(event.type==='chunk'){
       if(!keys(event,['protocol','type','index','data'])||event.index!==chunks.length||typeof event.data!=='string'||event.data.length>44*1024
        ||!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data))throw fail('native_interview_protocol_invalid');
       const chunk=Buffer.from(event.data,'base64');size+=chunk.length;if(size>16*MIB)throw fail('native_interview_output_invalid');chunks.push(chunk);digest.update(chunk);
      }else if(event.type==='result'&&event.ok===true){
       if(!keys(event,['protocol','type','ok','chunks','bytes','sha256'])||event.chunks!==chunks.length||event.bytes!==size||event.sha256!==digest.digest('hex'))throw fail('native_interview_protocol_invalid');result=event;
      }else if(event.type==='result'&&event.ok===false){
       if(!keys(event,['protocol','type','ok','error'])||!keys(event.error,['code','ownerSessionID'])||!/^native_interview_[a-z_]{1,80}$/.test(event.error.code)
        ||event.error.ownerSessionID!==undefined&&!(typeof event.error.ownerSessionID==='string'&&/^[a-zA-Z0-9_-]{1,512}$/.test(event.error.ownerSessionID)))throw fail('native_interview_protocol_invalid');result=event;
      }else throw fail('native_interview_protocol_invalid');
     }catch(cause){reject(cause);}
    }if(Buffer.byteLength(pending)>64*1024)reject(fail('native_interview_protocol_invalid'));
   };
   await recheck();const started=await startSessionExecution({launcher:launcher(),lease:job.lease,command:nativeOptions.workerCommand,args:[...nativeOptions.workerArgs,'--interview-document'],env,
    signal,onOutput,input:JSON.stringify({protocol,path:inputPath,home:scratch})+'\n',socketDirectory:null,workerBrowsers:false,deniedReadDirectories:nativeOptions.deniedReadDirectories});
   launched=true;job.unsettled=true;job.child=started.child;receipt=await started.result;job.unsettled=receipt.terminated!==true||receipt.confined!==true;pending+=decoder.end();
   try{nativeOptions.onTermination?.({...scope,token:reserved.token,receipt});}catch{/* Observer only. */}
   signal.throwIfAborted();
   if(!receipt.terminated||!receipt.confined||receipt.cancelled||receipt.exitCode!==0||signal.aborted||failure||pending||!result?.ok){
    const cause=failure??fail(result?.error?.code??'native_interview_document_failed');if(result?.error?.ownerSessionID)cause.ownerSessionID=result.error.ownerSessionID;throw cause;
   }
   decoded=JSON.parse(Buffer.concat(chunks,size).toString());if(!keys(decoded,['result'])||decoded.result!==null&&typeof decoded.result!=='string')throw fail('native_interview_output_invalid');
   await recheck();const publication=await runtime.finish({directory:input.directory,token:reserved.token});published=true;job.published=true;return await complete(publication);
  }catch(cause){
   if(published)throw cause;
   if(!launched){await jobs.cancel(job.lease);await runtime.cancelUnstartedCall({...scope,token:reserved.token});await cleanup(job.lease);}
   else{
    try{await readSessionExecutionReceipt(job.lease);job.unsettled=false;}catch(uncertain){job.unsettled=true;throw Object.assign(uncertain,{nativeProcessUnsettled:true});}
    if((await runtime.leaseForCall(scope))?.state==='published'){
     published=true;job.published=true;return await complete(await runtime.finish({directory:input.directory,token:reserved.token}));
    }
    await runtime.cancelLease({directory:input.directory,token:reserved.token});await cleanup(job.lease);
   }throw cause;
  }finally{job.done=true;if(!job.unsettled)nativeHandles.delete(id);}
 })();
 job.settled=work.then(()=>undefined,cause=>{if(job.unsettled||job.published)throw cause;});void job.settled.catch(()=>{});return work;
}
