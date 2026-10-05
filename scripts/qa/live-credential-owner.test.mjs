import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {parseLiveOwnerCommand,parseLiveOwnerFlags,createLiveOwnerLink,runLiveCredentialOwner} from './live-credential-owner.mjs';

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
