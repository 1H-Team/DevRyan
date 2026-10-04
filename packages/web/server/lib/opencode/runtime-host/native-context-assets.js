import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {startSessionExecution,readSessionExecutionReceipt,verifySessionExecutionLauncher} from '../../../../../harness-runtime/lib/session-execution.js';

const fail=code=>Object.assign(new Error(code),{code,status:409,statusCode:409});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,names)=>record(value)&&Object.keys(value).every(key=>names.includes(key));
const protocol='devryan-context-images/1',MIB=1024*1024;
const digest=value=>createHash('sha256').update(value).digest('hex');
const suffix=' Your model may not support image input. Delegate to @observer with the file path(s) above so it can read the file with its read tool.]';
const imageBytes=async file=>{
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat();if(!before.isFile()||before.size>65*MIB)throw fail('native_image_publication_missing');
  const bytes=await handle.readFile(),after=await handle.stat();
  if(bytes.length>65*MIB||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs
   ||await fs.realpath(file)!==file)throw fail('native_image_publication_missing');return bytes;
 }finally{await handle.close();}
};

const validateResult=(result,original,lease)=>{
 if(!fields(result,['messages','imagesSkipped','privateDirectory','state'])||!Array.isArray(result.messages)||result.messages.length!==original.length
  ||typeof result.imagesSkipped!=='boolean'||result.privateDirectory!==lease.workingDirectory)throw fail('native_image_output_invalid');
 if(!fields(result.state,['schema','logicalDirectory','cleanup','counts','resolved'])||result.state.schema!==1||result.state.logicalDirectory!==lease.directory
  ||![result.state.cleanup,result.state.counts,result.state.resolved].every(value=>Array.isArray(value)&&value.length<=256)
  ||Buffer.byteLength(JSON.stringify(result.state))>256*1024)throw fail('native_image_output_invalid');
 for(let i=0;i<result.messages.length;i++){
  const message=result.messages[i],source=original[i];
  if(!record(message)||JSON.stringify(message.info)!==JSON.stringify(source.info)||!Array.isArray(message.parts))throw fail('native_image_output_invalid');
  for(const part of message.parts){
   if(source.parts.some(before=>JSON.stringify(before)===JSON.stringify(part)))continue;
   if(!fields(part,['type','text'])||part.type!=='text'||typeof part.text!=='string'
    ||!part.text.startsWith('[Image attachment detected. Saved to: ')||!part.text.endsWith(suffix))throw fail('native_image_output_invalid');
   for(const file of part.text.slice('[Image attachment detected. Saved to: '.length,-suffix.length).split(', ')){
    const relative=path.relative(lease.workingDirectory,file);
    if(!path.isAbsolute(file)||!relative.startsWith(`.opencode${path.sep}images${path.sep}`)||relative.split(path.sep).some(component=>component==='..'))throw fail('native_image_output_invalid');
   }
  }
 }
};

/** Remap only the original image hook's generated notice after canonical bytes exist. */
async function canonicalResult(result,original,lease,publication,recheck){
 validateResult(result,original,lease);
 if(publication.outcome==='partial')throw fail('native_image_publication_conflict');
 const messages=structuredClone(result.messages);
 for(let i=0;i<messages.length;i++){
  const message=messages[i],source=original[i];
  if(!record(message)||JSON.stringify(message.info)!==JSON.stringify(source.info)||!Array.isArray(message.parts))throw fail('native_image_output_invalid');
  for(const part of message.parts){
   if(source.parts.some(before=>JSON.stringify(before)===JSON.stringify(part)))continue;
   if(!fields(part,['type','text'])||part.type!=='text'||typeof part.text!=='string'
    ||!part.text.startsWith('[Image attachment detected. Saved to: ')||!part.text.endsWith(suffix))throw fail('native_image_output_invalid');
   const privatePaths=part.text.slice('[Image attachment detected. Saved to: '.length,-suffix.length).split(', '),mapped=[];
   for(const file of privatePaths){
    const relative=path.relative(lease.workingDirectory,file);
    if(!relative.startsWith(`.opencode${path.sep}images${path.sep}`)||relative.split(path.sep).some(component=>component==='..'))throw fail('native_image_output_invalid');
    const canonical=path.join(lease.directory,relative);
    await recheck();
    if(await fs.realpath(file)!==file||await fs.realpath(canonical)!==canonical)throw fail('native_image_publication_missing');
    const [privateBytes,canonicalBytes]=await Promise.all([imageBytes(file),imageBytes(canonical)]);
    if(!privateBytes.equals(canonicalBytes))throw fail('native_image_publication_missing');
    await recheck();mapped.push(canonical);
   }
   part.text='[Image attachment detected. Saved to: '+mapped.join(', ')+suffix;
  }
 }
 return {messages,imagesSkipped:result.imagesSkipped};
}

