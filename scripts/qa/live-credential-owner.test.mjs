import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {EventEmitter} from 'node:events';
import {createQaProcessOwnership} from './process-ownership.mjs';
import {parseLiveOwnerCommand,parseLiveOwnerFlags,createLiveOwnerLink,runLiveCredentialOwner,settleLiveOwnerChild,liveOwnerFailureDiagnostic,waitLiveOwnerAttendance} from './live-credential-owner.mjs';

test('piped owner attendance requires its connected launcher identity and exact finite attestation',async()=>{
  for(const value of [{status:'owner-attended',launcherPid:10},{status:'owner-attended',launcherPid:11},
    {status:'owner-attended',launcherPid:10,credential:'private'},{status:'other',launcherPid:10}]){
    const channel=Object.assign(new EventEmitter(),{connected:true});
    const pending=waitLiveOwnerAttendance(channel,{parentPid:10,timeoutMs:50});channel.emit('message',value);
    if(value.status==='owner-attended'&&value.launcherPid===10&&Object.keys(value).length===2)await pending;
    else await assert.rejects(pending,/qa_live_owner_attendance_required/);
    assert.equal(channel.listenerCount('message'),0);assert.equal(channel.listenerCount('disconnect'),0);
  }
  await assert.rejects(waitLiveOwnerAttendance({connected:false}),/qa_live_owner_attendance_required/);
  const channel=Object.assign(new EventEmitter(),{connected:true});
  await assert.rejects(waitLiveOwnerAttendance(channel,{timeoutMs:1}),/qa_live_owner_attendance_required/);
  assert.equal(channel.listenerCount('message'),0);assert.equal(channel.listenerCount('disconnect'),0);
});

test('isolated owner child processes status and close from its launcher pipe before cleanup',async()=>{
  const module=new URL('./live-credential-owner.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','--eval',`
    import {waitLiveOwnerAttendance} from ${JSON.stringify(module)};
    await waitLiveOwnerAttendance();process.send({status:'ready',tty:!!process.stdin.isTTY});
    let pending='';for await(const bytes of process.stdin){pending+=bytes;let newline;
      while((newline=pending.indexOf('\\n'))>=0){const command=JSON.parse(pending.slice(0,newline)).command;pending=pending.slice(newline+1);
        process.send({status:command});if(command==='close'){process.stdin.destroy();process.send({status:'owner-returned',exitCode:0});process.disconnect();break;}
      }if(process.stdin.destroyed)break;
    }`],{detached:process.platform!=='win32',stdio:['pipe','ignore','ignore','ipc']});
  const ownership=createQaProcessOwnership(child);
  try{
    const ready=once(child,'message');child.send({status:'owner-attended',launcherPid:process.pid});
    assert.deepEqual((await ready)[0],{status:'ready',tty:false});await ownership.refresh();
    const status=once(child,'message');child.stdin.write('{"command":"status"}\n');assert.deepEqual((await status)[0],{status:'status'});
    assert.equal(child.exitCode,null);assert.deepEqual(ownership.getEvidence().signals,[]);
    const close=once(child,'message'),settled=settleLiveOwnerChild(child,{ownership});
    child.stdin.write('{"command":"close"}\n');assert.deepEqual((await close)[0],{status:'close'});
    const result=await settled;assert.equal(result.exitCode,0);assert.equal(result.teardown,'passed');assert.deepEqual(result.processes.remainingProcessIds,[]);
  }finally{await ownership.terminateRemaining();await ownership.closeTracking();}
});

test('failure diagnostics retain finite input errors without account-bearing messages or custom fields',()=>{
  assert.deepEqual(liveOwnerFailureDiagnostic(Object.assign(new TypeError('private account value'),{code:'ERR_INVALID_ARG_TYPE',account:'private'}),'command-input'),
    {status:'refused',code:'qa_live_owner_failed',phase:'command-input',errorClass:'TypeError',errorCode:'ERR_INVALID_ARG_TYPE'});
  assert.deepEqual(liveOwnerFailureDiagnostic({name:'private account value',code:'private account value',message:'private'},'private'),
    {status:'refused',code:'qa_live_owner_failed',phase:'source-start',errorClass:'Error',errorCode:'qa_live_owner_failed'});
});

