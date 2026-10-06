import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';

const MAX_FILE_BYTES=16*1024*1024;
const BATCH_BYTES=64*1024;
const failure=code=>Object.assign(new Error(code),{code});

/** Constructor-owned journal adapter. Native operations own mutation, bytes,
 * identity and durability; Node only enumerates metadata. Append ownership spans
 * one bounded batch, so readers and same-parent publications remain available. */
export function createWindowsJournalFiles({directory,owner,metadata=fs}) {
 if(!owner||['read','write','delete','ensureDirectory','largeFile','append','tree','renameTree','removeTree','renameFile','truncate'].some(key=>typeof owner[key]!=='function'))throw failure('private_windows_journal_authority_unavailable');
 const parent=path.dirname(directory),name=path.basename(directory);
 const checked=file=>{
  if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||/[\u0000-\u001f]/.test(file))throw failure('private_windows_journal_path_invalid');
  const relative=path.relative(parent,file).split(path.sep)[0];
  if(file!==parent&&file!==directory&&!file.startsWith(directory+path.sep)&&!relative.startsWith(`.${name}-clear-`)&&!relative.startsWith(`${name}.clear-backup-`))throw failure('private_windows_journal_path_invalid');
  return file;
 };
 const proofs=new WeakMap(),updated=new WeakMap();
 const read=async file=>{const result=await owner.read(checked(file));proofs.set(result.bytes,result);return result;};
 const tokenFor=bytes=>{const value=proofs.get(bytes);if(!value)throw failure('private_windows_journal_proof_required');return updated.get(bytes)??`${value.identity.volume}:${value.identity.fileId}:${createHash('sha256').update(value.bytes).digest('hex')}:${value.bytes.length}`;};
 const ensureDirectory=async file=>owner.ensureDirectory(checked(file));
 const missing=async action=>{try{return await action();}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const handles=new Set();
 const open=async(file,flags)=>{
  checked(file);if(flags!=='a')throw failure('private_windows_journal_open_invalid');
  let proof=await missing(()=>owner.largeFile(file));
  if(proof&&proof.size>MAX_FILE_BYTES)throw failure('private_windows_journal_file_too_large');
  let queued=[],queuedBytes=0,chain=Promise.resolve(),closed=false,failed;
  const sync=()=>{
   const operation=chain.then(async()=>{
    if(failed)throw failed;
    if(!queuedBytes)return;
    const bytes=Buffer.concat(queued,queuedBytes);queued=[];queuedBytes=0;
    try{proof=await owner.append(file,bytes,{expected:proof?.token??'absent',offset:proof?.size??0,maximum:MAX_FILE_BYTES});}
    catch(error){failed=error;throw error;}
   });
   chain=operation.catch(()=>{});return operation;
  };
  const handle={
   stat:async()=>({size:(proof?.size??0)+queuedBytes}),
   write:async(value,_position,encoding)=>{
    if(closed||failed)throw failed??failure('private_windows_journal_closed');
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(value,encoding??'utf8');
    if(bytes.length>MAX_FILE_BYTES||(proof?.size??0)+queuedBytes+bytes.length>MAX_FILE_BYTES)throw failure('private_windows_journal_file_too_large');
    queued.push(bytes);queuedBytes+=bytes.length;
    if(queuedBytes>=BATCH_BYTES)await sync();
   },
   sync,
   close:async()=>{await sync();closed=true;handles.delete(handle);},
  };
  handles.add(handle);return handle;
 };
 const api={...metadata,
  mkdir:ensureDirectory,
  mkdtemp:async prefix=>{checked(prefix);const file=prefix+randomUUID();await ensureDirectory(file);return file;},
  readFile:async(file,options)=>{const {bytes}=await read(file);const encoding=typeof options==='string'?options:options?.encoding;return encoding?bytes.toString(encoding):bytes;},
  writeFile:async(file,bytes,options={})=>{
   checked(file);const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes,options.encoding??'utf8');
   if(options.flag==='wx'){
    if(await missing(()=>read(file)))throw failure('EEXIST');
    await owner.write(file,data,{expected:null});return;
   }
   await owner.write(file,data);
  },
  open,
  rm:async(file,options={})=>{
   checked(file);const stat=await missing(()=>metadata.lstat(file));if(!stat){if(options.force)return;throw failure('ENOENT');}
   if(options.expectedBytes&&!stat.isFile())throw failure('private_windows_publication_conflict');
   if(stat.isDirectory()){if(!options.recursive)throw failure('EISDIR');await owner.removeTree(file,await owner.tree(file));return;}
   const previous=options.expectedBytes?proofs.get(options.expectedBytes):await missing(()=>read(file));
   if(options.expectedBytes&&!previous)throw failure('private_windows_journal_proof_required');
   if(previous)await owner.delete(file,{expected:previous});else if(!options.force)throw failure('ENOENT');
  },
  rename:async(source,destination,options={})=>{
   checked(source);checked(destination);const stat=await metadata.lstat(source);
   if(options.expectedBytes&&!stat.isFile())throw failure('private_windows_publication_conflict');
   if(stat.isDirectory()){await owner.renameTree(source,destination,await owner.tree(source));return;}
   const expected=options.expectedBytes?tokenFor(options.expectedBytes):(await owner.largeFile(source)).token;await owner.renameFile(source,destination,expected);
  },
  truncate:async(file,length,options={})=>{checked(file);const expected=options.expectedBytes?tokenFor(options.expectedBytes):(await owner.largeFile(file)).token;const result=await owner.truncate(file,length,expected);if(options.expectedBytes)updated.set(options.expectedBytes,result.token);},
 };
 return {fs:api,
  createReadStream:file=>Readable.from((async function*(){yield (await read(file)).bytes;})()),
  flush:async()=>{for(const handle of handles)await handle.sync();},
 };
}
