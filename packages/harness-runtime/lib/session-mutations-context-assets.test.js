import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';
import {createSessionMutationRuntime} from './session-mutations.js';
import {git} from './session-changes-git.js';
const repository=path.resolve(import.meta.dirname,'../../..');

test('fixed context-image policy survives reopen, rejects replay changes and refuses ALL publication on unrelated output',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/context-policy-'));
 try{
  const directory=path.join(root,'project'),storage=path.join(root,'ledger');await fs.mkdir(directory);await git(directory,['init','--quiet']);
  await fs.writeFile(path.join(directory,'keep.txt'),'Original bytes');
  const input={directory,sessionID:'ses_context',userMessageID:'msg_user',messageID:'msg_user',callID:'context_images_owned',kind:'process',publicationPolicy:'context-images'};
  const runtime=createSessionMutationRuntime({directory:storage});const reserved=await runtime.reserve(input);
  expect(reserved.publicationPolicy).toBe('context-images');
  const reopened=createSessionMutationRuntime({directory:storage});expect((await reopened.leaseForCall(input)).publicationPolicy).toBe('context-images');
  await expect(reopened.reserve({...input,publicationPolicy:undefined})).rejects.toMatchObject({code:'capture_identity_mismatch'});
  await expect(reopened.reserve({...input,callID:'wrong_policy',publicationPolicy:'caller-paths'})).rejects.toMatchObject({code:'invalid_publication_policy'});
  const lease=await reopened.prepare(reserved);await reopened.claimLease({directory,token:lease.token,kind:'process'});
  await fs.mkdir(path.join(lease.workingDirectory,'.opencode/images/ses_context'),{recursive:true});
  await fs.writeFile(path.join(lease.workingDirectory,'.opencode/images/ses_context/image.png'),'Owned image');
  await fs.writeFile(path.join(lease.workingDirectory,'keep.txt'),'Forbidden change');
  await expect(reopened.finish({directory,token:lease.token})).rejects.toMatchObject({code:'context_asset_output_denied'});
  expect(await fs.readFile(path.join(directory,'keep.txt'),'utf8')).toBe('Original bytes');
  expect(await fs.stat(path.join(directory,'.opencode/images/ses_context/image.png')).catch(()=>null)).toBeNull();
  expect((await reopened.leaseForCall(input)).state).toBe('ready');
  await fs.writeFile(path.join(lease.workingDirectory,'keep.txt'),'Original bytes');
  await fs.writeFile(path.join(lease.workingDirectory,'.opencode/.gitignore'),'images/\n');
  await fs.writeFile(path.join(lease.workingDirectory,'.opencode/.gitignore.oh-my-opencode-slim-legacy'),'*\n');
  const result=await reopened.finish({directory,token:lease.token});
  expect(result.files.map(file=>file.path).sort()).toEqual(['.opencode/.gitignore','.opencode/.gitignore.oh-my-opencode-slim-legacy','.opencode/images/ses_context/image.png']);
  expect(await fs.readFile(path.join(directory,'.opencode/images/ses_context/image.png'),'utf8')).toBe('Owned image');
 }finally{await fs.rm(root,{recursive:true,force:true});}
},30_000);

test('context-image publication is fixed to its actual working subdirectory and never publishes symlinks',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/context-subdir-'));
 try{
  const project=path.join(root,'project'),directory=path.join(project,'nested');await fs.mkdir(directory,{recursive:true});await git(project,['init','--quiet']);
  const runtime=createSessionMutationRuntime({directory:path.join(root,'ledger')});
  const reserved=await runtime.reserve({directory,sessionID:'ses_subdir',userMessageID:'msg_user',messageID:'msg_user',callID:'context_images_subdir',kind:'process',publicationPolicy:'context-images'});
  const lease=await runtime.prepare(reserved);await runtime.claimLease({directory,token:lease.token,kind:'process'});
  await fs.mkdir(path.join(lease.viewDirectory,'.opencode/images'),{recursive:true});
  await fs.writeFile(path.join(lease.viewDirectory,'.opencode/images/incorrect-root.png'),'Refused root output');
  await expect(runtime.finish({directory,token:lease.token})).rejects.toMatchObject({code:'context_asset_output_denied'});
  await fs.rm(path.join(lease.viewDirectory,'.opencode'),{recursive:true});
  await fs.mkdir(path.join(lease.workingDirectory,'.opencode/images'),{recursive:true});
  await fs.symlink('/outside-private-view',path.join(lease.workingDirectory,'.opencode/images/link.png'));
  await expect(runtime.finish({directory,token:lease.token})).rejects.toMatchObject({code:'context_asset_output_denied'});
  await fs.rm(path.join(lease.workingDirectory,'.opencode/images/link.png'));
  await fs.writeFile(path.join(lease.workingDirectory,'.opencode/images/owned.png'),'Exact subdirectory image');
  const result=await runtime.finish({directory,token:lease.token});expect(result.files.map(file=>file.path)).toEqual(['nested/.opencode/images/owned.png']);
  expect(await fs.readFile(path.join(directory,'.opencode/images/owned.png'),'utf8')).toBe('Exact subdirectory image');
  expect(await fs.stat(path.join(project,'.opencode')).catch(()=>null)).toBeNull();
 }finally{await fs.rm(root,{recursive:true,force:true});}
},30_000);

test('interview policy seals one Markdown target durably and refuses any unrelated contribution before publication',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/interview-policy-'));
 try{
  const directory=path.join(root,'project'),storage=path.join(root,'ledger');await fs.mkdir(directory);await git(directory,['init','--quiet']);
  await fs.writeFile(path.join(directory,'keep.txt'),'Preserve original');
  const input={directory,sessionID:'ses_interview',userMessageID:'msg_user',messageID:'msg_user',callID:'owned_interview_document',kind:'process',publicationPolicy:'interview-document',publicationPath:'interview/exact.md'};
  const runtime=createSessionMutationRuntime({directory:storage}),reserved=await runtime.reserve(input),reopened=createSessionMutationRuntime({directory:storage});
  expect((await reopened.leaseForCall(input)).publicationPath).toBe('interview/exact.md');
  await expect(reopened.reserve({...input,publicationPath:'interview/other.md'})).rejects.toMatchObject({code:'capture_identity_mismatch'});
  await expect(reopened.reserve({...input,callID:'invalid',publicationPath:'.GiT/exact.md'})).rejects.toMatchObject({code:'invalid_publication_policy'});
  const lease=await reopened.prepare(reserved);await reopened.claimLease({directory,token:lease.token,kind:'process'});
  await fs.mkdir(path.join(lease.workingDirectory,'interview'));await fs.writeFile(path.join(lease.workingDirectory,input.publicationPath),'Exact interview');
  await fs.writeFile(path.join(lease.workingDirectory,'keep.txt'),'Refused extra change');
  await expect(reopened.finish({directory,token:lease.token})).rejects.toMatchObject({code:'interview_document_output_denied'});
  expect(await fs.stat(path.join(directory,input.publicationPath)).catch(()=>null)).toBeNull();expect(await fs.readFile(path.join(directory,'keep.txt'),'utf8')).toBe('Preserve original');
  await fs.writeFile(path.join(lease.workingDirectory,'keep.txt'),'Preserve original');
  expect((await reopened.finish({directory,token:lease.token})).files.map(file=>file.path)).toEqual([input.publicationPath]);
  expect(await fs.readFile(path.join(directory,input.publicationPath),'utf8')).toBe('Exact interview');
 }finally{await fs.rm(root,{recursive:true,force:true});}
},30_000);
