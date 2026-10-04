import type {Plugin} from '@opencode/plugin/promise/plugin';
/** Build-transformed, source-hash-guarded exports. Only setup belongs in the controller. */
declare const plugin:{readonly id:string;readonly setup:Plugin['setup']};
export default plugin;
export interface AstSearchInput{readonly pattern:string;readonly lang:string;readonly paths?:readonly string[];readonly globs?:readonly string[];readonly context?:number}
export interface AstReplaceInput{readonly pattern:string;readonly rewrite:string;readonly lang:string;readonly paths?:readonly string[];readonly globs?:readonly string[];readonly dryRun?:boolean}
export interface ReviewedAstContext{readonly metadata?:(input:{readonly metadata:{readonly output:string}})=>void}
export interface ReviewedAstDefinition<T>{readonly description:string;readonly args:Readonly<Record<string,{readonly parse:(input:unknown)=>unknown}>>;readonly execute:(input:T,context:ReviewedAstContext)=>Promise<string>}
export const ast_grep_search:ReviewedAstDefinition<AstSearchInput>;
export const ast_grep_replace:ReviewedAstDefinition<AstReplaceInput>;
/** Worker-only after root manifest verification, with process cwd equal to the confined private view. */
export function bindReviewedAstGrepAsset(absolutePath:string):void;

export interface ReviewedSlimConfiguration{readonly directory:string;readonly configuration:Record<string,unknown>;readonly userConfigPath?:string;readonly projectConfigPath?:string;readonly activePreset?:string}
export function bindReviewedSlimConfiguration(input:ReviewedSlimConfiguration):()=>void;

