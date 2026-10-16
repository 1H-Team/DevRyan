import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import {createNativeClaudeSecurityHome} from './native-claude-security-home.js';
import {createNativeClaudeCredentialOwner,migrateNativeClaudeLegacyFences} from './native-provider-runtime-owner.js';
import {createNativeClaudeEnrollmentOwner} from './native-claude-enrollment.js';
import {emptyClaudeLifecycle,transitionClaudeLifecycle,claudeRecordFingerprint,claudeGrantFingerprint} from './native-claude-lifecycle.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {rewriteReviewedClaudeCredentials} from './reviewed-claude-transform.js';

const roots=[],securityHome='/constructor/os-user-home',account=userInfo().username;
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const source=await fs.readFile(new URL('../../../../runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-khhjyk04.js',import.meta.url));
const module=await import('data:text/javascript;base64,'+Buffer.from(rewriteReviewedClaudeCredentials(source)).toString('base64'));
async function fixture({expired=false}={}){
 const base=await fs.realpath(path.resolve('../../.cache/v2-validation')),root=await fs.mkdtemp(path.join(base,'claude-security-home-'));roots.push(root);
 const controlRoot=path.join(root,'control'),home=path.join(root,'home');await fs.mkdir(controlRoot,{mode:0o700});await fs.mkdir(home,{mode:0o700});
 const parent=path.join(controlRoot,'claude-enrollments');await fs.mkdir(parent,{mode:0o700});
 const enrollmentID=randomUUID(),configDirectory=path.join(parent,enrollmentID);await fs.mkdir(configDirectory,{mode:0o700});
 const binding={profileID:`devryan-${enrollmentID}`,enrollmentID,generation:randomUUID(),configDirectory,service:claudeKeychainService(configDirectory,home)};
 const credential={claudeAiOauth:{accessToken:'fixture-access',refreshToken:'fixture-grant',expiresAt:Date.now()+(expired?1000:3600000)}};
 let state=transitionClaudeLifecycle(emptyClaudeLifecycle(),0,{kind:'enroll',account:{...binding,grantFingerprint:claudeGrantFingerprint(credential.claudeAiOauth.refreshToken),recordFingerprint:claudeRecordFingerprint(credential)}}),valid=true,afterWrite=async()=>{},exchanges=0,readState=async()=>{};
 const records=new Map([[binding.service,credential]]),commands=[];
 const execute=async(file,args,options)=>{
  commands.push({file,operation:args[0],service:args[args.indexOf('-s')+1],home:options.env?.HOME,signal:options.signal});
  const service=args[args.indexOf('-s')+1];
  if(args[0]==='find-generic-password'){if(!records.has(service))throw Object.assign(Error('missing'),{code:44});return{stdout:args.includes('-w')?JSON.stringify(records.get(service)):''};}
  if(args[0]==='delete-generic-password'){records.delete(service);return{stdout:''};}
  if(!args.includes('-U')&&records.has(service))throw Object.assign(Error('collision'),{code:45});
  records.set(service,JSON.parse(args[args.indexOf('-w')+1]));await afterWrite();return{stdout:''};
 };
 const lifecycle={read:async()=>{await readState();return structuredClone(state);},transition:async(revision,operation)=>{state=transitionClaudeLifecycle(state,revision,operation);return structuredClone(state);}};
 const check=async()=>{if(!valid)throw Error('fixture revoked');};
 const bindOwnedCommand=createNativeClaudeSecurityHome({controlRoot,home,securityHome,execute});
 const options={profiles:[{id:binding.profileID,type:'claude-max',claudeConfigDir:configDirectory,keychainService:binding.service}],home,ownedControlRoot:controlRoot,bindOwnedCommand,
  withMutationQueue:action=>action(),loadModule:async()=>module,lifecycle,backend:{execFile:execute,fetch:async()=>{exchanges++;return Response.json({access_token:'fixture-next',refresh_token:'fixture-next-grant',expires_in:3600});}}};
 return{controlRoot,home,binding,commands,records,execute,lifecycle,options,bindOwnedCommand,check,owner:createNativeClaudeCredentialOwner(options),
  context:()=>({recheck:check,retried:new Set()}),revoke:()=>{valid=false;},afterWrite:fn=>{afterWrite=fn;},onReadState:fn=>{readState=fn;},get state(){return state;},set state(value){state=value;},get exchanges(){return exchanges;}};
}

test('exact private service receives command-local HOME, preserving original arguments and global environment',async()=>{
 const f=await fixture(),originalHome=process.env.HOME,command=await f.bindOwnedCommand(f.binding,f.check);
 const args=['find-generic-password','-s',f.binding.service,'-a',account,'-w'];
 await command('/usr/bin/security',args,{env:{HOME:f.home,FIXTURE:'retained'}});
 expect(f.commands[0].home).toBe(securityHome);expect(args).toEqual(['find-generic-password','-s',f.binding.service,'-a',account,'-w']);expect(process.env.HOME).toBe(originalHome);
});