/** Uses the existing host's preparation, handle ownership, receipt and ledger. */
export async function executeNativeContextAssets(input,{signal}={},deps){
 const {runtime,nativeOptions,nativeHandles,preparations,launcher,cleanup,cleanupAfterPublication,recordReceipt,generation}=deps;
 if(!fields(input,['directory','sessionID','messageID','messageIDs','permit'])||typeof input.directory!=='string'||!path.isAbsolute(input.directory)
  ||!Array.isArray(input.messageIDs)||input.messageIDs.length>2000||new Set(input.messageIDs).size!==input.messageIDs.length
  ||!input.messageIDs.every(id=>typeof id==='string'&&/^msg[A-Za-z0-9_-]{1,128}$/.test(id))||!input.messageIDs.includes(input.messageID)
  ||!['sessionID','messageID'].every(key=>typeof input[key]==='string'&&/^[a-zA-Z0-9_-]{1,512}$/.test(input[key])))throw fail('native_image_scope_invalid');
 if(generation()!==2||typeof nativeOptions?.captureContextAssets!=='function')throw fail('native_context_assets_unavailable');
 signal?.throwIfAborted();
 const captured=await nativeOptions.captureContextAssets(input),expected=nativeOptions.reviewedAstOrigin;
 if(!captured||typeof captured.recheck!=='function'||typeof captured.contextAssetID!=='string'
  ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(captured.contextAssetID)||expected?.kind!=='plugin'||expected.id!=='devryan.slim'
  ||!Array.isArray(expected.capabilities)||!expected.capabilities.includes('write')||!expected.capabilities.includes('process')
  ||captured.origin?.kind!==expected.kind||captured.origin.id!==expected.id||captured.origin.manifestDigest!==expected.manifestDigest
  ||JSON.stringify(captured.origin.capabilities)!==JSON.stringify(expected.capabilities))throw fail('native_image_authority_invalid');
 const messages=structuredClone(captured.messages);
 if(!Array.isArray(messages)||messages.length>2000||!fields(captured.anchor,['id','type','fingerprint'])
  ||captured.anchor.id!==input.messageID||!['user','synthetic','compaction'].includes(captured.anchor.type)||!/^([a-f0-9]{64})$/.test(captured.anchor.fingerprint??'')
  ||JSON.stringify(captured.messageIDs)!==JSON.stringify(input.messageIDs)
  ||messages.some(message=>!record(message)||message.info?.role!=='user'||message.info?.sessionID!==input.sessionID||!input.messageIDs.includes(message.info?.id)||!Array.isArray(message.parts))
  ||!['auto','direct'].includes(captured.imageRouting)||!Array.isArray(captured.disabledAgents)
  ||captured.disabledAgents.length>100||captured.disabledAgents.some(agent=>typeof agent!=='string'))throw fail('native_image_input_invalid');
 const bytes=Buffer.from(JSON.stringify({messages,imageRouting:captured.imageRouting,disabledAgents:captured.disabledAgents,
  logicalDirectory:input.directory,...deps.state?{state:deps.state}:{}}));
 if(bytes.length>65*MIB)throw fail('native_image_input_invalid');
 if(nativeHandles.size>=128)throw fail('native_execution_capacity_exceeded');
 const {owner,jobs}=await preparations();
 const controller=new AbortController(),combined=AbortSignal.any([owner.signal,controller.signal,...(signal?[signal]:[])]);
 const recheck=async()=>{combined.throwIfAborted();owner.assert();await captured.recheck();combined.throwIfAborted();owner.assert();};
 await recheck();
 if(!path.isAbsolute(nativeOptions.workerCommand??'')||!Array.isArray(nativeOptions.workerArgs)
  ||!await verifySessionExecutionLauncher({launcher:launcher()}))throw fail('native_context_assets_unavailable');
 await recheck();
 const scope={directory:input.directory,sessionID:input.sessionID,userMessageID:input.messageID,messageID:input.messageID,
  callID:'context_images_'+digest(captured.contextAssetID+'\0'+input.sessionID+'\0'+input.messageID),kind:'process',publicationPolicy:'context-images',
  executionFingerprint:digest(bytes),ownerID:owner.id};
 const reserved=await runtime.reserve(scope);
 if(reserved.ownerID!==owner.id||reserved.executionKind||reserved.state==='published')throw fail('execution_already_started');
 const handle=randomUUID(),job={input:{...scope,kind:'context-asset'},lease:reserved,controller,done:false};nativeHandles.set(handle,job);
 const work=(async()=>{
  let launched=false,published=false,result,receipt,decoded;
  const complete=async publication=>{
   const output=await canonicalResult(decoded,messages,job.lease,publication,recheck);
   await recordReceipt?.({...await runtime.executionReceipt({directory:input.directory,token:reserved.token}),tool:'context-assets'});
   await cleanupAfterPublication(job.lease);
   await recheck();deps.saveState(structuredClone(decoded.state));
   try{nativeOptions.onOutcome?.({...scope,token:reserved.token,state:'published'});}catch{/* Observer only. */}
   return {...output,contextAssetID:captured.contextAssetID,receipt,publication};
  };
  try{
   jobs.start(reserved,scope);let prepared;
   do{prepared=await jobs.poll(reserved);await recheck();}while(prepared.state==='preparing');
   if(prepared.state!=='ready')throw fail(prepared.error?.code??'execution_not_ready');
   job.lease=prepared.lease;
   await recheck();await jobs.claim(job.lease,()=>runtime.claimLease({directory:input.directory,token:reserved.token,kind:'process'}));
   const scratch=path.join(path.dirname(job.lease.viewDirectory),'scratch');await fs.mkdir(scratch,{recursive:true});
   const inputPath=path.join(scratch,'context-images.json');await fs.writeFile(inputPath,bytes,{mode:0o600});
   const env={...nativeOptions.workerEnvironment,HOME:scratch,XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_DATA_HOME:path.join(scratch,'data'),XDG_STATE_HOME:path.join(scratch,'state'),XDG_CACHE_HOME:path.join(scratch,'cache')};
   for(const key of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTHORIZATION|^DEVRYAN_.*URL/i.test(key))delete env[key];
   const chunks=[],hash=createHash('sha256'),decoder=new StringDecoder('utf8');let pending='',size=0,stderr=0,protocolFailure;
   const reject=cause=>{protocolFailure??=cause;controller.abort(cause);};
   const onOutput=({stream,data})=>{
    if(stream==='stderr'){stderr+=data.length;if(stderr>64*1024)reject(fail('native_image_protocol_invalid'));return;}
    pending+=decoder.write(data);let newline;
    while((newline=pending.indexOf('\n'))!==-1){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
     try{
      const event=JSON.parse(line);if(Buffer.byteLength(line)>64*1024||event.protocol!==protocol||result)throw fail('native_image_protocol_invalid');
      if(event.type==='chunk'){
       if(!fields(event,['protocol','type','index','data'])||event.index!==chunks.length||typeof event.data!=='string'||event.data.length>44*1024
        ||!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data))throw fail('native_image_protocol_invalid');
       const chunk=Buffer.from(event.data,'base64');size+=chunk.length;if(size>128*MIB)throw fail('native_image_protocol_invalid');chunks.push(chunk);hash.update(chunk);
      }else if(event.type==='result'&&event.ok===true){
       if(!fields(event,['protocol','type','ok','chunks','bytes','sha256'])||event.chunks!==chunks.length||event.bytes!==size||event.sha256!==hash.digest('hex'))throw fail('native_image_protocol_invalid');result=event;
      }else if(event.type==='result'&&event.ok===false){
       if(!fields(event,['protocol','type','ok','error'])||!fields(event.error,['code'])||!/^native_image_[a-z_]{1,80}$/.test(event.error.code))throw fail('native_image_protocol_invalid');result=event;
      }else throw fail('native_image_protocol_invalid');
     }catch(cause){reject(cause);}
    }
    if(Buffer.byteLength(pending)>64*1024)reject(fail('native_image_protocol_invalid'));
   };
   await recheck();
   const started=await startSessionExecution({launcher:launcher(),lease:job.lease,command:nativeOptions.workerCommand,args:[...nativeOptions.workerArgs,'--process-images'],env,
    signal:combined,onOutput,input:JSON.stringify({protocol,path:inputPath,home:scratch})+'\n',socketDirectory:null,workerBrowsers:false,deniedReadDirectories:nativeOptions.deniedReadDirectories});
   launched=true;job.unsettled=true;job.child=started.child;receipt=await started.result;
   job.unsettled=receipt.terminated!==true||receipt.confined!==true;pending+=decoder.end();
   try{nativeOptions.onTermination?.({...scope,token:reserved.token,receipt});}catch{/* Observer only. */}
   if(!receipt.terminated||!receipt.confined||receipt.cancelled||receipt.exitCode!==0||combined.aborted||protocolFailure||pending||!result?.ok)throw protocolFailure??fail(result?.error?.code??'native_image_worker_failed');
   await recheck();decoded=JSON.parse(Buffer.concat(chunks,size).toString());validateResult(decoded,messages,job.lease);
   const publication=await runtime.finish({directory:input.directory,token:reserved.token});published=true;job.published=true;
   return await complete(publication);
  }catch(cause){
   if(published)throw cause;
   if(!launched){await jobs.cancel(job.lease);await runtime.cancelUnstartedCall({...scope,token:reserved.token});await cleanup(job.lease);}
   else{
    // An uncertain supervisor stays recoverable; never discard without proof.
    try{await readSessionExecutionReceipt(job.lease);job.unsettled=false;}
    catch(uncertain){job.unsettled=true;throw Object.assign(uncertain,{nativeProcessUnsettled:true});}
    const durable=await runtime.leaseForCall(scope);
    if(durable?.state==='published'){
     published=true;job.published=true;
     // Existing ledger recovery materializes the committed contribution. It
     // cannot be cancelled as though publication had never been decided.
     const publication=await runtime.finish({directory:input.directory,token:reserved.token});
     return await complete(publication);
    }
    await runtime.cancelLease({directory:input.directory,token:reserved.token});await cleanup(job.lease);
   }
   throw cause;
  }finally{job.done=true;if(!job.unsettled)nativeHandles.delete(handle);}
 })();
 // Call failure is separate from process settlement. Stop/drain must succeed
 // after a cancelled/refused view really settled, and reject real uncertainty.
 job.settled=work.then(()=>undefined,cause=>{if(job.unsettled||job.published)throw cause;});
 void job.settled.catch(()=>{}); // Its consumer is the existing Stop/drain owner.
 return work;
}
