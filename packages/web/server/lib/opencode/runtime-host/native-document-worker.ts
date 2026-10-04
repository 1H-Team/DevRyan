import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {NativeDocumentParsed} from './native-document.js';

const protocol='devryan-document-parser/1';
const MIB=1024*1024;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const write=(value:unknown)=>new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',cause=>cause?reject(cause):resolve()));

/** Parses only bytes already captured by the canonical attachment owner. No SDK session or permission authority is acquired here. */
export async function runNativeDocumentParserWorker(){
 let input='';
 for await(const chunk of process.stdin){input+=String(chunk);if(Buffer.byteLength(input)>16*1024)throw Error('native_document_parser_input_invalid');}
 const request:unknown=JSON.parse(input);
 if(!record(request)||Object.keys(request).some(key=>!['protocol','path','name','type','home'].includes(key))
  ||request.protocol!==protocol||typeof request.path!=='string'||typeof request.name!=='string'||request.name.length>1024
  ||!['text','pdf','docx','zip'].includes(String(request.type))||typeof request.home!=='string'
  ||request.home!==process.env.HOME||await fs.realpath(request.home)!==request.home
  ||request.path!==path.join(await fs.realpath(process.cwd()),'attachment.bin'))throw Error('native_document_parser_input_invalid');
 const file=await fs.open(request.path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes:Buffer;
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>20*MIB)throw Error('DOCUMENT_ATTACHMENT_TOO_LARGE');bytes=await file.readFile();}
 finally{await file.close();}
 if(bytes.length>20*MIB)throw Error('DOCUMENT_ATTACHMENT_TOO_LARGE');
 const originals=await import('../../../default-config/plugins/devryan-document-reader.mjs');
 const parsed:NativeDocumentParsed=await originals.parseAttachmentPayload({bytes,name:request.name,type:String(request.type)});
 // The original cache refuses this exact estimated contribution. Avoid sending an unpublishable result through the host.
 const estimated=parsed.documents.reduce((sum,document)=>sum+Buffer.byteLength(document.text)+2048,2048);
 if(estimated>64*MIB)throw Error('DOCUMENT_SESSION_CACHE_LIMIT');
 const output=Buffer.from(JSON.stringify(parsed));
 // JSON escaping can expand the original 64 MiB text budget by six times.
 if(output.length>384*MIB+MIB)throw Error('native_document_parser_output_invalid');
 let chunks=0;
 for(let offset=0;offset<output.length;offset+=32*1024)await write({protocol,type:'chunk',index:chunks++,data:output.subarray(offset,offset+32*1024).toString('base64')});
 await write({protocol,type:'result',ok:true,chunks,bytes:output.length,sha256:createHash('sha256').update(output).digest('hex')});
}

export async function reportNativeDocumentParserFailure(cause:unknown){
 const candidate=record(cause)&&typeof cause.code==='string'?cause.code:cause instanceof Error?cause.message:'';
 const code=/^(?:DOCUMENT_[A-Z_]{1,80}|native_document_[a-z_]{1,80})$/.test(candidate)?candidate:'DOCUMENT_WORKER_FAILED';
 await write({protocol,type:'result',ok:false,error:{code}});
}