test.each(['default','hash-only','foreign-root','profile','generation','symlink','permissions','replaced'])('refuses %s binding before an OS command',async fault=>{
 const f=await fixture();let binding={...f.binding},command;
 if(fault==='default')binding.service='Claude Code-credentials';
 if(fault==='hash-only')binding.service='Claude Code-credentials-01234567';
 if(fault==='foreign-root')binding.configDirectory=path.join(f.home,binding.enrollmentID);
 if(fault==='profile')binding.profileID='public-profile';
 if(fault==='generation')binding.generation=['coerced'];
 if(fault==='symlink'){await fs.rename(binding.configDirectory,binding.configDirectory+'-original');await fs.symlink(binding.configDirectory+'-original',binding.configDirectory);}
 if(fault==='permissions')await fs.chmod(binding.configDirectory,0o755);
 if(fault==='replaced'){command=await f.bindOwnedCommand(binding,f.check);await fs.rename(binding.configDirectory,binding.configDirectory+'-original');await fs.mkdir(binding.configDirectory,{mode:0o700});}
 await expect((async()=>{command??=await f.bindOwnedCommand(binding,f.check);return command('/usr/bin/security',['find-generic-password','-s',binding.service,'-a',account],{});})()).rejects.toBeDefined();
 expect(f.commands).toHaveLength(0);
});

test.each([['/bin/security',['find-generic-password']],['/usr/bin/security',['list-keychains']],['/usr/bin/security',['find-generic-password','-s','Claude Code-credentials','-a',account]],['/usr/bin/security',['find-generic-password','-s','same','-a','foreign']],['/usr/bin/security',['delete-generic-password','-s','same','-a',account,'-w']]])('refuses foreign command %s',async(file,input)=>{
 const f=await fixture(),command=await f.bindOwnedCommand(f.binding,f.check),args=input.map(value=>value==='same'?f.binding.service:value);
 await expect(command(file,args,{})).rejects.toMatchObject({code:'native_claude_owned_store_invalid'});expect(f.commands).toHaveLength(0);
});

test('canonical lifecycle is proved before first credential read and recreated owner retains the exact service',async()=>{
 const f=await fixture();expect((await f.owner({profileID:f.binding.profileID,purpose:'request'},f.context())).accessToken).toBe('fixture-access');
 const restored=createNativeClaudeCredentialOwner(f.options);await restored({profileID:f.binding.profileID,purpose:'request'},f.context());
 expect(f.commands.every(command=>command.home===securityHome&&command.service===f.binding.service)).toBe(true);
 f.commands.length=0;f.state=emptyClaudeLifecycle();await expect(restored({profileID:f.binding.profileID,purpose:'request'},f.context())).rejects.toMatchObject({code:'native_claude_account_changed'});expect(f.commands).toHaveLength(0);
});

test('lifecycle or execution revocation while binding is awaited refuses before first read',async()=>{
 for(const revoke of ['lifecycle','execution']){
  const f=await fixture();let reads=0;
  f.onReadState(()=>{if(++reads===2){if(revoke==='lifecycle')f.state=emptyClaudeLifecycle();else f.revoke();}});
  await expect(f.owner({profileID:f.binding.profileID,purpose:'request'},f.context())).rejects.toBeDefined();expect(f.commands).toHaveLength(0);
 }
});

test('cancelled acquisition and deleted or changed generation cannot reuse an owned service',async()=>{
 for(const fault of ['cancel','deletion','generation']){
  const f=await fixture(),context=f.context();
  if(fault==='cancel'){const cancel=new AbortController();cancel.abort(Error('fixture stopped'));context.signal=cancel.signal;}
  if(fault==='deletion')f.state=transitionClaudeLifecycle(f.state,f.state.revision,{kind:'prepare-deletion',binding:f.binding,attemptID:randomUUID(),recordFingerprint:f.state.accounts[0].recordFingerprint,directoryDevice:null,directoryInode:null});
  if(fault==='generation'){let reads=0;f.onReadState(()=>{if(++reads===2)f.state={...f.state,accounts:f.state.accounts.map(row=>({...row,generation:randomUUID()}))};});}
  await expect(f.owner({profileID:f.binding.profileID,purpose:'request'},context)).rejects.toBeDefined();expect(f.commands).toHaveLength(0);
 }
});

test('uncertain original command keeps its promise until settlement and late revocation refuses its result',async()=>{
 const f=await fixture();let release,entered;
 const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const bind=createNativeClaudeSecurityHome({controlRoot:f.controlRoot,home:f.home,securityHome,execute:async()=>{entered();await held;return{stdout:'fixture-only'};}});
 const command=await bind(f.binding,f.check);let settled=false;
 const work=command('/usr/bin/security',['find-generic-password','-s',f.binding.service,'-a',account],{}).finally(()=>{settled=true;});
 await started;f.revoke();await Promise.resolve();expect(settled).toBe(false);release();await expect(work).rejects.toThrow('fixture revoked');
});

