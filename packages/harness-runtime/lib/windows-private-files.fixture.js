import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
/** Disposable fixture only; models native CAS without Windows or installed state. */
export function createWindowsPrivateFilesFixture(root){
 const calls=[],identities=new Map(),fail=code=>Object.assign(new Error(code),{code}),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const owned=file=>{if(file!==root&&!file.startsWith(root+path.sep))throw fail('fixture_scope_invalid');};
 const read=async file=>{owned(file);const bytes=await fs.readFile(file);if(!identities.has(file))throw fail('private_windows_file_unverified');return {identity:{volume:'1'.repeat(16),fileId:identities.get(file)},bytes};};
 const token=value=>`${value.identity.volume}:${value.identity.fileId}:${hash(value.bytes)}:${value.bytes.length}`;
 const largeFile=async file=>{const value=await read(file);return {token:token(value),size:value.bytes.length};};
 const before=async file=>{try{return await read(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const check=async(file,expected)=>{const value=await before(file);if((value?token(value):'absent')!==expected)throw fail('private_windows_publication_conflict');return value;};
 const tree=async target=>{owned(target);if(!identities.has(target))throw fail('private_windows_file_unverified');const digest=createHash('sha256');const walk=async directory=>{for(const entry of(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,entry.name);if(!identities.has(file)||entry.isSymbolicLink())throw fail('private_windows_file_unverified');digest.update(path.relative(target,file));digest.update(identities.get(file));if(entry.isDirectory())await walk(file);else digest.update(await fs.readFile(file));}};await walk(target);return '1'.repeat(16)+':'+identities.get(target)+':'+digest.digest('hex');};
 const remap=(source,target)=>{for(const [file,id]of [...identities])if(file===source||file.startsWith(source+path.sep)){identities.delete(file);if(target)identities.set(target+file.slice(source.length),id);}};
 const owner={launcher:'fixture-verified-launcher',
  read:async file=>{calls.push(['read',file]);return read(file);},largeFile:async file=>{calls.push(['largeFile',file]);return largeFile(file);},recover:async file=>{calls.push(['recover',file]);return null;},
  ensureDirectory:async dir=>{owned(dir);calls.push(['ensureDirectory',dir]);await fs.mkdir(dir,{recursive:true,mode:0o700});let current=dir;while(current===root||current.startsWith(root+path.sep)){if(!identities.has(current))identities.set(current,randomUUID().replaceAll('-',''));if(current===root)break;current=path.dirname(current);}return {type:'directory'};},
  write:async(file,bytes,options={})=>{owned(file);calls.push(['write',file,bytes.length]);if(options.expected!==undefined)await check(file,options.expected===null?'absent':token(options.expected));await fs.writeFile(file,bytes,{mode:0o600});identities.set(file,randomUUID().replaceAll('-',''));return {status:'published',namespaceFlushed:true};},
  delete:async(file,options={})=>{owned(file);calls.push(['delete',file]);if(options.expected!==undefined)await check(file,options.expected===null?'absent':token(options.expected));await fs.rm(file,{force:true});identities.delete(file);return {status:'deleted',namespaceFlushed:true};},
  append:async(file,bytes,{expected,offset,maximum})=>{owned(file);calls.push(['append',file,bytes.length,offset]);const value=await check(file,expected);if((value?.bytes.length??0)!==offset||offset+bytes.length>maximum)throw fail('private_windows_publication_conflict');const handle=await fs.open(file,value?'a':'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}if(!value)identities.set(file,randomUUID().replaceAll('-',''));return largeFile(file);},
  tree:async file=>{calls.push(['tree',file]);return tree(file);},
  renameTree:async(source,target,expected)=>{owned(target);calls.push(['renameTree',source,target]);if(await tree(source)!==expected)throw fail('private_windows_publication_conflict');await fs.rename(source,target);remap(source,target);return tree(target);},
  removeTree:async(target,expected)=>{calls.push(['removeTree',target]);if(await tree(target)!==expected)throw fail('private_windows_publication_conflict');await fs.rm(target,{recursive:true});remap(target,null);return expected;},
  renameFile:async(source,target,expected)=>{owned(target);calls.push(['renameFile',source,target]);await check(source,expected);if(await before(target))throw fail('EEXIST');await fs.rename(source,target);remap(source,target);return largeFile(target);},
  truncate:async(file,length,expected)=>{calls.push(['truncate',file,length]);const value=await check(file,expected);if(!Number.isSafeInteger(length)||length<0||length>value.bytes.length)throw fail('fixture_truncate_invalid');await fs.truncate(file,length);return largeFile(file);},
  streamFile:async(source,target,{expectedSha256,expectedSize})=>{calls.push(['streamFile',source,target]);const bytes=await fs.readFile(source);if(bytes.length!==expectedSize||hash(bytes)!==expectedSha256)throw fail('fixture_source_changed');await check(target,'absent');await owner.write(target,bytes,{expected:null});return largeFile(target);},prune:async()=>({namespaceFlushed:true,retained:0,pruned:0}),
 };
 const metadata=new Proxy(fs,{get(target,key){if(['mkdir','mkdtemp','writeFile','open','rm','rename','truncate','readFile'].includes(key))return ()=>{throw fail(`fixture_node_fallback_${key}`);};return Reflect.get(target,key);}});
 return {owner,calls,metadata,identities};
}
