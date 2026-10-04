import fs from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';import {AsyncLocalStorage} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {createNativeReadGuard} from './native-read-paths.js';
const MIB=1024*1024;
const fail=(code,status=403)=>Object.assign(new Error(code),{code,status,statusCode:status});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,512}$/.test(value);
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
const snapshot=record=>Object.freeze(Object.fromEntries(['id','sessionID','idea','markdownPath','createdAt','status','baseMessageCount'].map(key=>[key,record[key]])));
const scopeFields=scope=>({directory:scope.directory,sessionID:scope.sessionID,messageID:scope.messageID,authorizationID:scope.authorizationID,recheck:scope.recheck,signal:scope.signal});

/** One original state machine per reviewed location; its IO has no ambient authority. */
export function createNativeInterviewOwner(options){
 const {originals}=options;
 if(!Array.isArray(options.locations)||!options.locations.length||options.locations.length>128
  ||!['createInterviewService','createInterviewHandler','resolveExistingInterviewPath','InterviewDocumentOwnershipError'].every(key=>typeof originals?.[key]==='function')
  ||!['captureInterviewAuthorization','captureInterviewUIAuthorization','captureInterviewEventAuthorization','executeDocument','baseURL','openBrowser'].every(key=>typeof options[key]==='function')
  ||!['messages','continue','notify','rename'].every(key=>typeof options.runtime?.[key]==='function'))throw fail('native_interview_owner_required');
 const context=new AsyncLocalStorage(),locations=new Map(),locks=new Map(),active=new Set(),uncertain=new Set(),lifetime=new AbortController();let closed=false;
 const current=()=>{const scope=context.getStore();if(!scope||closed)throw fail('native_interview_scope_required');scope.signal.throwIfAborted();if(scope.pure)throw fail('native_interview_event_effect_denied');return scope;};
 const check=async scope=>{if(closed)throw fail('native_interview_closed');scope.signal.throwIfAborted();if(scope.failure)throw scope.failure;await scope.recheck();scope.signal.throwIfAborted();if(closed)throw fail('native_interview_closed');if(scope.failure)throw scope.failure;};
 const io=async action=>{const scope=current();try{await check(scope);const result=await action(scope);await check(scope);return result;}catch(cause){if(!['ENOENT','native_interview_document_owned'].includes(cause?.code))scope.failure??=cause;throw cause;}};
 const background=action=>{const scope=current(),work=io(action);scope.pending.add(work);void work.catch(()=>{});return work;};
 const run=async(scope,action)=>{
  const owned={...scope,pending:new Set(),failure:null,signal:AbortSignal.any([lifetime.signal,...scope.signal?[scope.signal]:[]])};
  const work=context.run(owned,async()=>{let result,failure;try{await check(owned);result=await action();}catch(cause){failure=cause;}
   const settled=await Promise.allSettled([...owned.pending]);for(const result of settled)if(result.status==='rejected')failure??=result.reason;
   if(failure||owned.failure)throw failure??owned.failure;await check(owned);return result;});
  active.add(work);try{return await work;}catch(cause){if(cause?.nativeProcessUnsettled)uncertain.add(cause);throw cause;}finally{active.delete(work);}
 };
 const grant=async value=>{if(!value||typeof value.recheck!=='function'||value.signal!==undefined&&!(value.signal instanceof AbortSignal))throw fail('native_interview_authorization_required');await value.recheck();return value;};
 const getLocation=directory=>{const location=locations.get(directory);if(!location)throw fail('native_interview_location_unreviewed');return location;};
 const bindingScope=async binding=>{await binding.grant.recheck();return {...binding.command,authorizationID:binding.grant.authorizationID,recheck:()=>binding.grant.recheck(),signal:binding.grant.signal,boundCommand:binding};};
 for(const saved of options.locations){
  if(typeof saved.directory!=='string'||!path.isAbsolute(saved.directory)||saved.directory!==path.resolve(saved.directory)||locations.has(saved.directory))throw fail('native_interview_location_unreviewed');
  const directory=saved.directory,configuration=structuredClone(saved.configuration??{}),output=configuration.outputFolder??'interview';
  if(typeof output!=='string')throw fail('native_interview_output_invalid');
  const outputFolder=output.trim().replace(/^\/+|\/+$/g,'')||'interview',outputDirectory=path.resolve(directory,outputFolder);
  if(!within(directory,outputDirectory)||outputDirectory.split(path.sep).some(part=>part.toLowerCase()==='.git'))throw fail('native_interview_output_invalid');
  const guard=createNativeReadGuard({directory,readRoots:saved.readRoots??[directory],protectedRoots:saved.protectedRoots??[]});
  const commands=new Map(),interviews=new Map();
  const safeFile=async(file,{markdown=true}={})=>{
   if(typeof file!=='string'||!path.isAbsolute(file)||file!==path.resolve(file)||!within(directory,file)||file===directory||markdown&&!file.endsWith('.md'))throw fail('native_interview_path_denied');
   await guard(file);return file;
  };
  const document=async(file,operation)=>io(async scope=>{
   await safeFile(file);if(scope.directory!==directory||!id(scope.sessionID)||!id(scope.messageID)||!scope.authorizationID)throw fail('native_interview_scope_required');
   const result=await options.executeDocument({directory,sessionID:scope.sessionID,messageID:scope.messageID,path:file,operation},
    {origin:options.origin,recheck:()=>check(scope),signal:scope.signal});
   if(!result?.receipt||result.receipt.terminated!==true||result.receipt.confined!==true||result.receipt.cancelled===true||result.receipt.exitCode!==0)throw Object.assign(fail('native_interview_termination_unconfirmed'),{nativeProcessUnsettled:true});
   if(result.publication?.outcome==='partial')throw fail('native_interview_publication_conflict',409);return result.result;
  }).catch(cause=>{if(cause?.code==='native_interview_document_owned'&&id(cause.ownerSessionID))throw new originals.InterviewDocumentOwnershipError(file,cause.ownerSessionID);throw cause;});
  const readText=async file=>io(async()=>{
   await safeFile(file);const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const before=await handle.stat();if(!before.isFile()||before.size>16*MIB)throw fail('native_interview_document_too_large',413);
    const bytes=await handle.readFile(),after=await handle.stat();await safeFile(file);
    if(bytes.length>16*MIB||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||await fs.realpath(file)!==file)throw fail('native_interview_document_changed',409);return bytes.toString('utf8');
   }finally{await handle.close();}
  });
  const record=value=>{const scope=current();if(!object(value)||value.sessionID!==scope.sessionID||!id(value.id)||!Number.isSafeInteger(value.baseMessageCount)||value.baseMessageCount<0)throw fail('native_interview_record_invalid');return snapshot(value);};
  const runtime=Object.fromEntries(['messages','continue','notify','rename'].map(key=>[key,(sessionID,...args)=>{
   const scope=current();if(scope.directory!==directory||scope.sessionID!==sessionID)throw fail('native_interview_session_mismatch');
   const action=owned=>options.runtime[key](scopeFields(owned),...key==='messages'?[]:key==='continue'?[{text:args[0],...args[1]?{model:args[1]}:{}}]:key==='notify'?[{text:args[0]}]:[{title:args[0]}]);
   return key==='rename'?background(action):io(action);
  }]));
  const documents={
   withLock:async(file,action)=>{
    const scope=current();await check(scope);await safeFile(file);let slot=locks.get(file);
    if(!slot){if(locks.size>=128)throw fail('native_interview_document_capacity',503);slot={tail:Promise.resolve(),pending:0};locks.set(file,slot);}
    if(slot.pending>=8)throw fail('native_interview_document_capacity',503);const previous=slot.tail;let release;slot.tail=new Promise(resolve=>{release=resolve;});slot.pending++;
    try{await previous;await check(scope);const result=await action();await check(scope);return result;}finally{slot.pending--;release();if(!slot.pending)locks.delete(file);}
   },
   ensure:value=>{const row=record(value);return document(row.markdownPath,{kind:'ensure',record:row}).then(()=>undefined);},
   claim:(file,sessionID,baseMessageCount)=>{if(current().sessionID!==sessionID)throw fail('native_interview_session_mismatch');return document(file,{kind:'claim',sessionID,baseMessageCount});},
   read:value=>{const row=record(value);return document(row.markdownPath,{kind:'read',record:row});},
   rewrite:(value,summary,title)=>{const row=record(value);return document(row.markdownPath,{kind:'rewrite',record:row,summary,...title===undefined?{}:{title}});},
   rewriteFinal:(value,text)=>{const row=record(value);return document(row.markdownPath,{kind:'rewriteFinal',record:row,text});},
   appendAnswers:(value,questions,answers)=>{const row=record(value);return document(row.markdownPath,{kind:'appendAnswers',record:row,questions,answers}).then(()=>undefined);},
   readText,
   list:folder=>io(async()=>{if(folder!==outputDirectory)throw fail('native_interview_path_denied');await safeFile(folder,{markdown:false});const entries=await fs.readdir(folder);if(entries.length>10000)throw fail('native_interview_inventory_too_large',413);await safeFile(folder,{markdown:false});return entries;}),
   resolveExisting:(requestedDirectory,requestedOutput,value)=>io(async()=>{
    if(requestedDirectory!==directory||requestedOutput!==outputFolder||typeof value!=='string'||value.length>4096)throw fail('native_interview_path_denied');
    return originals.resolveExistingInterviewPath(directory,outputFolder,value,{exists:async file=>{
     await safeFile(file);try{const stat=await fs.lstat(file);if(!stat.isFile()||await fs.realpath(file)!==file)throw fail('native_interview_path_denied');return true;}catch(cause){if(cause?.code==='ENOENT')return false;throw cause;}
    }});
   }),
  };
  const service=originals.createInterviewService({directory},configuration,{runtime,documents,env:{},openBrowser:url=>{void background(scope=>options.openBrowser(scopeFields(scope),url));}});
  service.setBaseUrlResolver(()=>io(async()=>{const url=await options.baseURL(directory);if(typeof url!=='string')throw fail('native_interview_url_invalid');return url;}));
  service.setStatePushCallback(()=>{});
  service.setOnInterviewCreated(value=>{const command=current().boundCommand;if(!command||command.command.sessionID!==value.sessionID)throw fail('native_interview_scope_required');if(interviews.size>=2100)throw fail('native_interview_capacity',503);interviews.set(value.id,{record:snapshot(value),...command});});
  const handler=originals.createInterviewHandler({outputFolder:outputDirectory,basePrefix:saved.basePrefix??'',authorize:async()=>{await check(current());},
   listInterviews:()=>service.listInterviews().filter(item=>current().visible?.has(item.id)),listInterviewFiles:()=>service.listInterviewFiles(),
   getState:key=>service.getInterviewState(key),submitAnswers:(key,answers)=>service.submitAnswers(key,answers),submitBlockComment:(key,section,comment)=>service.submitBlockComment(key,section,comment),
   submitChat:(key,message)=>service.submitChat(key,message),handleNudgeAction:(key,action)=>service.handleNudgeAction(key,action)});
  locations.set(directory,{directory,commands,interviews,service,handler});
 }
 const handleCommand=async(input,parts,requestOptions={})=>{
  if(requestOptions.signal!==undefined&&!(requestOptions.signal instanceof AbortSignal))throw fail('native_interview_scope_invalid');
  requestOptions.signal?.throwIfAborted();
  if(!object(input)||!id(input.sessionID)||!id(input.messageID)||typeof input.args!=='string'||Buffer.byteLength(input.args)>64*1024||!Array.isArray(parts))throw fail('native_interview_command_invalid');
  const location=getLocation(input.directory),captured=await grant(await options.captureInterviewAuthorization(input));
  if(typeof captured.authorizationID!=='string'||!id(captured.authorizationID))throw fail('native_interview_authorization_required');
  if(!location.commands.has(input.sessionID)&&location.commands.size>=2000)throw fail('native_interview_capacity',503);
  const command=Object.freeze({directory:input.directory,sessionID:input.sessionID,messageID:input.messageID,args:input.args}),binding={command,grant:captured};
  const previous=location.commands.get(input.sessionID);location.commands.set(input.sessionID,binding);
  try{const scope=await bindingScope(binding);return await run({...scope,signal:AbortSignal.any([...scope.signal?[scope.signal]:[],...requestOptions.signal?[requestOptions.signal]:[]])},()=>location.service.handleCommandExecuteBefore({command:'interview',sessionID:input.sessionID,arguments:input.args},{parts}));}
  catch(cause){if(location.commands.get(input.sessionID)===binding){if(previous)location.commands.set(input.sessionID,previous);else location.commands.delete(input.sessionID);}throw cause;}
 };
 const handleEvent=async input=>{
  const location=getLocation(input.directory),binding=location.commands.get(input.sessionID);if(!binding)return;
  const fresh=await grant(await options.captureInterviewEventAuthorization({...input,...commandIdentity(binding)}));
  if(input.event?.type==='session.deleted'){
   if((input.event.properties?.info?.id??input.event.properties?.sessionID)!==input.sessionID)throw fail('native_interview_session_mismatch');
   // The actual original deleted-session branch only abandons and removes
   // ephemeral maps. A private current-controller event grant may observe the
   // already-absent session; original command authority cannot authorize IO.
   await run({...binding.command,authorizationID:binding.grant.authorizationID,recheck:()=>fresh.recheck(),signal:fresh.signal,pure:true},()=>location.service.handleEvent({event:input.event}));
   location.commands.delete(input.sessionID);for(const [key,value]of location.interviews)if(value.command.sessionID===input.sessionID)location.interviews.delete(key);return;
  }
  const original=await bindingScope(binding);
  await run({...original,recheck:async()=>{await original.recheck();await fresh.recheck();},signal:AbortSignal.any([...original.signal?[original.signal]:[],...fresh.signal?[fresh.signal]:[]])},()=>location.service.handleEvent({event:input.event}));
 };
 const commandIdentity=binding=>({directory:binding.command.directory,sessionID:binding.command.sessionID,messageID:binding.command.messageID,authorizationID:binding.grant.authorizationID});
 const handleRequest=async({directory,request,response})=>{
  const location=getLocation(directory),url=new URL(request.url??'/', 'http://127.0.0.1'),match=url.pathname.match(/^\/(?:api\/interviews|interview)\/([^/]+)(?:\/(state|answers|block-comment|chat|nudge))?$/);
  const key=match?decodeURIComponent(match[1]):null,binding=key?location.interviews.get(key):null;
  if(key&&!binding)throw fail('native_interview_not_found',404);
  const operation=match?.[2]??(key?'page':'dashboard'),fresh=await grant(await options.captureInterviewUIAuthorization({directory,operation,...binding?{interview:{id:key,...commandIdentity(binding)}}:{}},request));
  const original=binding?await bindingScope(binding):{directory};
  const visible=new Set();if(!binding)for(const [interviewID,candidate]of location.interviews){try{await candidate.grant.recheck();await grant(await options.captureInterviewUIAuthorization({directory,operation:'list',interview:{id:interviewID,...commandIdentity(candidate)}},request));visible.add(interviewID);}catch{/* Unauthorized rows never enter the original dashboard. */}}
  const headers=new Map();let body,status=200;
  const buffered={get statusCode(){return status;},set statusCode(value){status=value;},setHeader(name,value){headers.set(name,value);},end(value){if(body!==undefined)throw fail('native_interview_response_invalid');body=Buffer.from(value??'');if(body.length>16*MIB)throw fail('native_interview_response_too_large',413);}};
  await run({...original,visible,signal:AbortSignal.any([...original.signal?[original.signal]:[],...fresh.signal?[fresh.signal]:[]]),recheck:async()=>{await original.recheck?.();await fresh.recheck();}},()=>{
   // Existing web middleware may already have consumed the stream. The
   // original parser still validates bounded JSON, never an empty second read.
   let bodyRequest=request;
   if(request.body!==undefined){
    const bytes=Buffer.from(JSON.stringify(request.body));if(bytes.length>64*1024)throw fail('native_interview_request_too_large',413);
    bodyRequest=Readable.from([bytes]);bodyRequest.url=request.url;bodyRequest.method=request.method;
   }
   return location.handler(bodyRequest,buffered);
  });
  if(body===undefined)throw fail('native_interview_response_invalid');await fresh.recheck();response.statusCode=status;for(const [key,value]of headers)response.setHeader(key,value);response.end(body);
 };
 return {handleCommand,handleEvent,handleRequest,getActiveInterviewId:async({directory,sessionID})=>{
   if(closed)throw fail('native_interview_closed');const location=getLocation(directory),binding=location.commands.get(sessionID);if(!binding)return null;
   binding.grant.signal?.throwIfAborted();await binding.grant.recheck();const result=location.service.getActiveInterviewId(sessionID);await binding.grant.recheck();binding.grant.signal?.throwIfAborted();if(closed)throw fail('native_interview_closed');return result;
  },
  close:async()=>{closed=true;lifetime.abort(fail('native_interview_closed'));const results=await Promise.allSettled([...active]);locations.clear();locks.clear();const failures=[...new Set([...uncertain,...results.filter(result=>result.status==='rejected'&&result.reason?.nativeProcessUnsettled).map(result=>result.reason)])];if(failures.length)throw new AggregateError(failures,'Native interview settlement unconfirmed');}};
}
