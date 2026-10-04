import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createNativeCursorRecovery} from './native-cursor-recovery.js';

test('Cursor recovery retains uncertain start and exact receipt-backed intent until native cleanup ACK',async()=>{
 const cache=path.resolve('.cache/v2-validation');await fs.mkdir(cache,{recursive:true});
 const root=await fs.realpath(await fs.mkdtemp(path.join(cache,'cursor-recovery-'))),project=path.join(root,'project');await fs.mkdir(project);
 const scope={controllerInstanceID:'old-instance',directory:project,sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer'};
 let lease,neverStarted=false,settled=0;
 const runtime={leaseForCall:async()=>lease,executionOutcomes:async()=>[{outcome:neverStarted?'never_started':'uncertain'}]};
 const options={directory:path.join(root,'intents'),ownerID:'bundle_cursor',runtime};
 const recover=()=>createNativeCursorRecovery(options).recover({directory:project,settle:async(actual,revision)=>{
  expect(actual).toEqual(scope);expect(revision).toBe(3);settled++;
 }});
 try{
  const owner=createNativeCursorRecovery(options);await owner.stage({scope,revision:3});await owner.starting(scope);
  await expect(recover()).rejects.toMatchObject({code:'native_cursor_recovery_termination_unconfirmed'});expect(settled).toBe(0);
  const viewDirectory=path.join(root,'lease','view');await fs.mkdir(viewDirectory,{recursive:true});
  lease={token:'lease_exact',generation:7,directory:project,viewDirectory,executionKind:'process',state:'ready',
   scope:{sessionID:scope.sessionID,userMessageID:scope.userMessageID,messageID:scope.assistantMessageID,callID:`cursor_${scope.assistantMessageID}`}};
  await owner.bind(scope,lease);
  await expect(recover()).rejects.toMatchObject({code:'native_cursor_recovery_termination_unconfirmed'});
  lease.state='cancelled';await expect(recover()).rejects.toMatchObject({code:'ENOENT'});
  // Unit schema oracle only: integrated diagnostic must obtain this file from
  // the real accepted supervisor; a terminal ledger state alone is insufficient.
  const receipt=path.join(root,'lease','termination.json');
  await fs.writeFile(receipt,JSON.stringify({terminated:true,confined:false,cancelled:true,exitCode:143}));
  await expect(recover()).rejects.toMatchObject({code:'native_cursor_recovery_termination_unconfirmed'});
  await fs.writeFile(receipt,JSON.stringify({terminated:true,confined:true,cancelled:true,exitCode:143}));
  const token=lease.token;lease.token='foreign';await expect(recover()).rejects.toMatchObject({code:'native_cursor_recovery_termination_unconfirmed'});lease.token=token;
  const generation=lease.generation;lease.generation++;await expect(recover()).rejects.toMatchObject({code:'native_cursor_recovery_termination_unconfirmed'});lease.generation=generation;
  await expect(owner.recover({directory:project,settle:async()=>{throw Error('lost native ACK');}})).rejects.toThrow('lost native ACK');
  expect((await fs.readdir(options.directory)).filter(name=>name.endsWith('.json'))).toHaveLength(1);
  await recover();expect(settled).toBe(1);await recover();expect(settled).toBe(1);
  const second={...scope,assistantMessageID:'msg_initial_only'};await owner.stage({scope:second,revision:3});lease=undefined;
  await owner.recover({directory:project,settle:async actual=>{expect(actual).toEqual(second);settled++;}});expect(settled).toBe(2);
  await owner.stage({scope,revision:3});await owner.starting(scope);neverStarted=true;await recover();expect(settled).toBe(3);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Cursor recovery refuses symlinked storage and corrupted ownership without deleting evidence',async()=>{
 const cache=path.resolve('.cache/v2-validation');await fs.mkdir(cache,{recursive:true});
 const root=await fs.realpath(await fs.mkdtemp(path.join(cache,'cursor-recovery-path-')));
 const scope={controllerInstanceID:'old',directory:root,sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer'};
 const runtime={leaseForCall:async()=>null,executionOutcomes:async()=>[]};
 try{
  const directory=path.join(root,'intents'),owner=createNativeCursorRecovery({directory,ownerID:'one',runtime});await owner.stage({scope,revision:0});
  await expect(createNativeCursorRecovery({directory,ownerID:'two',runtime}).recover({directory:root,settle:async()=>{throw Error('unreachable');}})).rejects.toMatchObject({code:'native_cursor_recovery_owner_mismatch'});
  expect((await fs.readdir(directory)).filter(name=>name.endsWith('.json'))).toHaveLength(1);
  const alias=path.join(root,'alias');await fs.symlink(directory,alias);
  await expect(createNativeCursorRecovery({directory:alias,ownerID:'one',runtime}).stage({scope,revision:0})).rejects.toMatchObject({code:'native_cursor_recovery_path_invalid'});
  const child=path.join(alias,'must-not-create');
  await expect(createNativeCursorRecovery({directory:child,ownerID:'one',runtime}).stage({scope,revision:0})).rejects.toMatchObject({code:'native_cursor_recovery_path_invalid'});
  await expect(fs.stat(path.join(directory,'must-not-create'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
