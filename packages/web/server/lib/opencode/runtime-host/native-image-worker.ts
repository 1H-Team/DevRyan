import fs from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import type {ReviewedSlimImageState} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

export interface NativeImageInput {readonly messages:Record<string,unknown>[];readonly imageRouting:'auto'|'direct';readonly disabledAgents:readonly string[];readonly logicalDirectory:string;readonly state?:ReviewedSlimImageState}
export interface NativeImageResult {readonly messages:Record<string,unknown>[];readonly imagesSkipped:boolean;readonly privateDirectory:string;readonly state:ReviewedSlimImageState}
const protocol='devryan-context-images/1',MIB=1024*1024;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const imageState=(value:unknown):value is ReviewedSlimImageState=>record(value)&&value.schema===1&&typeof value.logicalDirectory==='string'
 &&Object.keys(value).every(key=>['schema','logicalDirectory','cleanup','counts','resolved'].includes(key))
 &&Array.isArray(value.cleanup)&&Array.isArray(value.counts)&&Array.isArray(value.resolved)
 &&value.cleanup.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&typeof row[1]==='number')
 &&value.counts.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&typeof row[1]==='number')
 &&value.resolved.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&typeof row[1]==='string');
const write=(value:unknown)=>new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',cause=>cause?reject(cause):resolve()));

/** The original image algorithm runs only in the existing ledger's supervised private view. */
export async function runNativeImageWorker(input:NativeImageInput):Promise<NativeImageResult>{
 const directory=await fs.realpath(process.cwd());
 if(directory!==process.cwd()||!record(input)||Object.keys(input).some(key=>!['messages','imageRouting','disabledAgents','logicalDirectory','state'].includes(key))
  ||!Array.isArray(input.messages)||input.messages.length>2000||!['auto','direct'].includes(input.imageRouting)
  ||!Array.isArray(input.disabledAgents)||input.disabledAgents.length>100||input.disabledAgents.some(value=>typeof value!=='string')
  ||!path.isAbsolute(input.logicalDirectory)||path.resolve(input.logicalDirectory)!==input.logicalDirectory)throw Error('native_image_input_invalid');
 for(const message of input.messages)if(!record(message)||!record(message.info)||message.info.role!=='user'
  ||typeof message.info.id!=='string'||typeof message.info.sessionID!=='string'||!Array.isArray(message.parts))throw Error('native_image_input_invalid');
 const originals=await import('../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js');
 originals.bindReviewedSlimImageWorker(directory);
 if(input.state)originals.restoreReviewedSlimImageState(input.state,input.logicalDirectory);
 const messages=structuredClone(input.messages);
 const imagesSkipped=originals.processReviewedSlimImageAttachments({messages,workDir:directory,imageRouting:input.imageRouting,
  disabledAgents:new Set(input.disabledAgents),log:()=>{}});
 return {messages,imagesSkipped,privateDirectory:directory,state:originals.snapshotReviewedSlimImageState(input.logicalDirectory)};
}

export async function runNativeImageWorkerEntry(){
 let input='';for await(const chunk of process.stdin){input+=String(chunk);if(Buffer.byteLength(input)>16*1024)throw Error('native_image_input_invalid');}
 const request:unknown=JSON.parse(input),directory=await fs.realpath(process.cwd());
 if(!record(request)||Object.keys(request).some(key=>!['protocol','path','home'].includes(key))||request.protocol!==protocol
  ||typeof request.home!=='string'||request.home!==process.env.HOME||await fs.realpath(request.home)!==request.home
  ||request.path!==path.join(request.home,'context-images.json'))throw Error('native_image_input_invalid');
 const file=await fs.open(request.path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>65*MIB)throw Error('native_image_input_invalid');bytes=await file.readFile();}finally{await file.close();}
 const decoded:unknown=JSON.parse(bytes.toString());
 if(!record(decoded)||!Array.isArray(decoded.messages)||!Array.isArray(decoded.disabledAgents)||!['auto','direct'].includes(String(decoded.imageRouting))
  ||typeof decoded.logicalDirectory!=='string'||decoded.state!==undefined&&!imageState(decoded.state))throw Error('native_image_input_invalid');
 const messages:Record<string,unknown>[]=[];for(const message of decoded.messages){if(!record(message))throw Error('native_image_input_invalid');messages.push(message);}
 const disabledAgents:string[]=[];for(const agent of decoded.disabledAgents){if(typeof agent!=='string')throw Error('native_image_input_invalid');disabledAgents.push(agent);}
 const inputValue:NativeImageInput={messages,imageRouting:decoded.imageRouting==='auto'?'auto':'direct',disabledAgents,logicalDirectory:decoded.logicalDirectory,
  ...imageState(decoded.state)?{state:decoded.state}:{}};
 if(Object.keys(decoded).some(key=>!['messages','imageRouting','disabledAgents','logicalDirectory','state'].includes(key)))throw Error('native_image_input_invalid');
 const result=await runNativeImageWorker(inputValue);if(result.privateDirectory!==directory)throw Error('native_image_boundary_invalid');
 const output=Buffer.from(JSON.stringify(result));if(output.length>128*MIB)throw Error('native_image_output_invalid');
 let chunks=0;for(let offset=0;offset<output.length;offset+=32*1024)await write({protocol,type:'chunk',index:chunks++,data:output.subarray(offset,offset+32*1024).toString('base64')});
 await write({protocol,type:'result',ok:true,chunks,bytes:output.length,sha256:createHash('sha256').update(output).digest('hex')});
}
export async function reportNativeImageWorkerFailure(cause:unknown){
 const code=cause instanceof Error&&/^native_image_[a-z_]{1,80}$/.test(cause.message)?cause.message:'native_image_worker_failed';
 await write({protocol,type:'result',ok:false,error:{code}});
}
