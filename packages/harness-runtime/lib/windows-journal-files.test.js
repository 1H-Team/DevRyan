import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createDiagnosticJournal} from './journal.js';
import {createWindowsJournalFiles} from './windows-journal-files.js';
import {createDiagnosticSanitizer} from './sanitizer.js';
import {createWindowsPrivateFilesFixture} from './windows-private-files.fixture.js';
async function fixture(action){
 const base=path.resolve('../../.cache/test-fixtures');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'windows-journal-'));
 const native=createWindowsPrivateFilesFixture(root),directory=path.join(root,'journal'),sanitizer=createDiagnosticSanitizer({homeDir:root,dataDir:root});
 const create=(options={})=>createDiagnosticJournal({directory,sanitizer,platform:'win32',windowsOwner:native.owner,fs:native.metadata,trim:false,maxAgeMs:Number.MAX_SAFE_INTEGER,...options});
 try{await action({...native,root,directory,create});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('Windows journal batches native appends while live readers and gzip preserve records',()=>fixture(async({create,calls})=>{
 const journal=create();for(let i=0;i<80;i++)expect(journal.enqueue({type:'lifecycle',event:'fixture',at:i+1})).toBe(true);
 await journal.flush();expect((await journal.readRecords()).map(row=>row.at)).toEqual(Array.from({length:80},(_,i)=>i+1));
 const appends=calls.filter(row=>row[0]==='append');expect(appends.length).toBeLessThan(8);expect(appends.every(row=>row[2]<=16*1024*1024)).toBe(true);
 await journal.flush({rotate:true});expect((await journal.readRecords()).length).toBe(80);expect(calls.some(row=>row[0]==='write'&&row[1].endsWith('.ndjson.gz'))).toBe(true);expect(calls.some(row=>row[0]==='delete'&&row[1].endsWith('.ndjson.open'))).toBe(true);await journal.close();
}));
test('Windows crash recovery truncates incomplete legacy bytes and uses native rename',()=>fixture(async({owner,directory,create,calls})=>{
 await owner.ensureDirectory(directory);const file=path.join(directory,'1-1.ndjson.open'),row={type:'lifecycle',at:1,event:'legacy'};
 await owner.append(file,Buffer.from(JSON.stringify(row)+'\n{"partial"'),{expected:'absent',offset:0,maximum:16*1024*1024});
 const journal=create();await journal.initialize();expect((await journal.readRecords()).filter(value=>value.event==='legacy')).toEqual([row]);expect(calls.some(value=>value[0]==='truncate'&&value[1]===file)).toBe(true);expect(calls.some(value=>value[0]==='renameFile'&&value[1]===file)).toBe(true);await journal.close();
}));
test('Windows clear since publishes a private staged tree and keeps earlier records',()=>fixture(async({create,calls})=>{
 const journal=create();journal.enqueue({type:'lifecycle',event:'old',at:1});journal.enqueue({type:'lifecycle',event:'new',at:10});await journal.flush();
 await journal.clear({since:5});expect((await journal.readRecords()).filter(row=>row.type==='lifecycle').map(row=>row.event)).toEqual(['old']);expect(calls.filter(row=>row[0]==='renameTree').length).toBe(2);expect(calls.some(row=>row[0]==='removeTree'&&row[1].includes('.clear-backup-'))).toBe(true);
 await journal.clear();expect(await journal.readRecords()).toEqual([]);await journal.close();
}));
test('Windows append durability refusal is reported and cannot publish a gzip success',()=>fixture(async({owner,directory,create})=>{
 const original=owner.append;let reject=true;owner.append=async(...args)=>{if(reject){reject=false;throw Object.assign(new Error('private_windows_namespace_durability_unavailable'),{code:'private_windows_namespace_durability_unavailable'});}return original(...args);};
 const journal=create();journal.enqueue({type:'lifecycle',event:'failure',at:1});await expect(journal.flush()).rejects.toMatchObject({code:'private_windows_namespace_durability_unavailable'});await journal.close().catch(()=>{});expect((await fs.readdir(path.join(directory,'runtime'))).some(name=>name.endsWith('.ndjson.gz'))).toBe(false);
}));
test('Windows journal refuses a missing native operation before creating state',()=>fixture(async({create,owner,directory})=>{
 owner.renameFile=undefined;expect(()=>create()).toThrow('private_windows_journal_authority_unavailable');await expect(fs.lstat(directory)).rejects.toMatchObject({code:'ENOENT'});
}));
test('Windows rotation never deletes an open segment changed after its captured read',()=>fixture(async({owner,directory,create})=>{
 const journal=create();journal.enqueue({type:'lifecycle',event:'original',at:1});await journal.flush();
 const write=owner.write;let changed=false;
 owner.write=async(file,...args)=>{const result=await write(file,...args);if(!changed&&file.endsWith('.ndjson.gz')){changed=true;const open=file.replace(/\.ndjson\.gz$/,'.ndjson.open'),proof=await owner.largeFile(open);await owner.append(open,Buffer.from('{"type":"lifecycle","event":"late","at":2}\n'),{expected:proof.token,offset:proof.size,maximum:16*1024*1024});}return result;};
 await expect(journal.flush({rotate:true})).rejects.toMatchObject({code:'private_windows_publication_conflict'});
 const name=(await fs.readdir(path.join(directory,'runtime'))).find(value=>value.endsWith('.ndjson.open'));expect(name).toBeDefined();expect(await fs.readFile(path.join(directory,'runtime',name),'utf8')).toContain('"late"');await journal.close();
}));

test('captured journal file proof cannot delete or rename a replacement directory',()=>fixture(async({owner,directory,metadata,calls})=>{
 await owner.ensureDirectory(directory);const api=createWindowsJournalFiles({directory,owner,metadata}).fs;
 for(const action of ['remove','rename']){
  const source=path.join(directory,`${action}.ndjson.open`);await owner.write(source,Buffer.from('original'));
  const captured=await api.readFile(source);await owner.delete(source);await owner.ensureDirectory(source);
  const preserved=path.join(source,'preserved.txt');await owner.write(preserved,Buffer.from('replacement'));
  const before=calls.length;
  await expect(action==='remove'?api.rm(source,{force:true,expectedBytes:captured}):api.rename(source,source+'.closed',{expectedBytes:captured})).rejects.toMatchObject({code:'private_windows_publication_conflict'});
  expect(calls.slice(before).some(row=>['removeTree','renameTree'].includes(row[0]))).toBe(false);expect(await fs.readFile(preserved,'utf8')).toBe('replacement');
 }
}));
