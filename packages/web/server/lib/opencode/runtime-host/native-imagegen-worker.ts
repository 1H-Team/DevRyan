import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {Effect,Layer,Schema} from 'effect';
import {Image} from '@opencode/core/image';
import {Location} from '@opencode/core/location';
import {LayerNode} from '@opencode/util/effect/layer-node';
import type {Permission} from '@opencode/core/permission';
import type {WorkerInput,NativeResult} from './worker-protocol.js';
import type {NativeImagegenOriginals} from './native-imagegen.js';
import {createNativeReadGuard} from './execution-read-guard.js';

export const IMAGEGEN_SCRATCH_LIMIT=32*1024*1024;
const inside=(root:string,file:string)=>file===root||file.startsWith(root+path.sep);
const base64=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=IMAGEGEN_SCRATCH_LIMIT
 &&value.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(value);
export interface ImagegenWorkerCallbacks {
 readonly signal:AbortSignal;
 readonly assertPermission:(input:Permission.AssertInput)=>Promise<void>;
 readonly generate:()=>Promise<void>;
}
/** The original full image executor owns only this already-supervised private view. */
export async function runNativeImagegenWorker(request:WorkerInput&{readonly tool:'gpt_imagegen'},callbacks:ImagegenWorkerCallbacks,
 originals?:NativeImagegenOriginals):Promise<typeof NativeResult.Type>{
 if(await fs.realpath(request.directory)!==request.directory||process.cwd()!==request.directory
  ||!inside(request.projectDirectory,request.directory)||process.env.HOME!==request.scratchDirectory)throw Error('native_imagegen_worker_boundary_invalid');
 const original=originals??await import('../../../../runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js');
 const input=original.reviewedImagegenInputSchema.parse(request.input);
 const guard=createNativeReadGuard({directory:request.projectDirectory,protectedRoots:[request.scratchDirectory]});
 const rebase=(file:string)=>{
  if(file.includes('\0'))throw Error('native_read_root_denied');
  if(!path.isAbsolute(file))return path.resolve(request.directory,file);
  if(!inside(request.logicalProjectDirectory,path.resolve(file)))throw Error('native_read_root_denied');
  return path.join(request.projectDirectory,path.relative(request.logicalProjectDirectory,file));
 };
 const out=rebase(input.out),images=input.images?.map(rebase);
 await guard(out);for(const file of images??[])await guard(file);
 callbacks.signal.throwIfAborted();
 await callbacks.assertPermission({sessionID:request.context.sessionID,agent:request.context.agent,action:'gpt_imagegen',
  resources:[out,...images??[]],source:{type:'tool',messageID:request.context.messageID,id:request.context.id}});
 let referenceBytes=0;
 const readFile=async(file:string)=>{
  callbacks.signal.throwIfAborted();await guard(file);
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=await handle.stat();if(!before.isFile()||before.size>20*1024*1024)throw Error('native_imagegen_reference_too_large');
   referenceBytes+=before.size;if(referenceBytes>IMAGEGEN_SCRATCH_LIMIT)throw Error('native_imagegen_reference_too_large');
   const bytes=await handle.readFile(),after=await handle.stat();
   if(bytes.length!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('native_imagegen_reference_changed');
   await guard(file);callbacks.signal.throwIfAborted();return bytes;
  }finally{await handle.close();}
 };
 const tool=(await original.GptImagePlugin({})).tool.gpt_imagegen;
 let apiKeyBilling=false;
 const generated=await original.withReviewedImagegenOwner({readFile,writeFile:async(file,bytes)=>{
  callbacks.signal.throwIfAborted();await guard(file);
  const existing=await fs.lstat(file).catch(error=>{if(error?.code==='ENOENT')return undefined;throw error;});
  if(existing?.isSymbolicLink())throw Error('native_read_root_denied');
  const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
  try{await handle.writeFile(bytes);callbacks.signal.throwIfAborted();}finally{await handle.close();}
 },generate:async(_args,references)=>{
  callbacks.signal.throwIfAborted();
  const payload=JSON.stringify({input:request.input,referenceImages:references});
  if(Buffer.byteLength(payload)>IMAGEGEN_SCRATCH_LIMIT)throw Error('native_imagegen_request_too_large');
  await fs.writeFile(path.join(request.scratchDirectory,'image-request.json'),payload,{flag:'wx',mode:0o600});
  await callbacks.generate();callbacks.signal.throwIfAborted();
  const handle=await fs.open(path.join(request.scratchDirectory,'image-result.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
  let result:unknown;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>IMAGEGEN_SCRATCH_LIMIT||(stat.mode&0o077)!==0)throw Error('native_imagegen_result_invalid');
   const bytes=await handle.readFile();if(bytes.length!==stat.size)throw Error('native_imagegen_result_invalid');result=JSON.parse(bytes.toString('utf8'));
  }finally{await handle.close();}
  if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(key=>!['base64','billing'].includes(key))
   ||!('base64' in result)||!base64(result.base64)||'billing' in result&&result.billing!=='api-key')throw Error('native_imagegen_result_invalid');
  apiKeyBilling='billing' in result&&result.billing==='api-key';
  const content=result.base64,png=Buffer.from(content,'base64');
  if(png.toString('base64')!==content||png.length<24||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(12)!==0x49484452)throw Error('native_imagegen_result_invalid');
  const location=Schema.decodeUnknownSync(Location.Info)({directory:request.directory,
   project:{id:'global',directory:request.projectDirectory,canonical:request.projectDirectory}});
  // Native Photon validates the actual generated PNG. Resizing would change
  // the original generation output, so this adapter preserves its bytes.
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
   const image=yield* Image.Service;
   yield* image.transform(editor=>editor.configure({autoResize:false,maxWidth:3840,maxHeight:3840,maxBase64Bytes:IMAGEGEN_SCRATCH_LIMIT}));
   yield* image.normalize('gpt_imagegen',{uri:'owned:imagegen',content,encoding:'base64',mime:'image/png'});
  }).pipe(Effect.provide(LayerNode.compile(Image.node,{replacements:[Location.node.replace(Layer.succeed(Location.Service,location))]})))));
  await guard(out);callbacks.signal.throwIfAborted();return content;
 }},()=>tool.execute({...input,out,...(images?{images}:{})},{directory:request.directory}));
 return apiKeyBilling?{...generated,metadata:{...generated.metadata,billing:'api-key'}}:generated;
}
