import {expect,test} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';

test('Node command derivation independently binds exact compiled origin/declaration and refuses custom overrides',async()=>{
 const directory='/fixture/commands',sessionID='ses_command';
 const origin={kind:'plugin',id:'devryan.slim-commands',manifestDigest:'a'.repeat(64),capabilities:['control']};
 const declaration={template:'Original declared behavior',description:'Original description'};
 const registry=[{origin,name:'deepwork',definition:declaration}];
 let configuration={commands:{}},allowed=true;
 const owner=createNativeAdmissionOwner({directory,ownerID:'fixture',reviewedBehaviorCommands:registry,getReviewedConfiguration:()=>configuration,
  runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},getSession:async id=>({id,directory}),
  captureWebAuthorization:async()=>async()=>{if(!allowed)throw Object.assign(new Error('revoked'),{code:'revoked'});},authorizeOperation:async()=>{throw new Error('Unowned command');}});
 // External constructor inputs cannot change the captured compiled registry.
 registry[0].definition.template='Mutated after construction';
 const operation=(changes={})=>owner.withWebOperation({operation:'commands.execute',method:'POST',path:`/api/session/${sessionID}/command`,directory,body:{name:'deepwork',text:'Original args',delivery:'queue'}},()=>{
  const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
  return owner.handleRpc('native.admission.beginCommand',{permit,sessionID,name:'deepwork',definition:{template:'Original declared behavior',description:'Original description'},origin:{...origin},invocation:{sessionID,prompt:{text:'Original args'},delivery:'queue'},...changes});
 });
 await expect(operation()).resolves.toMatch(/^[a-f0-9]{64}$/);
 for(const changes of [{origin:{...origin,manifestDigest:'b'.repeat(64)}},{origin:{...origin,capabilities:['control','read']}},{origin:undefined},{definition:{template:'Forged',description:'Original description'}},{definition:{template:'Original declared behavior',description:'Forged'}}]){
  await expect(operation(changes)).rejects.toMatchObject({code:'native_command_definition_unreviewed'});
 }
 await expect(operation({model:{providerID:'forged',id:'model'}})).rejects.toMatchObject({code:'native_command_selection_unreviewed'});
 await expect(operation({invocation:{sessionID,prompt:{text:'Different args'},delivery:'queue'}})).rejects.toMatchObject({code:'native_web_payload_changed'});
 await expect(operation({invocation:{sessionID,prompt:{text:'Original args'},delivery:'steer'}})).rejects.toMatchObject({code:'native_web_payload_changed'});
 configuration={commands:{deepwork:{template:'User custom command'}}};await expect(operation()).rejects.toMatchObject({code:'native_command_definition_unreviewed'});
 configuration={commands:{}};allowed=false;await expect(operation()).rejects.toMatchObject({code:'revoked'});
 owner.dispose();
});

