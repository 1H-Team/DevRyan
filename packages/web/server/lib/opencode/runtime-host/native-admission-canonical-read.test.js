import {AsyncLocalStorage} from 'node:async_hooks';
import {expect,test} from 'vitest';
import {createOpenCodeClient} from '../opencode-client/index.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';

test('closed prompt context permits only canonical client Store reads while retained Cursor checks stay fresh',async()=>{
 const directory='/fixture/cursor',sessionID='ses_cursor',userMessageID='msg_user';
 const scope={directory,sessionID,userMessageID,assistantMessageID:'msg_assistant',agent:'build',modelID:'composer',variant:'default'};
 const caller=new AsyncLocalStorage(),original=Object.freeze({id:'original'}),gate=Promise.withResolvers(),requests=[];
 let owner,allowed=true,revision=0,retained,work;
 const nativeSession={id:sessionID,location:{directory},agent:'build',model:{providerID:'cursor-acp',id:'composer',variant:'default'},time:{created:1,updated:1}};
 const user={id:userMessageID,type:'user',text:'fixture',time:{created:1}};
 const assistant={id:scope.assistantMessageID,type:'assistant',agent:'build',model:nativeSession.model,content:[],time:{created:2}};
 const client=createOpenCodeClient({getRuntime:()=>({generation:2,baseUrl:'http://127.0.0.1',version:'2.0.20'}),
  getAuthHeaders:()=>({authorization:'Bearer fixture-controller',...owner.requestHeaders()}),
  withNativeWebOperation:(spec,action)=>owner.withWebOperation(spec,action),fetchImpl:async(url,options)=>{
   expect(caller.getStore()).toBe(original);expect(options.headers.authorization).toBe('Bearer fixture-controller');
   expect(options.headers['x-devryan-native-permit']).toBeUndefined();requests.push(new URL(url).pathname);
   const pathname=new URL(url).pathname;
   return Response.json({data:pathname.endsWith('/message/msg_assistant')?assistant:pathname.endsWith('/message')?[assistant,user]:nativeSession});
  }});
 owner=createNativeAdmissionOwner({directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({held:false,revision})},
  getSession:id=>client.sessions.get(id),authorizeOperation:async()=>{throw Error('unowned');},
  captureWebAuthorization:async()=>{expect(caller.getStore()).toBe(original);return async()=>{if(!allowed)throw Error('revoked');};}});
 const metadata={devryan:{v:1,origin:'human',agent:'build',providerID:'cursor-acp',modelID:'composer',planMode:false,
  parts:[{kind:'text',length:7}],admission:{v:1,fingerprint:'a'.repeat(64)}}};
 try{
  await caller.run(original,()=>owner.withAcceptedOperation({sessionID,messageID:userMessageID,fingerprint:'a'.repeat(64),metadata,
   request:{id:userMessageID,text:'fixture',metadata,delivery:'queue'}},async()=>{
   retained=await owner.captureCursorAuthorization(scope);
   work=gate.promise.then(async()=>{
    expect(()=>owner.requestHeaders()).toThrow('native_permit_invalid');
    expect((await client.sessions.get(sessionID)).id).toBe(sessionID);
    expect((await client.sessions.message(sessionID,scope.assistantMessageID)).info.id).toBe(scope.assistantMessageID);
    for(const spec of [
     {operation:'prompt',method:'POST',path:`/api/session/${sessionID}/prompt`},
     {operation:'sessions.get',method:'GET',path:'/api/fs/read/fixture'},
     {operation:'sessions.get',method:'GET',path:'/api/experimental/persistent-pty/pty_fixture/connect'},
     {operation:'sessions.message',method:'GET',path:`/api/session/${sessionID}/message?limit=10&takeover=true`},
     {operation:'sessions.get',method:'GET',path:`/api/session/${sessionID}?unexpected=true`},
    ])await expect(owner.withWebOperation(spec,async()=>owner.requestHeaders())).rejects.toMatchObject({code:'native_permit_invalid'});
    await retained.recheck();allowed=false;await expect(retained.recheck()).rejects.toThrow('revoked');allowed=true;
    revision++;await expect(retained.recheck()).rejects.toMatchObject({code:'native_cursor_scope_revoked'});revision--;
   });
  }));
  gate.resolve();await work;
  expect(requests).toContain(`/api/session/${sessionID}/message`);
  await owner.invalidateController();await expect(retained.recheck()).rejects.toMatchObject({code:'native_permit_revoked'});
 }finally{gate.resolve();await work?.catch(()=>{});owner.dispose();}
});
