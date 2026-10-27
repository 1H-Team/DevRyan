import {createHash,randomUUID} from 'node:crypto';
import {Schema} from 'effect';
import type {ExecutionRpc} from './worker-protocol.js';
import type {NativeSlimHookAuthority} from './native-slim-runtime.js';
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const schema=Schema.Struct({imagesSkipped:Schema.Boolean,replacements:Schema.Array(Schema.Struct({messageID:Schema.String,text:Schema.String,
 images:Schema.Array(Schema.Struct({sha256:Schema.String,mime:Schema.String,name:Schema.String}))}))});
/** The pinned bridge exposes native content as legacy parts. Preserve every
 * untouched reference and remove only the exact canonical media bytes. */
export function applyNativeImageContext(messages:unknown[],result:typeof schema.Type){
 for(const replacement of result.replacements){
  const message=messages.find(row=>record(row)&&record(row.info)&&row.info.role==='user'&&row.info.id===replacement.messageID);
  if(!record(message)||!Array.isArray(message.parts))throw new Error('native_image_context_identity_changed');
  const parts=[...message.parts];
  for(const image of replacement.images){
   const index=parts.findIndex(part=>{
    if(!record(part)||part.type!=='media'||!record(part.media)||!record(part.media.source))return false;
    const source=part.media.source;
    const digest=source.type==='base64'&&typeof source.data==='string'?hash(Buffer.from(source.data,'base64'))
     :source.type==='bytes'&&source.data instanceof Uint8Array?hash(source.data):undefined;
    return digest===image.sha256&&source.mediaType===image.mime&&(part.filename??'')===image.name;
   });
   if(index<0)throw new Error('native_image_context_identity_changed');parts.splice(index,1);
  }
  parts.push({type:'text',text:replacement.text});message.parts=parts;
 }
}
export function createControllerImages(rpc:ExecutionRpc,notifySkipped:(authority:NativeSlimHookAuthority)=>Promise<void>){
 return async(authority:NativeSlimHookAuthority,_input:Record<string,unknown>,output:Record<string,unknown>)=>{
  if(authority.domain!=='session'||authority.phase!=='context'||!Array.isArray(output.messages))throw new Error('native_image_context_invalid');
  const ids=output.messages.flatMap(row=>record(row)&&record(row.info)&&row.info.role==='user'&&typeof row.info.id==='string'&&/^msg[A-Za-z0-9_-]{1,128}$/.test(row.info.id)?[row.info.id]:[]);
  if(!ids.length)return;
  const scope={requestID:randomUUID(),directory:authority.directory,sessionID:authority.sessionID,permit:authority.permit};
  try{
   const raw=await rpc('native.slim.images',{...scope,phase:'context',messageIDs:[...new Set(ids)]},{signal:authority.signal});
   const result=Schema.decodeUnknownSync(schema)(raw,{onExcessProperty:'error'});authority.signal.throwIfAborted();
   applyNativeImageContext(output.messages,result);if(result.imagesSkipped)await notifySkipped(authority);
  }finally{await rpc('native.slim.images.settle',scope);}
 };
}
