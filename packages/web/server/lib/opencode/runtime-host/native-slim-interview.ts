import path from 'node:path';
import type * as AgentsCore from '@devryan/agents-core';

// The interview contract is owned by agents-core; these names keep the host's
// existing vocabulary.
export type NativeSlimInterviewRecord=AgentsCore.ReviewedInterviewRecord;
export type NativeSlimInterviewQuestion=AgentsCore.ReviewedInterviewQuestion;
export type NativeSlimInterviewAnswer=AgentsCore.ReviewedInterviewAnswer;
export type NativeSlimInterviewRuntime=AgentsCore.ReviewedInterviewRuntime;
export type NativeSlimInterviewDocuments=AgentsCore.ReviewedInterviewDocuments;
export type NativeSlimInterviewService=AgentsCore.ReviewedInterviewService;
export interface NativeSlimInterviewDependencies extends AgentsCore.ReviewedInterviewDependencies {readonly env:Readonly<Record<string,string|undefined>>}
export type NativeSlimInterviewFactory=typeof AgentsCore.createInterviewService;

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
 for(const key of ['withLock','ensure','claim','read','rewrite','rewriteFinal','markComplete','markIncomplete','appendAnswers','readText','list','stat','resolveExisting'] as const)if(typeof input.documents[key]!=='function')throw new Error('native_interview_document_owner_required');
 if(typeof input.openBrowser!=='function'||!input.env)throw new Error('native_interview_browser_owner_required');
 return input.factory({directory:input.directory},input.configuration,{runtime:input.runtime,documents:input.documents,openBrowser:input.openBrowser,env:input.env});
}
