import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {REVIEWED_WINDOWS_EXECUTABLES,REVIEWED_WINDOWS_LIBSQL_COMMIT,REVIEWED_WINDOWS_LIBSQL_INPUTS,REVIEWED_WINDOWS_LIBSQL_EVIDENCE,reviewedWindowsRuntimeAsset,verifyWindowsLibsqlEvidence,assertWindowsBinaryArchitecture,readWindowsLibsqlEvidence} from './reviewed-windows-assets.js';

test('Windows runtime discovery accepts only the original asset bytes for its architecture',()=>{
 for(const arch of ['x64','arm64'])for(const kind of ['ast','claude']){
  const pin=REVIEWED_WINDOWS_EXECUTABLES[arch][kind];
  const row={role:'asset',path:`DevRyan-${kind==='ast'?'ast-grep':'Claude'}-win32-${arch}.exe`,size:pin.size,sha256:pin.sha256,mode:0o755,signing:{mode:'unsigned'}};
  expect(reviewedWindowsRuntimeAsset(row,arch)).toBe(kind);
  for(const changed of [{role:'controller'},{sha256:'0'.repeat(64)},{size:pin.size-1},{mode:0o644},{signing:{mode:'release'}}])expect(()=>reviewedWindowsRuntimeAsset({...row,...changed},arch)).toThrow();
  expect(reviewedWindowsRuntimeAsset(row,arch==='x64'?'arm64':'x64')).toBe(null);
 }
 for(const arch of ['constructor','__proto__','ia32'])expect(()=>reviewedWindowsRuntimeAsset({},arch)).toThrow();
});

test('Windows source evidence binds the original libsql compiler inputs and both actual ABI checks',()=>{
 for(const arch of ['x64','arm64']){
  const target=`${arch==='x64'?'x86_64':'aarch64'}-pc-windows-msvc`;
  const evidence={schema:1,status:'asset-candidate-passed',stage:'complete',version:'0.5.29',sourceCommit:REVIEWED_WINDOWS_LIBSQL_COMMIT,target,toolchain:`1.85.1-${target}`,cmakeGenerator:'NMake Makefiles',inputs:REVIEWED_WINDOWS_LIBSQL_INPUTS,inputSha256:REVIEWED_WINDOWS_LIBSQL_INPUTS,binary:`DevRyan-libsql-win32-${arch}.node`,sha256:'a'.repeat(64),smokes:['node','bun'].map(runtime=>({status:'passed',platform:'win32',arch,runtime,version:runtime==='bun'?'1.3.14':'22.23.3'}))};
  expect(verifyWindowsLibsqlEvidence(evidence,arch)).toBe(evidence);
  for(const change of [{sourceCommit:'0'.repeat(40)},{inputSha256:{...evidence.inputSha256,'Cargo.lock':'0'.repeat(64)}},{target:'x86_64-linux-gnu'},{toolchain:'latest'},{cmakeGenerator:'Visual Studio'},{smokes:evidence.smokes.slice(0,1)},{smokes:evidence.smokes.map(row=>({...row,status:'failed'}))},{sha256:'not-a-digest'},{binary:'../foreign.node'}])expect(()=>verifyWindowsLibsqlEvidence({...evidence,...change},arch)).toThrow();
  const row={role:'asset',path:REVIEWED_WINDOWS_LIBSQL_EVIDENCE,size:512,mode:0o644,signing:{mode:'unsigned'}};
  expect(reviewedWindowsRuntimeAsset(row,arch)).toBe('evidence');
  for(const size of [0,65537])expect(()=>reviewedWindowsRuntimeAsset({...row,size},arch)).toThrow();
 }
});

test('native PE inspection refuses the opposite architecture and malformed headers',()=>{
 for(const arch of ['x64','arm64']){
  const image=Buffer.alloc(128);image.write('MZ');image.writeUInt32LE(64,60);image.write('PE\0\0',64,'binary');image.writeUInt16LE(arch==='x64'?0x8664:0xaa64,68);
  expect(()=>assertWindowsBinaryArchitecture(image,arch)).not.toThrow();
  expect(()=>assertWindowsBinaryArchitecture(image,arch==='x64'?'arm64':'x64')).toThrow();
  for(const value of [image.subarray(0,63),image.subarray(0,69),Buffer.alloc(128)])expect(()=>assertWindowsBinaryArchitecture(value,arch)).toThrow();
 }
});

test('libsql source evidence cannot change between inventory hashing and parsing',async()=>{
 const base=path.resolve('../../.cache/test-fixtures');await fs.mkdir(base,{recursive:true});
 const directory=await fs.mkdtemp(path.join(base,'libsql-evidence-')),file=path.join(directory,REVIEWED_WINDOWS_LIBSQL_EVIDENCE);
 const evidence={schema:1,status:'asset-candidate-passed',stage:'complete',version:'0.5.29',sourceCommit:REVIEWED_WINDOWS_LIBSQL_COMMIT,target:'x86_64-pc-windows-msvc',toolchain:'1.85.1-x86_64-pc-windows-msvc',cmakeGenerator:'NMake Makefiles',inputs:REVIEWED_WINDOWS_LIBSQL_INPUTS,inputSha256:REVIEWED_WINDOWS_LIBSQL_INPUTS,binary:'DevRyan-libsql-win32-x64.node',sha256:'a'.repeat(64),smokes:['node','bun'].map(runtime=>({status:'passed',platform:'win32',arch:'x64',runtime,version:runtime==='bun'?'1.3.14':'22.23.3'}))};
 const bytes=Buffer.from(JSON.stringify(evidence)),row={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 try{
  await fs.writeFile(file,bytes);expect(await readWindowsLibsqlEvidence(file,row,'x64')).toEqual(evidence);
  // Both receipts have valid source/ABI metadata and equal byte lengths.
  // Only the inventoried receipt may be parsed.
  const changed={...evidence,smokes:evidence.smokes.map(probe=>probe.runtime==='node'?{...probe,version:'22.23.4'}:probe)};
  await fs.writeFile(file,JSON.stringify(changed));await expect(readWindowsLibsqlEvidence(file,row,'x64')).rejects.toThrow();
  await fs.writeFile(file,Buffer.alloc(65537));await expect(readWindowsLibsqlEvidence(file,row,'x64')).rejects.toThrow();
  await fs.writeFile(file,bytes);await expect(readWindowsLibsqlEvidence(file,{...row,size:65537},'x64')).rejects.toThrow();
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