export interface ReviewedSlimCommandPart {readonly type:string;readonly text?:string;readonly [key:string]:unknown}
export interface ReviewedSlimCommandHook {
 readonly registerCommand:(configuration:{command?:Record<string,unknown>})=>void;
 readonly handleCommandExecuteBefore:(input:{readonly command:string;readonly sessionID:string;readonly arguments:string},output:{parts:ReviewedSlimCommandPart[]})=>Promise<void>;
}
export function createDeepworkCommandHook():ReviewedSlimCommandHook;
export function createLoopCommandHook():ReviewedSlimCommandHook;
export function createReflectCommandHook():ReviewedSlimCommandHook;
export interface ReviewedSlimHostBinding {
 readonly directory:string;readonly requiredHooks:readonly string[];
 readonly hooks:(input:unknown)=>Promise<Record<string,unknown>>;
 readonly log:(entry:string)=>void;
 readonly interviewBridge:{readonly registerCommand:(draft:unknown)=>void;readonly handleContext:(event:unknown)=>Promise<void>;readonly handleEvent:(event:unknown)=>Promise<void>;readonly dispose:()=>Promise<void>};
}
export function bindReviewedSlimHost(input:ReviewedSlimHostBinding):()=>void;
export interface ReviewedWebfetchInput {readonly url:string;readonly format:'text'|'markdown'|'html';readonly timeout?:number;readonly prompt?:string;readonly extract_main:boolean;readonly prefer_llms_txt:'auto'|'always'|'never';readonly include_metadata:boolean;readonly save_binary:boolean}
export interface ReviewedWebfetchContext {readonly sessionID:string;readonly abort:AbortSignal;readonly ask:(request:{readonly permission:'webfetch';readonly patterns:readonly string[];readonly always:readonly string[];readonly metadata:Readonly<Record<string,unknown>>})=>Promise<void>;readonly metadata:(request:{readonly title?:string;readonly metadata:Readonly<Record<string,unknown>>})=>void}
export interface ReviewedWebfetchDefinition {readonly description:string;readonly args:Readonly<Record<string,{readonly parse:(input:unknown)=>unknown}>>;readonly execute:(input:ReviewedWebfetchInput,context:ReviewedWebfetchContext)=>Promise<string>}
export interface ReviewedWebfetchCache {readonly get:(key:string)=>unknown;readonly set:(key:string,value:unknown)=>unknown}
export interface ReviewedWebfetchOwners {
 readonly sessionID:string;readonly signal:AbortSignal;readonly cache:ReviewedWebfetchCache;
 readonly fetch:(url:string,init:{readonly redirect:'manual';readonly signal:AbortSignal;readonly headers:Readonly<Record<string,string>>})=>Promise<Response>;
 readonly loadJSDOM:()=>Promise<unknown>;
 readonly saveBinary:(request:{readonly directory:string;readonly data:Uint8Array;readonly contentType:string;readonly filename?:string})=>Promise<string>;
 /** Must abort and settle its owned provider work before returning after cancellation. */
 readonly secondary:(request:{readonly sessionID:string;readonly model:{readonly providerID:string;readonly modelID:string;readonly variant?:string};readonly prompt:string;readonly signal:AbortSignal})=>Promise<string>;
}
export function createWebfetchTool(context:unknown,options?:Readonly<Record<string,unknown>>):ReviewedWebfetchDefinition;
export function withReviewedWebfetchOwner<T>(owner:ReviewedWebfetchOwners,action:()=>Promise<T>):Promise<T>;
export function createReviewedWebfetchCache():ReviewedWebfetchCache;
/** Original allocator, usable only in a verified confined worker; the controller factory always delegates. */
export function saveReviewedWebfetchBinary(directory:string,data:Uint8Array,contentType:string,filename?:string):Promise<string>;
export const createInterviewService:import('../../../../../server/lib/opencode/runtime-host/native-slim-interview.ts').NativeSlimInterviewFactory;
/** Original filesystem helpers are confined-worker exports, never controller authority. */
export function ensureInterviewFile(record:import('../../../../../server/lib/opencode/runtime-host/native-slim-interview.ts').NativeSlimInterviewRecord):Promise<void>;
export function claimInterviewDocument(file:string,sessionID:string,baseMessageCount:number):Promise<string>;
export function readInterviewDocument(record:import('../../../../../server/lib/opencode/runtime-host/native-slim-interview.ts').NativeSlimInterviewRecord):Promise<string>;
export function rewriteInterviewDocument(record:import('../../../../../server/lib/opencode/runtime-host/native-slim-interview.ts').NativeSlimInterviewRecord,summary:string,title?:string):Promise<string>;
export function rewriteInterviewDocumentWithFinalSpec(record:import('../../../../../server/lib/opencode/runtime-host/native-slim-interview.ts').NativeSlimInterviewRecord,text:string):Promise<string>;
export function appendInterviewAnswers(record:import('../../../../../server/lib/opencode/runtime-host/native-slim-interview.ts').NativeSlimInterviewRecord,questions:readonly unknown[],answers:readonly unknown[]):Promise<void>;
export function resolveExistingInterviewPath(directory:string,outputFolder:string,value:string):string|null;
export function resolveReviewedExistingInterviewPath(directory:string,outputFolder:string,value:string,owners:{readonly exists:(candidate:string)=>Promise<boolean>}):Promise<string|null>;
export class InterviewDocumentOwnershipError extends Error {readonly markdownPath:string;readonly ownerSessionID:string;constructor(markdownPath:string,ownerSessionID:string)}
export interface ReviewedInterviewHandlerOwners {
 readonly basePrefix?:string;
 readonly authorize:(request:import('node:http').IncomingMessage)=>Promise<void>;
 readonly outputFolder:string;
 readonly listInterviews:()=>readonly {readonly id:string;readonly [key:string]:unknown}[];
 readonly listInterviewFiles:()=>Promise<unknown>;
 readonly getState:(interviewID:string)=>Promise<unknown>;
 readonly submitAnswers:(interviewID:string,answers:readonly unknown[])=>Promise<void>;
 readonly submitBlockComment:(interviewID:string,section:string,comment:string)=>Promise<void>;
 readonly submitChat:(interviewID:string,message:string)=>Promise<void>;
 readonly handleNudgeAction:(interviewID:string,action:string)=>Promise<void>;
}
export function createInterviewHandler(owners:ReviewedInterviewHandlerOwners):(request:import('node:http').IncomingMessage,response:import('node:http').ServerResponse)=>Promise<void>;

