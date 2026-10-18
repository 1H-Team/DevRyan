import type {IncomingMessage,ServerResponse} from 'node:http';
import type * as AgentsCore from '@openchamber/agents-core';
import type {NativeSlimInterviewFactory,NativeSlimInterviewService} from './native-slim-interview.js';
import type {NativeInterviewDocumentScope,NativeInterviewDocumentAuthority,NativeInterviewDocumentResult} from './native-interview-document.js';
import type {RegistrationOrigin} from './registration-origin.js';
export interface NativeInterviewGrant {recheck:()=>Promise<void>;signal?:AbortSignal}
export interface NativeInterviewCommand {directory:string;sessionID:string;messageID:string;args:string;permit:unknown}
export interface NativeInterviewScope extends NativeInterviewGrant {directory:string;sessionID:string;messageID:string;authorizationID:string}
export interface NativeInterviewIdentity {id:string;directory:string;sessionID:string;messageID:string;authorizationID:string}
export interface NativeInterviewUIAuthorization {directory:string;operation:string;interview?:NativeInterviewIdentity}
export interface NativeInterviewRuntime {
 messages:(scope:NativeInterviewScope)=>Promise<readonly {info:{role:string;id?:string};parts?:readonly unknown[]}[]>;
 continue:(scope:NativeInterviewScope,input:{text:string;model?:{providerID:string;modelID:string}})=>Promise<void>;
 notify:(scope:NativeInterviewScope,input:{text:string})=>Promise<void>;
 rename:(scope:NativeInterviewScope,input:{title:string})=>Promise<void>;
}
export interface NativeInterviewOriginals {
 createInterviewService:NativeSlimInterviewFactory;
 createInterviewHandler:typeof AgentsCore.createInterviewHandler;
 resolveExistingInterviewPath:typeof AgentsCore.resolveReviewedExistingInterviewPath;
 InterviewDocumentOwnershipError:typeof AgentsCore.InterviewDocumentOwnershipError;
 InterviewPatchApplyError:typeof AgentsCore.InterviewPatchApplyError;
 InterviewPatchRequiredError:typeof AgentsCore.InterviewPatchRequiredError;
}
export interface NativeInterviewOwnerOptions {
 locations:readonly {directory:string;configuration:Readonly<Record<string,unknown>>;basePrefix?:string;readRoots?:readonly string[];protectedRoots?:readonly string[]}[];
 originals:NativeInterviewOriginals;origin:RegistrationOrigin;
 captureInterviewAuthorization:(input:NativeInterviewCommand)=>Promise<NativeInterviewGrant&{authorizationID:string}>;
 captureInterviewUIAuthorization:(input:NativeInterviewUIAuthorization,request:IncomingMessage)=>Promise<NativeInterviewGrant>;
 captureInterviewEventAuthorization:(input:{directory:string;sessionID:string;messageID:string;authorizationID:string;event:unknown})=>Promise<NativeInterviewGrant>;
 runtime:NativeInterviewRuntime;
 executeDocument:(input:NativeInterviewDocumentScope,authority:NativeInterviewDocumentAuthority)=>Promise<NativeInterviewDocumentResult>;
 baseURL:(directory:string)=>Promise<string>;
 openBrowser:(scope:NativeInterviewScope,url:string)=>Promise<void>;
}
export function createNativeInterviewOwner(options:NativeInterviewOwnerOptions):{
 handleCommand:(input:NativeInterviewCommand,parts:Parameters<NativeSlimInterviewService['handleCommandExecuteBefore']>[1]['parts'],context?:{signal?:AbortSignal})=>Promise<void>;
 handleEvent:(input:{directory:string;sessionID:string;event:unknown})=>Promise<void>;
 handleRequest:(input:{directory:string;request:IncomingMessage;response:ServerResponse})=>Promise<void>;
 getActiveInterviewId:(scope:{directory:string;sessionID:string})=>Promise<string|null>;
 close:()=>Promise<void>;
};
