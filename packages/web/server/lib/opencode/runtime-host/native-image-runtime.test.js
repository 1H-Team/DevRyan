import {test,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {createNativeImageRuntime} from './native-image-runtime.js';
test('image context returns exact canonical identities and waits for real interrupted work',async()=>{
 const directory='/owned',sessionID='ses_images',permit={token:'private',sessionID,revision:0};
 const image={type:'file',id:'file_image',mime:'image/png',filename:'image.png',url:'data:image/png;base64,'+Buffer.from('exact bytes').toString('base64')};
 const messages=[{info:{role:'user',id:'msg_user',sessionID},parts:[{type:'text',text:'canonical'},image]}];
 let live=true,block=false,started,finish,uncertain=false;
 const check=async()=>{if(!live)throw Error('revoked');};
 const runtime=createNativeImageRuntime({locations:[{directory}],readContext:async()=>({records:messages,latestTurnParent:{id:'msg_user',type:'user',fingerprint:'a'.repeat(64)}}),
  admissionOwner:{captureSessionHookAuthorization:async()=>check},executionHost:{nativeContextAssets:async(_input,{signal})=>{
   if(block){started();await new Promise(resolve=>{finish=resolve;});signal.throwIfAborted();}
   if(uncertain)throw Object.assign(Error('termination uncertain'),{nativeProcessUnsettled:true});
   return {messages:[{info:messages[0].info,parts:[messages[0].parts[0],{type:'text',text:'original notice'}]}],imagesSkipped:false};
  }}});
 const input=()=>({requestID:randomUUID(),directory,sessionID,permit,phase:'context',messageIDs:['msg_user']});
 const scope=input=>({requestID:input.requestID,directory,sessionID,permit});
 try{
  const first=input(),result=await runtime.transform(first);
  expect(result).toEqual({imagesSkipped:false,replacements:[{messageID:'msg_user',text:'original notice',images:[{sha256:createHash('sha256').update('exact bytes').digest('hex'),mime:'image/png',name:'image.png'}]}]});
  expect(JSON.stringify(result)).not.toContain(image.url);await runtime.settle(scope(first));
  const revoked=input();live=false;await expect(runtime.transform(revoked)).rejects.toThrow('revoked');await runtime.settle(scope(revoked));live=true;
  const forged={...input(),messages};await expect(runtime.transform(forged)).rejects.toMatchObject({code:'native_image_context_invalid'});await runtime.settle(scope(forged));
  block=true;const cancelled=input(),began=new Promise(resolve=>{started=resolve;}),work=runtime.transform(cancelled);await began;
  let settled=false;const settling=runtime.settle(scope(cancelled)).then(()=>{settled=true;});await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
  finish();await expect(work).rejects.toMatchObject({code:'native_image_cancelled'});await settling;expect(settled).toBe(true);block=false;
  uncertain=true;const missing=input();await expect(runtime.transform(missing)).rejects.toMatchObject({nativeProcessUnsettled:true});await expect(runtime.settle(scope(missing))).rejects.toThrow('termination uncertain');
  await expect(runtime.close()).rejects.toThrow('native_image_termination_unconfirmed');
 }finally{finish?.();}
});

test('image context anchors canonical continuations and refuses absent or changed parents before returning replacements',async()=>{
 const directory='/owned',sessionID='ses_images',permit={token:'private'};
 const user={info:{id:'msg_user',role:'user',sessionID},parts:[]};let anchor={id:'msg_shell',type:'synthetic',fingerprint:'a'.repeat(64)},calls=0,reads=0,mutate;
 const runtime=createNativeImageRuntime({locations:[{directory}],readContext:async()=>{if(++reads===2)mutate?.();return {records:[user],latestTurnParent:{...anchor}};},
  admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{}},executionHost:{nativeContextAssets:async()=>{calls++;return {messages:[user],imagesSkipped:false};}}});
 const input=()=>({requestID:randomUUID(),directory,sessionID,permit,phase:'context',messageIDs:['msg_user','msg_shell','msg_status']});
 const run=async value=>{reads=0;try{return await runtime.transform(value);}finally{await runtime.settle({requestID:value.requestID,directory,sessionID,permit});}};
 try{
  expect(await run(input())).toEqual({replacements:[],imagesSkipped:false});expect(calls).toBe(0);
  await expect(run({...input(),messageID:'msg_status'})).rejects.toMatchObject({code:'native_image_context_invalid'});
  await expect(run({...input(),messageIDs:['msg_user','msg_status']})).rejects.toMatchObject({code:'native_image_message_stale'});expect(calls).toBe(0);
  mutate=()=>{anchor.fingerprint='b'.repeat(64);};await expect(run(input())).rejects.toMatchObject({code:'native_image_message_changed'});
  anchor={id:'msg_new_user',type:'user',fingerprint:'c'.repeat(64)};await expect(run(input())).rejects.toMatchObject({code:'native_image_message_stale'});
  expect(calls).toBe(0);
 }finally{await runtime.close();}
});