test('reviewed command effects require the private derivation and retain fresh caller and ledger checks',async()=>{
 const directory='/fixture/commands',sessionID='ses_command';
 const origin={kind:'plugin',id:'devryan.ponytail',manifestDigest:'c'.repeat(64),capabilities:['control']};
 const definition={template:'Original ponytail command',description:'Original description'};
 const invocation={sessionID,prompt:{text:'full'},delivery:'queue'};
 let allowed=true,revision=0;
 const owner=createNativeAdmissionOwner({directory,ownerID:'fixture',reviewedBehaviorCommands:[{origin,name:'ponytail',definition}],getReviewedConfiguration:()=>({commands:{}}),
  runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false})},getSession:async id=>({id,directory}),
  captureWebAuthorization:async()=>async()=>{if(!allowed)throw Object.assign(new Error('revoked'),{code:'revoked'});},authorizeOperation:async()=>{throw new Error('Unowned command');}});
 let captured;
 await owner.withWebOperation({operation:'commands.execute',method:'POST',path:`/api/session/${sessionID}/command`,directory,body:{name:'ponytail',text:'full',delivery:'queue'}},async()=>{
  const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
  const derivation=await owner.handleRpc('native.admission.beginCommand',{permit,sessionID,name:'ponytail',definition,origin,invocation});
  const request={operation:'session.command.effect',sessionID,derivation,input:{name:'ponytail',invocation}};
  const check=changes=>owner.handleRpc('native.admission.recheck',{permit,request:{...request,...changes}});
  await expect(check()).resolves.toBeNull();
  for(const changes of [{derivation:undefined},{derivation:'f'.repeat(64)},{input:{name:'deepwork',invocation}},{input:{name:'ponytail',invocation:{...invocation,prompt:{text:'off'}}}}]){
   await expect(check(changes)).rejects.toMatchObject({code:'native_command_derivation_required'});
  }
  allowed=false;await expect(check()).rejects.toMatchObject({code:'revoked'});allowed=true;
  revision=1;await expect(check()).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;
  captured={permit,request};
 });
 await expect(owner.handleRpc('native.admission.recheck',captured)).rejects.toMatchObject({code:'native_permit_invalid'});
 owner.dispose();
});

