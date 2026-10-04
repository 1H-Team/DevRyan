import {test,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeSlimOwner} from './native-slim-owner.js';
import {captureReviewedSkill} from './reviewed-skills.js';

test('Ponytail state and hook reads retain exact native session, private command derivation and original caller',async()=>{
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/slim-owner-'));
 const sessionID='ses_slim',origin={kind:'plugin',id:'devryan.ponytail',manifestDigest:'a'.repeat(64),capabilities:['control']};
 const definition={description:'original',template:'original $ARGUMENTS'},invocation={sessionID,prompt:{text:'ultra'},delivery:'queue'};
 let allowed=true,messageSession=sessionID;
 const admissionOwner=createNativeAdmissionOwner({directory:root,ownerID:'fixture',reviewedBehaviorCommands:[{origin,name:'ponytail',definition}],
  getReviewedConfiguration:()=>({commands:{}}),runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},
  getSession:async id=>({id,directory:root}),captureWebAuthorization:async()=>async()=>{if(!allowed)throw Error('revoked');},
  authorizeOperation:async()=>{if(!allowed)throw Error('revoked');}});
 const owner=createNativeSlimOwner({admissionOwner,configDirectory:root,configurationSnapshot:{locations:[{directory:root,
  activeRegistrationIDs:['devryan.ponytail'],compatibility:{ponytail:{defaultMode:'lite'}}}]},
  ponytailInstructions:{lite:'exact lite',full:'exact full',ultra:'exact ultra',review:'exact review'},
  openCodeClient:{sessions:{message:async(_sessionID,id)=>({info:{id,sessionID:messageSession},parts:[{type:'text',text:'exact user input'}]})}}});
 try{
  const permit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID});
  const hook={action:'ponytail',permit,directory:root,sessionID,phase:'context'};
  await expect(owner.hook(hook)).resolves.toBe('exact lite');
  await expect(owner.hook({...hook,action:'message',requestedMessageID:'msg_user'})).resolves.toEqual({parts:[{type:'text',text:'exact user input'}]});
  messageSession='ses_foreign';await expect(owner.hook({...hook,action:'message',requestedMessageID:'msg_user'})).rejects.toMatchObject({code:'native_slim_message_scope_invalid'});messageSession=sessionID;
  const operation={operation:'commands.execute',method:'POST',path:`/api/session/${sessionID}/command`,directory:root,body:{name:'ponytail',text:'ultra',delivery:'queue'}};
  await admissionOwner.withWebOperation(operation,async()=>{
   const permit=JSON.parse(admissionOwner.requestHeaders()['x-devryan-native-permit']);
   const derivation=await admissionOwner.handleRpc('native.admission.beginCommand',{permit,sessionID,name:'ponytail',definition,origin,invocation});
   const command={permit,directory:root,derivation,name:'ponytail',invocation};
   await expect(owner.ponytailCommand({...command,derivation:'f'.repeat(64)})).rejects.toMatchObject({code:'native_command_derivation_required'});
   await expect(owner.ponytailCommand({...command,directory:root+'/other'})).rejects.toMatchObject({code:'native_command_scope_invalid'});
   await expect(owner.ponytailCommand(command)).resolves.toEqual({kind:'changed',mode:'ultra'});
   allowed=false;await expect(owner.ponytailCommand(command)).rejects.toThrow('revoked');allowed=true;
  });
  expect(await fs.readFile(path.join(root,'.ponytail-active'),'utf8')).toBe('ultra');
  await expect(owner.hook(hook)).resolves.toBe('exact ultra');
  allowed=false;await expect(owner.hook(hook)).rejects.toThrow('revoked');allowed=true;
  await admissionOwner.invalidateController();await expect(owner.hook(hook)).rejects.toMatchObject({code:'native_permit_invalid'});
 }finally{admissionOwner.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('original path hooks retain canonical tool lineage, bounded project IO and revocable runner grants',async()=>{
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/slim-path-'));
 const directory=path.join(root,'project'),secret=path.join(root,'private'),sessionID='ses_paths',messageID='msg_paths',callID='call_paths';
 await fs.mkdir(directory);await fs.mkdir(secret);await fs.mkdir(path.join(directory,'.GiT'));
 await fs.writeFile(path.join(directory,'file.txt'),'exact patch source');await fs.writeFile(path.join(secret,'secret'),'denied');
 await fs.symlink(path.join(secret,'secret'),path.join(directory,'escape'));await fs.writeFile(path.join(directory,'.GiT','config'),'denied');
 let allowed=true,revision=0,callName='apply_patch',callStatus='running';
 const admissionOwner=createNativeAdmissionOwner({directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false})},
  getSession:async id=>({id,directory}),authorizeOperation:async()=>{if(!allowed)throw Error('revoked');}});
 const owner=createNativeSlimOwner({admissionOwner,configurationSnapshot:{locations:[{directory}]},locations:[{directory,readRoots:[directory],protectedRoots:[secret]}],
  openCodeClient:{sessions:{message:async()=>({info:{id:messageID,sessionID,role:'assistant',parentID:'msg_user'},
   turnOwnership:{source:'native-sequence',userMessageID:'msg_user'},parts:[{type:'tool',tool:callName,callID,state:{status:callStatus}}]})}}});
 try{
  const permit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID});
  const input={permit,directory,sessionID,messageID,callID,toolID:'patch',phase:'execute.before'};
  await expect(owner.path({...input,action:'assert'})).resolves.toBeNull();
  await expect(owner.path({...input,action:'readText',target:path.join(directory,'file.txt')})).resolves.toBe('exact patch source');
  await expect(owner.path({...input,action:'stat',target:directory})).resolves.toEqual({kind:'directory'});
  await expect(owner.path({...input,action:'stat',target:path.join(directory,'missing.txt')})).resolves.toEqual({kind:'missing'});
  await expect(owner.path({...input,action:'realpath',target:path.join(directory,'file.txt')})).resolves.toBe(path.join(directory,'file.txt'));
  callStatus='completed';await expect(owner.path({...input,action:'assert'})).rejects.toMatchObject({code:'native_tool_hook_scope_invalid'});callStatus='running';
  for(const target of [path.join(secret,'secret'),path.join(directory,'escape'),path.join(directory,'.GiT','config')])
   await expect(owner.path({...input,action:'readText',target})).rejects.toMatchObject({code:'native_read_root_denied'});
  for(const change of [{phase:'execute.after'},{sessionID:'ses_foreign'},{directory:secret},{callID:'call_forged'},{messageID:'msg_forged'}])
   await expect(owner.path({...input,...change,action:'assert'})).rejects.toMatchObject({code:change.directory?'native_slim_location_unreviewed':change.phase?'native_slim_path_invalid':'native_tool_hook_scope_invalid'});
  callName='read';await expect(owner.path({...input,action:'assert'})).rejects.toMatchObject({code:'native_tool_hook_scope_invalid'});callName='apply_patch';
  allowed=false;await expect(owner.path({...input,action:'assert'})).rejects.toThrow('revoked');allowed=true;
  revision=1;await expect(owner.path({...input,action:'assert'})).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;
  await admissionOwner.invalidateController();await expect(owner.path({...input,action:'assert'})).rejects.toMatchObject({code:'native_permit_invalid'});
 }finally{admissionOwner.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('read rescue metadata admits only an unchanged exact reviewed resource under the current canonical hook',async()=>{
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/slim-resource-owner-'));
 const directory=path.join(root,'project'),privateRoot=path.join(root,'private'),skillRoot=path.join(privateRoot,'skill');
 await fs.mkdir(directory);await fs.mkdir(skillRoot,{recursive:true});
 const file=path.join(skillRoot,'SKILL.md'),support=path.join(skillRoot,'support.txt'),unlisted=path.join(skillRoot,'unlisted.txt');
 await fs.writeFile(file,'Reviewed body');await fs.writeFile(support,'Exact reviewed bytes');
 const skill=await captureReviewedSkill({directory,skill:{name:'Reviewed',path:file},allowedRoots:[privateRoot],parseMarkdown:()=>({body:'Reviewed body',frontmatter:{}})});
 await fs.writeFile(unlisted,'Unlisted');
 const sessionID='ses_resource',messageID='msg_resource',callID='call_resource';
 let allowed=true,revision=0,callName='read',callStatus='running',canonicalSession=sessionID;
 const admissionOwner=createNativeAdmissionOwner({directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false})},
  getSession:async id=>({id,directory}),authorizeOperation:async()=>{if(!allowed)throw Error('revoked');}});
 const owner=createNativeSlimOwner({admissionOwner,configurationSnapshot:{digest:'f'.repeat(64),locations:[{directory,skills:[skill]}]},locations:[{directory,readRoots:[directory],protectedRoots:[privateRoot]}],
  openCodeClient:{sessions:{message:async()=>({info:{id:messageID,sessionID:canonicalSession,role:'assistant',parentID:'msg_user'},
   turnOwnership:{source:'native-sequence',userMessageID:'msg_user'},parts:[{type:'tool',tool:callName,callID,state:{status:callStatus}}]})}}});
 let openSpy;
 try{
  const permit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID});
  const input={permit,directory,sessionID,messageID,callID,toolID:'read',phase:'execute.before',target:support};
  await expect(owner.path({...input,action:'stat'})).resolves.toEqual({kind:'file'});
  await expect(owner.path({...input,action:'realpath'})).resolves.toBe(support);
  await expect(owner.path({...input,target:file,action:'stat'})).resolves.toEqual({kind:'file'});
  for(const target of [unlisted,skillRoot,privateRoot,path.join(privateRoot,'settings.json')])await expect(owner.path({...input,target,action:'stat'})).rejects.toMatchObject({code:'native_read_root_denied'});
  await expect(owner.path({...input,action:'readText'})).rejects.toMatchObject({code:'native_read_root_denied'});
  await expect(owner.path({...input,action:'list'})).rejects.toMatchObject({code:'native_slim_path_invalid'});
  for(const toolID of ['grep','glob','patch']){
   callName=toolID==='patch'?'apply_patch':toolID;
   await expect(owner.path({...input,toolID,action:'stat'})).rejects.toMatchObject({code:'native_read_root_denied'});
  }
  callName='read';
  for(const change of [{sessionID:'ses_foreign'},{messageID:'msg_foreign'},{callID:'call_foreign'},{phase:'execute.after'},{directory:privateRoot}])await expect(owner.path({...input,...change,action:'stat'})).rejects.toMatchObject({code:change.directory?'native_slim_location_unreviewed':change.phase?'native_slim_path_invalid':'native_tool_hook_scope_invalid'});
  callStatus='completed';await expect(owner.path({...input,action:'stat'})).rejects.toMatchObject({code:'native_tool_hook_scope_invalid'});callStatus='running';
  canonicalSession='ses_foreign';await expect(owner.path({...input,action:'stat'})).rejects.toMatchObject({code:'native_tool_hook_scope_invalid'});canonicalSession=sessionID;
  await fs.writeFile(support,'Changed reviewed bytes');await expect(owner.path({...input,action:'stat'})).rejects.toMatchObject({code:'native_skill_resource_changed'});
  await fs.unlink(support);await fs.symlink(file,support);await expect(owner.path({...input,action:'realpath'})).rejects.toMatchObject({code:'native_skill_resource_changed'});
  await fs.unlink(support);await fs.writeFile(support,'Exact reviewed bytes');
  const originalOpen=fs.open.bind(fs);
  openSpy=vi.spyOn(fs,'open').mockImplementation(async(...args)=>{const handle=await originalOpen(...args);if(args[0]===support)allowed=false;return handle;});
  await expect(owner.path({...input,action:'stat'})).rejects.toThrow('revoked');openSpy.mockRestore();openSpy=undefined;allowed=true;
  revision=1;await expect(owner.path({...input,action:'stat'})).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;
  await admissionOwner.invalidateController();await expect(owner.path({...input,action:'stat'})).rejects.toMatchObject({code:'native_permit_invalid'});
 }finally{openSpy?.mockRestore();admissionOwner.dispose();await fs.rm(root,{recursive:true,force:true});}
});
