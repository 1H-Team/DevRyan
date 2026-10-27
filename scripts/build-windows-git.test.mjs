import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {hydrateWindowsGit,readWindowsGitZip,windowsGitMetadata,WINDOWS_GIT_PINS} from './build-windows-git.mjs';
const AdmZip=createRequire(new URL('../packages/web/package.json',import.meta.url))('adm-zip');
const fixture=async callback=>{const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-mingit-')));try{await callback(root);}finally{await fs.rm(root,{recursive:true,force:true});}};

test('pinned standard MinGit covers native x64 and ARM64 with exact official complete archive origin',()=>{
 assert.equal(windowsGitMetadata('x64').executable,'git/cmd/git.exe');assert.equal(windowsGitMetadata('arm64').executable,'git/cmd/git.exe');
 assert.equal(WINDOWS_GIT_PINS.x64.files,373);assert.equal(WINDOWS_GIT_PINS.arm64.files,499);
 assert.equal(WINDOWS_GIT_PINS.x64.archiveSha256,'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be');
 assert.equal(WINDOWS_GIT_PINS.arm64.archiveSha256,'38b33dc6024026e3315cf88ab2cfea65205bbd7bb3a8e824bd21c8ad4fe609a7');
 for(const arch of [undefined,'ia32','constructor','__proto__'])assert.throws(()=>windowsGitMetadata(arch),{code:'windows_git_architecture_invalid'});
});
test('foreign architectures reject before filesystem/download activity',async()=>{
 for(const arch of [undefined,'ia32','constructor','__proto__'])await assert.rejects(hydrateWindowsGit({repository:'/absent',arch,fetchImpl:()=>{throw Error('download must not run');}}),{code:'windows_git_architecture_invalid'});
});
test('ZIP decoding preserves ordinary bytes but refuses aliases, links, malformed and oversized entries',()=>{
 const zip=new AdmZip();zip.addFile('cmd/git.exe',Buffer.from('fixture bytes'));zip.addFile('LICENSE.txt',Buffer.from('license'));
 const entries=readWindowsGitZip(zip.toBuffer());assert.equal(entries.length,2);assert.equal(entries.find(row=>row.name==='cmd/git.exe').contents.toString(),'fixture bytes');
 for(const name of ['../escape','C:/escape','bad\\escape','name.','NUL.txt','CONOUT$','LPT²','/absolute']){
  const invalid=new AdmZip();invalid.addFile('entry',Buffer.from('invalid'));invalid.getEntry('entry').entryName=name;assert.throws(()=>readWindowsGitZip(invalid.toBuffer()));
 }
 const alias=new AdmZip();alias.addFile('cmd/git.exe',Buffer.from('one'));alias.addFile('CMD/GIT.EXE',Buffer.from('two'));assert.throws(()=>readWindowsGitZip(alias.toBuffer()),{code:'windows_git_archive_path_invalid'});
 const linked=new AdmZip();linked.addFile('link',Buffer.from('target'));linked.getEntry('link').header.attr=(0o120777<<16)>>>0;assert.throws(()=>readWindowsGitZip(linked.toBuffer()),{code:'windows_git_archive_type_invalid'});
 assert.throws(()=>readWindowsGitZip(Buffer.from('not a ZIP')));assert.throws(()=>readWindowsGitZip(Buffer.alloc(64*1024*1024+1)),{code:'windows_git_archive_bound'});
});
test('corrupt download publishes no payload and cleans its temporary bytes',async()=>fixture(async repository=>{
 let downloads=0;await assert.rejects(hydrateWindowsGit({repository,arch:'x64',fetchImpl:async(url,options)=>{downloads++;assert.equal(url,WINDOWS_GIT_PINS.x64.archiveUrl);assert.equal(options.redirect,'follow');return new Response('corrupt archive');}}),{code:'windows_git_archive_digest_invalid'});
 assert.equal(downloads,1);assert.deepEqual(await fs.readdir(path.join(repository,'.cache/windows-native/x64/git-resource')),[]);
}));
test('changed cache/evidence and aliased roots remain intact without an unreviewed replacement',async()=>fixture(async repository=>{
 const parent=path.join(repository,'.cache/windows-native/x64/git-resource'),payload=path.join(parent,'payload'),git=path.join(payload,'git');await fs.mkdir(git,{recursive:true});await fs.writeFile(path.join(git,'LICENSE.txt'),'changed cached file');
 await fs.writeFile(path.join(payload,'inventory.json'),JSON.stringify({windowsGit:windowsGitMetadata('x64'),files:[]}));
 await assert.rejects(hydrateWindowsGit({repository,arch:'x64',fetchImpl:()=>{throw Error('must not download');}}),{code:'windows_git_payload_invalid'});
 assert.equal(await fs.readFile(path.join(git,'LICENSE.txt'),'utf8'),'changed cached file');
 const target=path.join(repository,'aliased');await fs.mkdir(target);await fs.mkdir(path.join(repository,'.cache/windows-native/arm64'),{recursive:true});await fs.symlink(target,path.join(repository,'.cache/windows-native/arm64/git-resource'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(hydrateWindowsGit({repository,arch:'arm64',fetchImpl:()=>{throw Error('must not download');}}),{code:'windows_git_root_invalid'});assert.deepEqual(await fs.readdir(target),[]);
}));