test('live owner flags, protocol and attendance refuse before reading any account',async()=>{
  const args=['--artifact-root','/a','--mirror','/m','--mirror-sha256','a'.repeat(64),'--matrix','/c','--matrix-sha256','b'.repeat(64),'--evidence-root','/e'];
  assert.equal(parseLiveOwnerFlags(args).mirrorSha256,'a'.repeat(64));
  for(const extra of [['--rehearsal','true'],['--mirror','duplicate'],['--reuse-source']])assert.throws(()=>parseLiveOwnerFlags([...args,...extra]),/qa_live_flags_invalid/);
  for(const line of ['{}','{"command":"status","value":"secret"}','[]','{"command":"export"}','x'.repeat(1025)])assert.throws(()=>parseLiveOwnerCommand(line),/qa_live_command_invalid/);
  assert.equal(parseLiveOwnerCommand('{"command":"hold-and-verify"}'),'hold-and-verify');
  await assert.rejects(runLiveCredentialOwner({sessionFile:'/never-read',input:{isTTY:false}}),/qa_live_owner_attendance_required/);
});

test('owner link is host-bound, expiring, single-use and closed permanently by a hold',async()=>{
  let clock=0,held=false,issued=0,settle;
  const link=await createLiveOwnerLink({hostOrigin:'http://127.0.0.1:43210',isHeld:()=>held,now:()=>clock,
    handle:{issueLocalOwnerSession:async()=>{issued++;if(settle)await settle;return {name:'devryan_local_owner',value:'x'.repeat(43),maxAge:3600};}}});
  try{
    const first=link.issue();
    const foreignStatus=await new Promise((resolve,reject)=>http.get(first.link,{headers:{host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);}).once('error',reject));
    assert.equal(foreignStatus,403);assert.equal(issued,0);
    const response=await fetch(first.link,{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'http://127.0.0.1:43210/');
    assert.match(response.headers.get('set-cookie'),/^devryan_local_owner=x{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
    assert.equal((await fetch(first.link,{redirect:'manual'})).status,403);assert.equal(issued,1);
    const stale=link.issue(),current=link.issue();assert.equal((await fetch(stale.link)).status,403);
    clock=current.expiresAt;assert.equal((await fetch(current.link)).status,403);assert.equal(issued,1);
    clock=0;const racing=link.issue();let release;settle=new Promise(resolve=>{release=resolve;});
    const pending=fetch(racing.link,{redirect:'manual'});
    while(issued!==2)await new Promise(resolve=>setImmediate(resolve));
    held=true;release();assert.equal((await pending).status,403);
    assert.equal((await fetch(racing.link)).status,403);assert.deepEqual(link.status(),{});assert.throws(()=>link.issue(),/qa_live_source_held/);
  }finally{await link.close();}
  assert.throws(()=>link.issue(),/qa_live_source_held/);
});

test('launcher settles lingering owned handles only after owner return and preserves failures',async()=>{
  for(const [exitCode,auditFails] of [[0,false],[1,false],[0,true]]){
    const child=spawn(process.execPath,['--input-type=module','--eval',`
      const interval=setInterval(()=>{},1000);
      process.on('message',value=>{
        if(value.command==='invalid')process.send({status:'owner-returned',exitCode:0,unexpected:true});
        if(value.command==='cleanup')process.send({status:'owner-returned',exitCode:value.exitCode});
      });process.send({status:'ready'});`],{stdio:['ignore','ignore','ignore','ipc']});
    const ownership=createQaProcessOwnership(child);
    try{
      await once(child,'message');await ownership.refresh();
      const proof=auditFails?{...ownership,auditStopped:async()=>{await ownership.auditStopped();throw new Error('fixture audit failure');}}:ownership;
      const pending=settleLiveOwnerChild(child,{ownership:proof});
      child.send({command:'invalid'});await new Promise(resolve=>setTimeout(resolve,75));
      assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.deepEqual(ownership.getEvidence().signals,[]);
      child.send({command:'cleanup',exitCode});
      const result=await pending;
      assert.equal(result.exitCode,exitCode);assert.equal(result.teardown,auditFails?'failed':'passed');
      assert.equal(result.processes.rootObserved,true);assert.deepEqual(result.processes.remainingProcessIds,[]);assert.equal(result.processes.trackingClosed,true);
      assert.ok(result.processes.signals.some(row=>row.pid===child.pid));
    }finally{await ownership.terminateRemaining();await ownership.closeTracking();}
  }
});

test('launcher still accepts a natural child exit without an IPC cleanup notification',async()=>{
  const child=spawn(process.execPath,['--input-type=module','--eval',`process.on('message',()=>{process.exitCode=1;process.disconnect();});process.send({status:'ready'});`],{stdio:['ignore','ignore','ignore','ipc']});
  const ownership=createQaProcessOwnership(child);
  try{
    await once(child,'message');await ownership.refresh();const pending=settleLiveOwnerChild(child,{ownership});child.send({command:'exit'});
    const result=await pending;assert.equal(result.exitCode,1);assert.equal(result.teardown,'passed');assert.deepEqual(result.processes.remainingProcessIds,[]);
  }finally{await ownership.terminateRemaining();await ownership.closeTracking();}
});