/** Pure original hook payloads consumed by the pinned V2 bridge. */
export interface ReviewedSlimToolInput {readonly tool:string;readonly sessionID:string;readonly callID?:string;readonly directory?:string;readonly [key:string]:unknown}
export interface ReviewedSlimToolOutput {args?:unknown;output?:string;readonly [key:string]:unknown}
export type ReviewedSlimHook=(input:Record<string,unknown>,output:Record<string,unknown>)=>Promise<void>;
export interface ReviewedSlimToolLoopGuard {
 readonly 'tool.execute.before':(input:ReviewedSlimToolInput,output:ReviewedSlimToolOutput)=>Promise<void>;
 readonly 'tool.execute.after':(input:ReviewedSlimToolInput,output:ReviewedSlimToolOutput)=>Promise<void>;
 readonly observeNewUserMessage:(sessionID:string,messageID:string)=>void;
 readonly resetTurn:(sessionID:string)=>void;readonly resetSession:(sessionID:string)=>void;
}
export function createToolLoopGuardHook():ReviewedSlimToolLoopGuard;
export function createJsonErrorRecoveryHook(context:unknown):{readonly 'tool.execute.after':ReviewedSlimHook};
export function createPhaseReminderHook(options?:{readonly shouldInject?:(sessionID:string)=>boolean}):{readonly 'experimental.chat.messages.transform':ReviewedSlimHook};
export function createFilterAvailableSkillsHook(context:unknown,runtime:{readonly agents:()=>Readonly<Record<string,unknown>>;readonly disabledSkills:readonly string[]}):{readonly 'experimental.chat.messages.transform':ReviewedSlimHook};
export function createChatHeadersHook(context:{readonly directory:string;readonly client:{readonly session:{readonly message:(input:{readonly path:{readonly id:string;readonly messageID:string};readonly query:{readonly directory:string}})=>Promise<{readonly data?:{readonly parts:readonly unknown[]}}>}}}):{readonly 'chat.headers':ReviewedSlimHook};
export function createSessionCompactionBridge(): (event:unknown)=>Promise<void>;
export function collapseSystemInPlace(system:string[]):void;

export function createDisplayNameMentionRewriter(runtime:{readonly customAgentNames:readonly string[];readonly agents:()=>Readonly<Record<string,unknown>>}):(text:string)=>string;

export interface ReviewedSlimAgentData {readonly directory:string;readonly configuration:Record<string,unknown>;readonly hostConfiguration:Record<string,unknown>;readonly prompts:Record<string,{readonly prompt?:string;readonly appendPrompt?:string}>;readonly localSkills:readonly string[];readonly activePreset?:string}
export function resolveReviewedSlimAgents(input:ReviewedSlimAgentData):{readonly agents:Record<string,unknown>;readonly defaultAgent?:string;readonly runtimeChains:Readonly<Record<string,readonly string[]>>;readonly modelArrays:Readonly<Record<string,readonly {id:string;variant?:string}[]>>;readonly fallback:Readonly<Record<string,unknown>>;readonly backgroundJobs:Readonly<Record<string,unknown>>};

export interface ReviewedSlimPathOwner {readonly stat:(file:string)=>Promise<{isFile():boolean}>;readonly realpath:(file:string)=>Promise<string>;readonly readText:(file:string)=>Promise<string>}
export function withReviewedSlimPathOwner<T>(owner:ReviewedSlimPathOwner,action:()=>Promise<T>):Promise<T>;
export function createApplyPatchHook(context:{readonly directory:string;readonly worktree?:string}):{readonly 'tool.execute.before':(input:ReviewedSlimToolInput,output:ReviewedSlimToolOutput)=>Promise<void>};
export function createAbsolutePathRescueHook(context:{readonly directory:string}):ReturnType<typeof createApplyPatchHook>;
export function createSearchPathGuardHook(context:{readonly directory:string;readonly hostFlavor:'v2'}):ReturnType<typeof createApplyPatchHook>;

