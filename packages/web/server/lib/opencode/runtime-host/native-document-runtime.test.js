import {test,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {createNativeDocumentRuntime} from './native-document-runtime.js';

test('canonical document bytes, exact origin, revocation and real cancellation settlement',async()=>{
 const origin={kind:'plugin',id:'devryan.document-reader',manifestDigest:'a'.repeat(64),capabilities:['read']};
 const directory='/fixture',sessionID='ses_doc',permit={token:'p',sessionID,revision:0};
 let live=true,parsing=false,finish,started;
 const check=async()=>{if(!live)throw Error('revoked');};
 const runtime=createNativeDocumentRuntime({origin,locations:[{directory}],
  admissionOwner:{captureSessionHookAuthorization:async()=>check,withPermit:async(_input,action)=>{await check();return action();},recheckExecution:check},
  readUserAttachments:async()=>[{messageID:'msg_user',part:{id:'msg_user:file:0',mime:'text/plain',filename:'note.txt',url:'data:text/plain;base64,'+Buffer.from('Exact canonical bytes').toString('base64')}}],
  documentOwner:{ownersFor:async()=>({listAccessibleDocuments:async()=>[]})},
  reviewedConfiguration:{reviewedDocumentOriginals:{},createOwnedNativeDocument:()=>({tool:{execute:async()=>{await check();return 'original list';}},
   transformAttachment:async(part,context)=>{
    if(parsing){started();await new Promise(resolve=>{finish=resolve;context.abort.addEventListener('abort',()=>{/* supervisor still settling */},{once:true});});context.abort.throwIfAborted();}
    await check();return 'Original renderer: '+Buffer.from(part.url.split(',')[1],'base64').toString();
   }})}});
 const input={requestID:randomUUID(),directory,sessionID,permit,phase:'context',messageIDs:['msg_user']};
 const scope=value=>({requestID:value.requestID,directory,sessionID,permit});
 try{
  const result=await runtime.context(input);expect(result.replacements).toHaveLength(1);
  expect(result.replacements[0]).toMatchObject({messageID:'msg_user',text:'Original renderer: Exact canonical bytes',sha256:createHash('sha256').update('Exact canonical bytes').digest('hex')});
  expect(JSON.stringify(result)).not.toContain('base64');await runtime.settle(scope(input));
  const forged={...input,requestID:randomUUID(),messages:[{file:'forged'}]};await expect(runtime.context(forged)).rejects.toMatchObject({code:'native_document_context_invalid'});await runtime.settle(scope(forged));
  const tool={requestID:randomUUID(),directory,sessionID,permit,tool:'devryan_document',messageID:'msg_assistant',callID:'call_doc',input:{action:'list'},authorization:{input:{provenance:origin}}};
  await expect(runtime.tool(tool)).resolves.toBe('original list');await runtime.settle(scope(tool));
  const bad={...tool,requestID:randomUUID(),authorization:{input:{provenance:{...origin,manifestDigest:'wrong'}}}};
  await expect(runtime.tool(bad)).rejects.toMatchObject({code:'native_document_tool_scope_invalid'});await runtime.settle(scope(bad));
  const revoked={...input,requestID:randomUUID()};live=false;await expect(runtime.context(revoked)).rejects.toThrow('revoked');await runtime.settle(scope(revoked));live=true;
  parsing=true;const began=new Promise(resolve=>{started=resolve;}),cancelled={...input,requestID:randomUUID()};
  const work=runtime.context(cancelled);await began;
  let settled=false;const settling=runtime.settle(scope(cancelled)).then(()=>{settled=true;});await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
  finish();await expect(work).rejects.toMatchObject({code:'native_document_cancelled'});await settling;expect(settled).toBe(true);
  const late={...input,requestID:randomUUID()};await runtime.settle(scope(late));await expect(()=>runtime.context(late)).toThrow('native_document_cancelled');
 }finally{finish?.();await runtime.close();}
});
