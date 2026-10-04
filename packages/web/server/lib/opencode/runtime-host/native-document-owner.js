import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code,status:403,statusCode:403});
const within=(root,target)=>target===root||target.startsWith(root+path.sep);
const metadata=target=>target.split(path.sep).some(component=>component.toLowerCase()==='.git');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value,Object.keys(value).sort())).digest('hex');
const partFields=['id','url','filename','mime','name','mimeType'];
const partIdentity=part=>Object.fromEntries(partFields.filter(key=>part[key]!==undefined).map(key=>[key,part[key]]));
const MIB=1024*1024;

/** Canonical lineage and the original invocation grant own document bytes and cache publication. */
export function createNativeDocumentOwner(options){
 if(!Array.isArray(options.locations)||!options.locations.length||!path.isAbsolute(options.cacheRoot??'')
  ||typeof options.createCache!=='function'||typeof options.readSession!=='function'||typeof options.readUserAttachments!=='function'
  ||typeof options.authorizeParent!=='function'||typeof options.parseAttachment!=='function')throw fail('native_document_owner_required');
 const scopes=new AsyncLocalStorage();
 const cacheRoot=path.resolve(options.cacheRoot),locations=new Map();
 for(const entry of options.locations){
  if(!record(entry)||!path.isAbsolute(entry.directory??'')||path.resolve(entry.directory)!==entry.directory||locations.has(entry.directory)
   ||[...(entry.readRoots??[]),...(entry.protectedRoots??[])].some(root=>typeof root!=='string'||!path.isAbsolute(root)))throw fail('native_document_location_invalid');
  locations.set(entry.directory,structuredClone(entry));
 }
 const ensureCachePath=async target=>{
  if(!path.isAbsolute(target)||!within(cacheRoot,path.resolve(target)))throw fail('native_document_cache_path_denied');
  let current=path.parse(cacheRoot).root;
  for(const component of path.resolve(target).slice(current.length).split(path.sep)){
   current=path.join(current,component);
   const stat=await fs.lstat(current).catch(cause=>{if(cause.code==='ENOENT')return null;throw cause;});
   if(stat?.isSymbolicLink())throw fail('native_document_cache_path_denied');
  }
 };
 const cacheCheck=async(target,context={reason:'content'})=>{
  const scope=scopes.getStore();if(!scope)throw fail('native_document_cache_scope_required');
  await scope.check();await ensureCachePath(target);await scope.check();
  if(context.reason==='maintenance'){
   if(!['stat','readdir','rm','rmdir'].includes(context.operation))throw fail('native_document_cache_maintenance_denied');
   return;
  }
  if(context.reason!=='content')throw fail('native_document_cache_scope_required');
  const relative=path.relative(cacheRoot,target),key=relative.split(path.sep)[0];
  if(relative&&![scope.sessionID,...scope.parents.map(parent=>parent.parentID)].some(id=>
   createHash('sha256').update('session\0'+id).digest('hex')===key))throw fail('native_document_cache_content_denied');
 };
 const cache=options.createCache({root:cacheRoot,authorizeWrite:cacheCheck,authorizeRead:cacheCheck});
 return {
  ownersFor:async({sessionID,directory:requestedDirectory,assertCurrent,signal})=>{
   const location=locations.get(requestedDirectory);
   if(!sessionID||!location||typeof assertCurrent!=='function'||!(signal instanceof AbortSignal))throw fail('native_document_scope_invalid');
   const directory=location.directory;
   const check=async()=>{signal.throwIfAborted();await assertCurrent();signal.throwIfAborted();};
   const canonical=async id=>{
    await check();if(await fs.realpath(directory)!==directory)throw fail('native_document_location_invalid');
    const row=await options.readSession({sessionID:id,directory});await check();
    if(row?.id!==id||row.directory!==directory||row.revert||row.time?.archived)throw fail('native_document_session_stale');
    return row;
   };
   const lineage=async()=>{
    const entries=[],seen=new Set();let id=sessionID;
    for(let depth=0;id&&depth<16;depth++){
     if(seen.has(id))throw fail('native_document_lineage_invalid');seen.add(id);
     const row=await canonical(id);entries.push({sessionID:id,depth});
     if(depth===15)break;
     if(row.parentID){
      if(typeof row.parentID!=='string')throw fail('native_document_lineage_invalid');
      await options.authorizeParent({sessionID,parentID:row.parentID,directory,sourceSessionID:id});await check();
      scopes.getStore()?.parents.push({sessionID,parentID:row.parentID,directory,sourceSessionID:id});
     }
     id=row.parentID;
    }
    return entries;
   };
   const run=async action=>{
    await canonical(sessionID);
    const scope={sessionID,parents:[],check:async()=>{
     await check();for(const binding of scope.parents){
      const source=await canonical(binding.sourceSessionID);if(source.parentID!==binding.parentID)throw fail('native_document_lineage_changed');
      await options.authorizeParent(binding);await check();
     }
    }};
    const result=await scopes.run(scope,action);await scope.check();await canonical(sessionID);return result;
   };
   const same=(id,dir=directory)=>{if(id!==sessionID||dir!==directory)throw fail('native_document_scope_mismatch');};
   const sourceInput=input=>{
    same(input.sessionID);
    if(typeof input.sourceID!=='string'||!/^source_[a-f0-9]{64}$/.test(input.sourceID)
     ||typeof input.sourceName!=='string'||input.sourceName.length>1024)throw fail('native_document_source_invalid');
    if(input.sourceHash!==undefined&&(typeof input.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceHash)
     ||input.sourceID!=='source_'+createHash('sha256').update(input.sourceHash+'\0'+input.sourceName).digest('hex')))throw fail('native_document_source_invalid');
   };
   const matchesPart=async part=>{
    if(!record(part)||typeof part.id!=='string'||typeof part.url!=='string'
     ||Object.keys(part).some(key=>!partFields.includes(key)))throw fail('native_document_attachment_invalid');
    await canonical(sessionID);const rows=await options.readUserAttachments({sessionID,directory});await check();
    if(!Array.isArray(rows)||rows.length>10_000||!rows.some(row=>typeof row.messageID==='string'&&record(row.part)
     &&digest(partIdentity(row.part))===digest(partIdentity(part))))throw fail('native_document_attachment_not_canonical');
   };
   const fileBytes=async part=>{
    await matchesPart(part);
    let buffer,mime=part.mime??part.mimeType??'';
    if(part.url.startsWith('data:')){
     const comma=part.url.indexOf(',');if(comma<5)throw fail('DOCUMENT_URL_INVALID');
     const tokens=part.url.slice(5,comma).split(';'),payload=part.url.slice(comma+1);mime=tokens[0]||mime;
     if(tokens.some(token=>token.toLowerCase()==='base64')){
      const encoded=payload.replace(/\s/g,'');
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4===1||Math.floor(encoded.length*3/4)>20*MIB+2)throw fail('DOCUMENT_URL_INVALID');
      buffer=Buffer.from(encoded,'base64');
     }else{if(Buffer.byteLength(payload)>60*MIB)throw fail('DOCUMENT_ATTACHMENT_TOO_LARGE');buffer=Buffer.from(decodeURIComponent(payload));}
    }else{
     const url=new URL(part.url);if(url.protocol!=='file:'||(url.hostname&&url.hostname!=='localhost'))throw fail('DOCUMENT_REMOTE_URL_UNSUPPORTED');
     const lexical=path.resolve(fileURLToPath(url)),real=await fs.realpath(lexical);
     const roots=await Promise.all((location.readRoots??[directory]).map(root=>fs.realpath(root)));
     const protectedRoots=await Promise.all([cacheRoot,...(location.protectedRoots??[])].map(async root=>{
      try{return await fs.realpath(root);}catch(cause){if(cause.code==='ENOENT')return path.resolve(root);throw cause;}
     }));
     if(metadata(lexical)||metadata(real)||!roots.some(root=>within(root,real))
      ||protectedRoots.some(root=>within(root,lexical)||within(root,real)))throw fail('native_document_attachment_root_denied');
     await check();const file=await fs.open(real,constants.O_RDONLY|constants.O_NOFOLLOW);
     try{const before=await file.stat();if(!before.isFile()||before.size>20*MIB)throw fail('DOCUMENT_ATTACHMENT_TOO_LARGE');
      if(await fs.realpath(lexical)!==real)throw fail('native_document_attachment_root_denied');
      buffer=await file.readFile();const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs
       ||await fs.realpath(lexical)!==real)throw fail('native_document_attachment_changed');
     }finally{await file.close();}
    }
    if(buffer.byteLength>20*MIB)throw fail('DOCUMENT_ATTACHMENT_TOO_LARGE');
    await matchesPart(part);return {buffer,mime};
   };
   return {
    assertCurrent:()=>canonical(sessionID).then(()=>{}),readAttachment:fileBytes,
    parseAttachment:async(payload,abort)=>{if(abort!==signal)throw fail('native_document_scope_mismatch');await check();const parsed=await options.parseAttachment(payload,signal);await check();return parsed;},
    readCachedSource:(id,sourceID)=>{same(id);return run(()=>cache.readCachedSource(id,sourceID));},
    saveParsedSource:(input,recheck)=>{sourceInput(input);return run(async()=>{await recheck();const result=await cache.saveParsedSource(input);await recheck();return result;});},
    saveFailedSource:(input,recheck)=>{sourceInput(input);return run(async()=>{await recheck();const result=await cache.saveFailedSource(input);await recheck();return result;});},
    listAccessibleDocuments:(id,dir)=>{same(id,dir);return run(async()=>{
     const documents=[],seen=new Set();for(const entry of await lineage()){
      for(const document of await cache.listSessionDocuments(entry.sessionID))if(!seen.has(document.id)){seen.add(document.id);documents.push({document,depth:entry.depth});}
      await check();
     }return documents;
    });},
    findAccessibleDocument:(id,dir,documentID)=>{same(id,dir);return run(async()=>{
     for(const entry of await lineage()){const document=await cache.readCachedDocument(entry.sessionID,documentID);await check();if(document)return {document,depth:entry.depth};}return null;
    });},
   };
  },
 };
}