test('original renewal settles an exact prepared replacement after cancellation without new read authority',async()=>{
 const f=await fixture({expired:true}),cancel=new AbortController(),context={...f.context(),signal:cancel.signal};
 f.afterWrite(()=>cancel.abort(Error('fixture cancelled after write')));
 await expect(f.owner({profileID:f.binding.profileID,purpose:'request'},context)).rejects.toThrow('fixture cancelled after write');
 expect(f.exchanges).toBe(1);expect(f.state.unresolved).toEqual([]);expect(f.records.get(f.binding.service).claudeAiOauth.accessToken).toBe('fixture-next');
 const settlement=f.commands.filter(command=>command.operation==='find-generic-password'&&!command.signal);
 expect(settlement).toHaveLength(1);expect(settlement[0].home).toBe(securityHome);
 await createNativeClaudeCredentialOwner(f.options)({profileID:f.binding.profileID,purpose:'request'},f.context());expect(f.exchanges).toBe(1);
});

test('legacy/default reads and migration retain inherited HOME despite a scoped backend being configured',async()=>{
 const f=await fixture(),value=f.records.get(f.binding.service);f.records.set('Claude Code-credentials',value);
 const owner=createNativeClaudeCredentialOwner({...f.options,profiles:[],policy:'access-only'});
 await owner({profileID:'default',purpose:'request'},f.context());
 await migrateNativeClaudeLegacyFences({...f.options,profiles:[]},{recheck:f.check});
 expect(f.commands.length).toBeGreaterThan(0);expect(f.commands.every(command=>command.home===undefined&&command.service==='Claude Code-credentials')).toBe(true);
});

test('fresh enrollment, selection and deletion use original store with exact private proof and no update on first add',async()=>{
 const f=await fixture(),published=[];
 const owner=createNativeClaudeEnrollmentOwner({controlRoot:f.controlRoot,home:f.home,asset:{},lifecycle:f.lifecycle,withMutationQueue:action=>action(),loadModule:async()=>module,
  captureBinding:async()=>({}),recheckBinding:f.check,execute:f.execute,bindOwnedCommand:f.bindOwnedCommand,publishProfile:async profile=>published.push(profile),
  withProfileRemoval:action=>action(),assertProfileRemoval:f.check,removeProfile:async()=>{},recheckAfterRemoval:f.check,
  fetchImpl:async()=>Response.json({access_token:'fixture-enrolled',refresh_token:'fixture-enrolled-grant',expires_in:3600})});
 const pending=await owner.begin({});await owner.complete(pending.enrollmentID,{code:'fixture-only-code',state:new URL(pending.url).searchParams.get('state')},{});
 await owner.select(pending.enrollmentID,{});await owner.remove(pending.enrollmentID,{});
 expect(published).toHaveLength(1);expect(f.commands.every(command=>command.home===securityHome&&command.service!==f.binding.service)).toBe(true);
 expect(f.state.accounts).toHaveLength(1);expect(f.state.unresolved).toEqual([]);await owner.close();
});

test('a selected fresh account is not reread by legacy migration before the next enrollment',async()=>{
 const f=await fixture(),profiles=[];
 const owner=createNativeClaudeEnrollmentOwner({controlRoot:f.controlRoot,home:f.home,asset:{},lifecycle:f.lifecycle,withMutationQueue:action=>action(),loadModule:async()=>module,
  captureBinding:async()=>({}),recheckBinding:f.check,execute:f.execute,bindOwnedCommand:f.bindOwnedCommand,publishProfile:async profile=>profiles.push(profile),
  beforeEnrollment:context=>profiles.length?migrateNativeClaudeLegacyFences({profiles,home:f.home,ownedControlRoot:f.controlRoot,lifecycle:f.lifecycle,loadModule:async()=>module,
   backend:{execFile:async()=>{throw Error('must not read a fresh account with legacy HOME');}}},context):undefined,
  fetchImpl:async()=>Response.json({access_token:'fixture-selected',refresh_token:'fixture-selected-grant',expires_in:3600})});
 const first=await owner.begin({});await owner.complete(first.enrollmentID,{code:'fixture-only-code',state:new URL(first.url).searchParams.get('state')},{});await owner.select(first.enrollmentID,{});
 const second=await owner.begin({});expect(second.status).toBe('pending');expect(f.state.accounts).toHaveLength(2);expect(f.state.unresolved).toEqual([]);
 expect(f.commands.every(command=>command.home===securityHome)).toBe(true);await owner.close();
});
