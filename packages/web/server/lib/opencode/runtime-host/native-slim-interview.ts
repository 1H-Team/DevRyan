import path from 'node:path';
import type {ReviewedSlimCommandPart} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

export interface NativeSlimInterviewRecord {
 readonly id:string;readonly sessionID:string;readonly idea:string;readonly markdownPath:string;
 readonly createdAt:string;readonly status:string;readonly baseMessageCount:number;
}
export interface NativeSlimInterviewRuntime {
 readonly messages:(sessionID:string)=>Promise<readonly {readonly info:{readonly role:string;readonly id?:string};readonly parts?:readonly unknown[]}[]>;
 readonly notify:(sessionID:string,text:string)=>Promise<void>;
 readonly continue:(sessionID:string,text:string,model?:{readonly providerID:string;readonly modelID:string})=>Promise<void>;
 readonly rename:(sessionID:string,title:string)=>Promise<void>;
}
export interface NativeSlimInterviewDocuments {
 readonly withLock:<T>(file:string,action:()=>Promise<T>)=>Promise<T>;
 readonly ensure:(record:NativeSlimInterviewRecord)=>Promise<void>;
 readonly claim:(file:string,sessionID:string,baseMessageCount:number)=>Promise<string>;
 readonly read:(record:NativeSlimInterviewRecord)=>Promise<string>;
 readonly rewrite:(record:NativeSlimInterviewRecord,summary:string,title?:string)=>Promise<string>;
 readonly rewriteFinal:(record:NativeSlimInterviewRecord,text:string)=>Promise<string>;
 readonly appendAnswers:(record:NativeSlimInterviewRecord,questions:readonly unknown[],answers:readonly unknown[])=>Promise<void>;
 readonly readText:(file:string,encoding:'utf8')=>Promise<string>;
 readonly list:(directory:string)=>Promise<string[]>;
 readonly resolveExisting:(directory:string,outputFolder:string,value:string)=>Promise<string|null>;
}
export interface NativeSlimInterviewService {
 readonly setBaseUrlResolver:(resolver:()=>Promise<string>)=>void;
 readonly setStatePushCallback:(callback:(state:unknown)=>void)=>void;
 readonly setOnInterviewCreated:(callback:(record:NativeSlimInterviewRecord)=>void)=>void;
 readonly getActiveInterviewId:(sessionID:string)=>string|null;
 readonly registerCommand:(configuration:{command?:Record<string,unknown>})=>void;
 readonly handleCommandExecuteBefore:(input:{readonly command:string;readonly sessionID:string;readonly arguments:string},output:{parts:ReviewedSlimCommandPart[]})=>Promise<void>;
 readonly handleEvent:(input:{readonly event:unknown})=>Promise<void>;
 readonly getInterviewState:(interviewID:string)=>Promise<unknown>;
 readonly listInterviewFiles:()=>Promise<unknown>;
 readonly listInterviews:()=>unknown;
 readonly submitAnswers:(interviewID:string,answers:readonly unknown[])=>Promise<void>;
 readonly submitBlockComment:(interviewID:string,section:string,comment:string)=>Promise<void>;
 readonly submitChat:(interviewID:string,message:string)=>Promise<void>;
 readonly handleNudgeAction:(interviewID:string,action:string)=>Promise<void>;
}
export interface NativeSlimInterviewDependencies {
 readonly runtime:NativeSlimInterviewRuntime;readonly documents:NativeSlimInterviewDocuments;
 readonly openBrowser:(url:string)=>void;readonly env:Readonly<Record<string,string|undefined>>;
}
export type NativeSlimInterviewFactory=(context:{readonly directory:string},configuration:Readonly<Record<string,unknown>>,dependencies:NativeSlimInterviewDependencies)=>NativeSlimInterviewService;

/** Node-only construction. Every injected IO method retains the existing owned permit/ledger fence. */
export function createReviewedSlimInterviewService(input:{readonly directory:string;readonly configuration:Readonly<Record<string,unknown>>;readonly factory:NativeSlimInterviewFactory}&NativeSlimInterviewDependencies):NativeSlimInterviewService {
 if(!path.isAbsolute(input.directory)||input.directory!==path.resolve(input.directory))throw new Error('native_interview_location_unreviewed');
 const output=input.configuration.outputFolder??'interview';
 if(typeof output!=='string')throw new Error('native_interview_output_invalid');
 // The original normalizer trims outer slashes. Preserve its accepted relative
 // spelling while refusing escape before the state machine can request IO.
 const normalized=output.trim().replace(/^\/+|\/+$/g,'')||'interview';
 const destination=path.resolve(input.directory,normalized),relative=path.relative(input.directory,destination);
 if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||normalized.split(/[\\/]/).includes('.git'))throw new Error('native_interview_output_unreviewed');
 for(const key of ['messages','notify','continue','rename'] as const)if(typeof input.runtime[key]!=='function')throw new Error('native_interview_runtime_required');
 for(const key of ['withLock','ensure','claim','read','rewrite','rewriteFinal','appendAnswers','readText','list','resolveExisting'] as const)if(typeof input.documents[key]!=='function')throw new Error('native_interview_document_owner_required');
 if(typeof input.openBrowser!=='function'||!input.env)throw new Error('native_interview_browser_owner_required');
 return input.factory({directory:input.directory},input.configuration,{runtime:input.runtime,documents:input.documents,openBrowser:input.openBrowser,env:input.env});
}