function textContextFixture({onRead=async()=>{},onOutcome=()=>{}}={}){
 const directory='/owned',sessionID='ses_text',permit={token:'private'};
 const messages=[{info:{id:'msg_text',role:'user',sessionID},parts:[{type:'text',text:'private prompt'}]}];
 const scope={requestID:randomUUID(),directory,sessionID,permit};let calls=0,reads=0,live=true;
 const outcomes=[];
 const runtime=createNativeImageRuntime({locations:[{directory}],
  readContext:async()=>{await onRead(++reads);return structuredClone({records:messages,latestTurnParent:{id:'msg_text',type:'user',fingerprint:'a'.repeat(64)}});},
  admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{if(!live)throw Error('revoked');}},
  executionHost:{nativeContextAssets:async()=>{calls++;return {messages:structuredClone(messages),imagesSkipped:false};}},
  onOutcome:value=>{outcomes.push(value);onOutcome(value);}});
 return {runtime,scope,messages,outcomes,input:{...scope,phase:'context',messageIDs:['msg_text']},calls:()=>calls,reads:()=>reads,revoke:()=>{live=false;}};
}

test('canonical text bypasses image execution, validates both snapshots and settles its owned request',async()=>{
 const f=textContextFixture({onOutcome:()=>{throw Error('observer failed');}});
 try{
  expect(await f.runtime.transform(f.input)).toEqual({replacements:[],imagesSkipped:false});
  expect(f.calls()).toBe(0);expect(f.reads()).toBe(2);
  expect(f.outcomes).toEqual([{directory:'/owned',sessionID:'ses_text',outcome:'text-only',messageCount:1,elapsedMs:expect.any(Number)}]);
  expect(JSON.stringify(f.outcomes)).not.toContain('private prompt');
  await f.runtime.settle(f.scope);
  expect(await f.runtime.transform(f.input)).toEqual({replacements:[],imagesSkipped:false});
  await f.runtime.settle(f.scope);
 }finally{await f.runtime.close();}
});

test.each(['revoke','change'])('text bypass refuses %s during its canonical after-read',async action=>{
 const f=textContextFixture({onRead:async count=>{if(count===2){if(action==='revoke')f.revoke();else f.messages[0].parts[0].text='changed';}}});
 try{
  await expect(f.runtime.transform(f.input)).rejects.toThrow(action==='revoke'?'revoked':'native_image_message_changed');
  expect(f.calls()).toBe(0);expect(f.outcomes).toEqual([]);await f.runtime.settle(f.scope);
 }finally{await f.runtime.close();}
});

test('settling a text bypass cancels and waits for its pending canonical after-read',async()=>{
 let begin,finish;const began=new Promise(resolve=>{begin=resolve;});
 const f=textContextFixture({onRead:async count=>{if(count===2){begin();await new Promise(resolve=>{finish=resolve;});}}});
 try{
  const work=f.runtime.transform(f.input);await began;
  let settled=false;const settling=f.runtime.settle(f.scope).then(()=>{settled=true;});
  await Promise.resolve();expect(settled).toBe(false);finish();
  await expect(work).rejects.toMatchObject({code:'native_image_cancelled'});await settling;
  expect(f.calls()).toBe(0);expect(f.outcomes).toEqual([]);
 }finally{finish?.();await f.runtime.close();}
});

test.each([
 {type:'file',mime:'image/png',url:'data:image/png;base64,eA=='},
 {type:'media',media:{source:{type:'bytes'}}},
 {type:'text',text:123},
 null,
])('historical media or unknown parts retain guarded image execution: %j',async part=>{
 const f=textContextFixture();
 f.messages.unshift({info:{id:'msg_history',role:'user',sessionID:'ses_text'},parts:[part]});
 f.input.messageIDs.unshift('msg_history');
 try{
  expect(await f.runtime.transform(f.input)).toEqual({replacements:[],imagesSkipped:false});
  expect(f.calls()).toBe(1);expect(f.outcomes[0]).toMatchObject({outcome:'worker',messageCount:2});await f.runtime.settle(f.scope);
 }finally{await f.runtime.close();}
});
