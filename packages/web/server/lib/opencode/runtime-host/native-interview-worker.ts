import fs from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {createNativeReadGuard} from './native-read-paths.js';
import type {NativeSlimInterviewRecord} from './native-slim-interview.js';

export type NativeInterviewDocumentOperation=
 |{kind:'ensure'|'read';record:NativeSlimInterviewRecord}
 |{kind:'claim';sessionID:string;baseMessageCount:number}
 |{kind:'rewrite';record:NativeSlimInterviewRecord;summary:string;title?:string}
 |{kind:'rewriteFinal';record:NativeSlimInterviewRecord;text:string}
 |{kind:'appendAnswers';record:NativeSlimInterviewRecord;questions:readonly unknown[];answers:readonly unknown[]};
const protocol='devryan-interview-document/1',MIB=1024*1024;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,512}$/.test(value);
const text=(value:unknown):value is string=>typeof value==='string'&&Buffer.byteLength(value)<=4*MIB;
const keys=(value:Record<string,unknown>,names:string[])=>Object.keys(value).every(key=>names.includes(key));
export function decodeInterviewOperation(value:unknown):NativeInterviewDocumentOperation{
 if(!object(value))throw Error('native_interview_input_invalid');
 if(value.kind==='claim'&&keys(value,['kind','sessionID','baseMessageCount'])&&id(value.sessionID)&&Number.isSafeInteger(value.baseMessageCount)&&Number(value.baseMessageCount)>=0)return {kind:'claim',sessionID:value.sessionID,baseMessageCount:Number(value.baseMessageCount)};
 const row=value.record;
 if(!object(row)||!keys(row,['id','sessionID','idea','markdownPath','createdAt','status','baseMessageCount'])||!id(row.id)||!id(row.sessionID)
  ||!text(row.idea)||typeof row.markdownPath!=='string'||typeof row.createdAt!=='string'||typeof row.status!=='string'
  ||!Number.isSafeInteger(row.baseMessageCount)||Number(row.baseMessageCount)<0)throw Error('native_interview_input_invalid');
 const record:NativeSlimInterviewRecord={id:row.id,sessionID:row.sessionID,idea:row.idea,markdownPath:row.markdownPath,createdAt:row.createdAt,status:row.status,baseMessageCount:Number(row.baseMessageCount)};
 if((value.kind==='ensure'||value.kind==='read')&&keys(value,['kind','record']))return {kind:value.kind,record};
 if(value.kind==='rewrite'&&keys(value,['kind','record','summary','title'])&&text(value.summary)&&(value.title===undefined||text(value.title)))return {kind:'rewrite',record,summary:value.summary,...typeof value.title==='string'?{title:value.title}:{}};
 if(value.kind==='rewriteFinal'&&keys(value,['kind','record','text'])&&text(value.text))return {kind:'rewriteFinal',record,text:value.text};
 if(value.kind==='appendAnswers'&&keys(value,['kind','record','questions','answers'])&&Array.isArray(value.questions)&&Array.isArray(value.answers)
  &&value.questions.length<=100&&value.answers.length<=100&&value.questions.every(question=>object(question)&&id(question.id)&&text(question.question))
  &&value.answers.every(answer=>object(answer)&&id(answer.questionId)&&text(answer.answer)))return {kind:'appendAnswers',record,questions:value.questions,answers:value.answers};
 throw Error('native_interview_input_invalid');
}
const write=(value:unknown)=>new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',cause=>cause?reject(cause):resolve()));

/** Only the original document functions execute, in the existing supervised private view. */
export async function runNativeInterviewDocumentWorker(){
 let wire='';for await(const chunk of process.stdin){wire+=String(chunk);if(Buffer.byteLength(wire)>16*1024)throw Error('native_interview_input_invalid');}
 const request:unknown=JSON.parse(wire),directory=await fs.realpath(process.cwd());
 if(!object(request)||!keys(request,['protocol','path','home'])||request.protocol!==protocol||typeof request.home!=='string'
  ||request.home!==process.env.HOME||await fs.realpath(request.home)!==request.home||request.path!==path.join(request.home,'interview-document.json')
  ||directory!==process.cwd())throw Error('native_interview_input_invalid');
 const handle=await fs.open(request.path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>16*MIB)throw Error('native_interview_input_invalid');bytes=await handle.readFile();}finally{await handle.close();}
 const decoded:unknown=JSON.parse(bytes.toString());
 if(!object(decoded)||!keys(decoded,['path','operation'])||typeof decoded.path!=='string'||!path.isAbsolute(decoded.path)||!decoded.path.endsWith('.md'))throw Error('native_interview_input_invalid');
 const target=decoded.path,relative=path.relative(directory,target);if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw Error('native_interview_path_denied');
 await createNativeReadGuard({directory})(target);
 const operation=decodeInterviewOperation(decoded.operation);
 if('record' in operation&&operation.record.markdownPath!==target)throw Error('native_interview_input_invalid');
 const original=await import('../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js');let result:string|null=null;
 if(operation.kind==='ensure')await original.ensureInterviewFile(operation.record);
 else if(operation.kind==='read')result=await original.readInterviewDocument(operation.record);
 else if(operation.kind==='claim')result=await original.claimInterviewDocument(target,operation.sessionID,operation.baseMessageCount);
 else if(operation.kind==='rewrite')result=await original.rewriteInterviewDocument(operation.record,operation.summary,operation.title);
 else if(operation.kind==='rewriteFinal')result=await original.rewriteInterviewDocumentWithFinalSpec(operation.record,operation.text);
 else if(operation.kind==='appendAnswers')await original.appendInterviewAnswers(operation.record,operation.questions,operation.answers);
 await createNativeReadGuard({directory})(target);
 const output=Buffer.from(JSON.stringify({result}));if(output.length>16*MIB)throw Error('native_interview_output_invalid');
 let chunks=0;for(let at=0;at<output.length;at+=32*1024)await write({protocol,type:'chunk',index:chunks++,data:output.subarray(at,at+32*1024).toString('base64')});
 await write({protocol,type:'result',ok:true,chunks,bytes:output.length,sha256:createHash('sha256').update(output).digest('hex')});
}
export async function reportNativeInterviewDocumentFailure(cause:unknown){
 const ownership=object(cause)&&cause.name==='InterviewDocumentOwnershipError'&&id(cause.ownerSessionID);
 const code=ownership?'native_interview_document_owned':cause instanceof Error&&/^native_interview_[a-z_]{1,80}$/.test(cause.message)?cause.message:'native_interview_document_failed';
 await write({protocol,type:'result',ok:false,error:{code,...ownership?{ownerSessionID:cause.ownerSessionID}:{}}});
}