test('stored command provenance survives its request and refuses public markers, changed args and stale grants',async()=>{
 const directory='/fixture/commands',sessionID='ses_interview',messageID='msg_interview';
 const origin={kind:'plugin',id:'devryan.slim-interview',manifestDigest:'d'.repeat(64),capabilities:['control']};
 const definition={template:'<omos-interview-command>$ARGUMENTS</omos-interview-command>',description:'Original interview'};
 const invocation={sessionID,prompt:{text:'A small project'},delivery:'queue'};
 let allowed=true,revision=0,raw;
 const owner=createNativeAdmissionOwner({directory,ownerID:'prepared-bundle',reviewedBehaviorCommands:[{origin,name:'interview',definition}],
  getReviewedConfiguration:()=>({commands:{}}),runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false})},
  getSession:async id=>({id,directory,agent:'orchestrator',model:{providerID:'fixture',id:'exact'}}),readUserMessage:async()=>structuredClone(raw),
  captureWebAuthorization:async()=>async()=>{if(!allowed)throw Error('revoked');},authorizeOperation:async()=>{if(!allowed)throw Error('revoked');}});
 try{
  await owner.withWebOperation({operation:'commands.execute',method:'POST',path:`/api/session/${sessionID}/command`,directory,body:{name:'interview',text:invocation.prompt.text,delivery:'queue'}},async()=>{
   const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
   const derivation=await owner.handleRpc('native.admission.beginCommand',{permit,sessionID,name:'interview',definition,origin,invocation});
   const text=definition.template.replace('$ARGUMENTS',invocation.prompt.text);
   await owner.handleRpc('native.admission.recheck',{permit,request:{operation:'session.prompt',sessionID,derivation,input:{id:messageID,sessionID,text,delivery:'queue'}}});
   const metadata=await owner.handleRpc('native.admission.sealPrompt',{permit,input:{sessionID,messageID,prompt:{text},delivery:'queue'}});
   raw={id:messageID,type:'user',sessionID,directory,metadata};
   await expect(owner.handleRpc('native.admission.verifyAccepted',{permit,accepted:{id:messageID,sessionID,type:'user',text,metadata}})).resolves.toBeNull();
  });
  const permit=await owner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID});
  const input={permit,directory,sessionID,messageID,name:'interview',arguments:invocation.prompt.text};
  const check=await owner.captureAcceptedCommandAuthorization(input);await check();
  for(const change of [{messageID:'msg_foreign'},{sessionID:'ses_foreign'},{arguments:'Different project'},{name:'deepwork'}])
   await expect(owner.captureAcceptedCommandAuthorization({...input,...change})).rejects.toMatchObject({code:'native_accepted_command_required'});
  const saved=structuredClone(raw);
  for(const change of [{ownerID:'another-bundle'},{definitionDigest:'f'.repeat(64)},{fingerprint:'f'.repeat(64)},{origin:{...origin,manifestDigest:'f'.repeat(64)}}]){
   raw=structuredClone(saved);Object.assign(raw.metadata.devryan.command,change);await expect(check()).rejects.toMatchObject({code:'native_accepted_command_required'});
  }
  raw=structuredClone(saved);delete raw.metadata.devryan.command;await expect(check()).rejects.toMatchObject({code:'native_accepted_command_required'});
  raw=saved;allowed=false;await expect(check()).rejects.toThrow('revoked');allowed=true;
  revision=1;await expect(check()).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;
  const dialog=await owner.captureInterviewAuthorization(input);
  await owner.handleRpc('native.admission.release',permit);await expect(check()).rejects.toMatchObject({code:'native_permit_invalid'});
  await expect(dialog.recheck()).resolves.toBeUndefined();
  for(const kind of ['rename','notify','continue']){
   await owner.withInterviewAction({authorizationID:dialog.authorizationID,directory,sessionID,messageID,kind,text:'Original service output'},async({permit,body})=>{
    const operation=kind==='rename'?'session.rename':kind==='notify'?'session.synthetic':'session.prompt';
    if(kind==='continue')await owner.handleRpc('native.admission.authorize',{operation:'session.switchAgent',sessionID,existingPermit:permit,input:{sessionID,agent:'orchestrator'}});
    await expect(owner.handleRpc('native.admission.authorize',{operation,sessionID,existingPermit:permit,input:body})).resolves.toEqual(permit);
    await expect(owner.handleRpc('native.admission.authorize',{operation,sessionID,existingPermit:permit,input:{...body,text:'forged'}})).rejects.toMatchObject({code:'native_interview_operation_changed'});
    if(kind==='notify'){
     const metadata=await owner.handleRpc('native.admission.sealSynthetic',{permit,input:body});
     await expect(owner.handleRpc('native.admission.verifyAccepted',{permit,accepted:{type:'synthetic',id:body.id,sessionID,text:body.text,metadata}})).resolves.toBeNull();
     await expect(owner.handleRpc('native.admission.verifyAccepted',{permit,accepted:{type:'synthetic',id:body.id,sessionID,text:'forged',metadata}})).rejects.toMatchObject({code:'native_interview_operation_changed'});
    }else if(kind==='continue'){
     const metadata=await owner.handleRpc('native.admission.sealPrompt',{permit,input:{sessionID,messageID:body.id,prompt:{text:body.text}}});
     await expect(owner.handleRpc('native.admission.verifyAccepted',{permit,accepted:{type:'user',id:body.id,sessionID,text:body.text,metadata}})).resolves.toBeNull();
    }
    await expect(owner.handleRpc('native.admission.authorize',{operation:'session.setPermissions',sessionID,existingPermit:permit,input:{sessionID,permissions:[]}})).rejects.toMatchObject({code:'native_interview_operation_changed'});
   });
  }
  await expect(owner.withInterviewAction({authorizationID:dialog.authorizationID,directory,sessionID:'ses_foreign',messageID,kind:'rename',text:'forged'},async()=>{})).rejects.toMatchObject({code:'native_interview_action_invalid'});
  revision=1;await expect(dialog.recheck()).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;expect(dialog.signal.aborted).toBe(true);
  await expect(dialog.recheck()).rejects.toMatchObject({code:'native_permit_revoked'});
  const secondPermit=await owner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID});
  const replaced=await owner.captureInterviewAuthorization({...input,permit:secondPermit});
  await owner.invalidateController();expect(replaced.signal.aborted).toBe(true);await expect(replaced.recheck()).rejects.toMatchObject({code:'native_permit_revoked'});
  await expect(check()).rejects.toMatchObject({code:'native_permit_invalid'});
 }finally{owner.dispose();}
});