export interface ReviewedSlimInterviewBridgeOwner {readonly runtime:unknown;readonly service:{readonly getActiveInterviewId:(sessionID:string)=>Promise<string|null>;readonly handleCommandExecuteBefore:(input:{readonly command:string;readonly sessionID:string;readonly arguments:string},output:{parts:ReviewedSlimCommandPart[]})=>Promise<void>;readonly handleEvent:(input:{readonly event:unknown})=>Promise<void>};readonly submitCommand:(invocation:import('@opencode/plugin/effect/command').CommandInvocation)=>Promise<void>;readonly assertAcceptedCommand:(input:{readonly sessionID:string;readonly messageID:string;readonly args:string;readonly event:unknown})=>Promise<void>;readonly dispose:()=>Promise<void>}
export function createReviewedSlimInterviewBridge(owner:ReviewedSlimInterviewBridgeOwner):ReviewedSlimHostBinding['interviewBridge']&{readonly getTranscript:(sessionID:string)=>readonly unknown[]};

export const reviewedSlimInterviewCommandDeclaration:{readonly description:string;readonly template:string};

export interface ReviewedSlimFallbackInput {readonly chains:Readonly<Record<string,readonly string[]>>;readonly agent?:string;readonly currentModel?:string;readonly tried:readonly string[];readonly exhaustion:0|1|2}
export interface ReviewedSlimFallbackResult {readonly selection:null|'exhausted'|{readonly agentName?:string;readonly currentModel?:string;readonly nextModel:string;readonly ref:{readonly providerID:string;readonly modelID:string}};readonly tried:readonly string[];readonly exhaustion:0|1|2}
export function selectReviewedSlimFallback(input:ReviewedSlimFallbackInput):ReviewedSlimFallbackResult;
export function isReviewedSlimFailoverError(error:unknown):boolean;
export interface ReviewedSlimBoardJob extends Readonly<Record<string,unknown>> {readonly taskID:string;readonly alias:string;readonly agent:string;readonly state:string;readonly generation:number;readonly terminalRevision?:number;readonly terminalState?:string;readonly terminalUnreconciled?:boolean;readonly provisional?:boolean;readonly contextFiles:readonly {readonly path:string;readonly lineCount:number}[]}
export interface ReviewedSlimBoardMetadata {readonly text:string;readonly terminalUnreconciledTaskIDs:readonly {readonly taskID:string;readonly generation:number;readonly terminalRevision?:number}[]}
export function formatReviewedSlimTaskBoard(input:{readonly jobs:readonly ReviewedSlimBoardJob[];readonly reusable:readonly ReviewedSlimBoardJob[];readonly readContextMaxFiles?:number}):ReviewedSlimBoardMetadata|null;
export interface ReviewedSlimBoardOwners {readonly shouldManageSession:(sessionID:string)=>boolean;readonly strategy?:'latest'|'checkpoint-compatible';readonly maxRetainedSnapshots?:number;readonly board:{readonly get:(taskID:string)=>ReviewedSlimBoardJob|undefined;readonly formatForPromptWithMetadata:(sessionID:string)=>ReviewedSlimBoardMetadata|null;readonly markReconciled:(taskID:string,at:undefined,generation:number,terminalRevision?:number)=>ReviewedSlimBoardJob|undefined}}
export function createReviewedSlimTaskBoardRenderer(owner:ReviewedSlimBoardOwners):{readonly transform:ReviewedSlimHook;readonly clearSession:(sessionID:string)=>void};
/** Constructor binding is called only in the actual confined worker with cwd equal to its private view. */
export function bindReviewedSlimImageWorker(directory:string):void;
export function processReviewedSlimImageAttachments(input:{readonly messages:Record<string,unknown>[];readonly workDir:string;readonly imageRouting:'auto'|'direct';readonly disabledAgents:ReadonlySet<string>;readonly log:(message:string)=>void}):boolean;

export interface ReviewedSlimImageState {readonly schema:1;readonly logicalDirectory:string;readonly cleanup:readonly (readonly [string,number])[];readonly counts:readonly (readonly [string,number])[];readonly resolved:readonly (readonly [string,string])[]}
export function snapshotReviewedSlimImageState(logicalDirectory:string):ReviewedSlimImageState;
export function restoreReviewedSlimImageState(state:ReviewedSlimImageState,logicalDirectory:string):void;
