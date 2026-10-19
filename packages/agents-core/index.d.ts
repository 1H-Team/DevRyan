// Declared surface of @devryan/agents-core, the only contract the DevRyan
// runtime host compiles against. src/devryan/surface-check.ts proves the
// implementation (src/devryan/index.ts) is assignable to these declarations.
// Every authority (files, network, processes, configuration, provider calls)
// is lent by the host through the bind*/with* owners and fails closed unbound.
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Plugin} from '@opencode/plugin/promise/plugin';

/** v2 plugin entry. Only `setup` belongs in the controller. */
declare const plugin:{readonly id:string;readonly setup:Plugin['setup']};
export default plugin;

// ---------------------------------------------------------------------------
// Tools.

export type ReviewedToolResult=string|{readonly title?:string;readonly output:string;readonly metadata?:Readonly<Record<string,unknown>>;
 readonly attachments?:readonly {readonly type:'file';readonly mime:string;readonly url:string;readonly filename?:string}[]};
export interface ReviewedToolArgument {readonly parse:(input:unknown)=>unknown}
export interface AstSearchInput{readonly pattern:string;readonly lang:string;readonly paths?:readonly string[];readonly globs?:readonly string[];readonly context?:number}
export interface AstReplaceInput{readonly pattern:string;readonly rewrite:string;readonly lang:string;readonly paths?:readonly string[];readonly globs?:readonly string[];readonly dryRun?:boolean}
/** The AST tools read only `metadata` from their context. */
export interface ReviewedAstContext{readonly metadata?:(input:{readonly metadata:{readonly output:string}})=>void}
export interface ReviewedAstDefinition<T>{readonly description:string;readonly args:Readonly<Record<string,ReviewedToolArgument>>;execute(input:T,context:ReviewedAstContext):Promise<ReviewedToolResult>}
export const ast_grep_search:ReviewedAstDefinition<AstSearchInput>;
export const ast_grep_replace:ReviewedAstDefinition<AstReplaceInput>;
/** Worker-only after root manifest verification, with process cwd equal to the confined private view. */
export function bindReviewedAstGrepAsset(absolutePath:string):void;

export interface ReviewedWebfetchInput {readonly url:string;readonly format:'text'|'markdown'|'html';readonly timeout?:number;readonly prompt?:string;readonly extract_main:boolean;readonly prefer_llms_txt:'auto'|'always'|'never';readonly include_metadata:boolean;readonly save_binary:boolean}
/** All webfetch reads from its context; `extra.model.capabilities` gates inline images. */
export interface ReviewedWebfetchContext {readonly sessionID:string;readonly abort:AbortSignal;
 ask(request:{permission:string;patterns:string[];always:string[];metadata:Record<string,unknown>}):Promise<void>;
 metadata(request:{title?:string;metadata?:Record<string,unknown>}):void;
 readonly extra?:{readonly model?:{readonly capabilities?:{readonly input?:{readonly image?:boolean}}}}}
export interface ReviewedWebfetchDefinition {readonly description:string;readonly args:Readonly<Record<string,ReviewedToolArgument>>;execute(input:ReviewedWebfetchInput,context:ReviewedWebfetchContext):Promise<ReviewedToolResult>}
export interface ReviewedWebfetchOptions {
 readonly binaryDir?:string;
 /** Inline image attachments are returned only when this answers 'direct'. */
 readonly imageRouting?:()=>'auto'|'direct';
 readonly webfetchModels?:readonly {readonly id:string;readonly variant?:string}[];
 readonly smallModelRef?:()=>string|undefined;
 readonly explorerModel?:string;readonly librarianModel?:string;
}
/** Opaque LRU handle (50 MiB, 15 minutes) from createReviewedWebfetchCache, owned by the host per grant scope. */
export type ReviewedWebfetchCache=object;
export interface ReviewedWebfetchOwners {
 readonly sessionID:string;readonly signal:AbortSignal;readonly cache:ReviewedWebfetchCache;
 readonly fetch:(url:string,init:{readonly redirect:'manual';readonly signal:AbortSignal;readonly headers:Readonly<Record<string,string>>})=>Promise<Response>;
 readonly loadJSDOM:()=>Promise<unknown>;
 readonly saveBinary:(request:{readonly directory:string;readonly data:Uint8Array;readonly contentType:string;readonly filename?:string})=>Promise<string>;
 /** Must abort and settle its owned provider work before returning after cancellation. */
 readonly secondary:(request:{readonly sessionID:string;readonly model:{readonly providerID:string;readonly modelID:string;readonly variant?:string};readonly prompt:string;readonly signal:AbortSignal})=>Promise<string>;
}
export function createWebfetchTool(context:object,options?:ReviewedWebfetchOptions):ReviewedWebfetchDefinition;
export function withReviewedWebfetchOwner<T>(owner:ReviewedWebfetchOwners,action:()=>Promise<T>):Promise<T>;
export function createReviewedWebfetchCache():ReviewedWebfetchCache;
/** Original allocator, usable only in a verified confined worker; the controller factory always delegates. */
export function saveReviewedWebfetchBinary(directory:string,data:Uint8Array,contentType:string,filename?:string):Promise<string>;

// ---------------------------------------------------------------------------
// Location bindings.

export interface ReviewedSlimConfiguration{readonly directory:string;readonly configuration:Record<string,unknown>;readonly userConfigPath?:string;readonly projectConfigPath?:string;readonly activePreset?:string}
export function bindReviewedSlimConfiguration(input:ReviewedSlimConfiguration):()=>void;

/** Created by createReviewedSlimInterviewBridge and handed back through bindReviewedSlimHost; v2 setup calls it with v2 payloads. */
export interface ReviewedSlimInterviewBridgeBinding {registerCommand(draft:unknown):void;handleContext(event:unknown):Promise<void>;handleEvent(event:unknown):Promise<void>;dispose():Promise<void>}
export interface ReviewedSlimHostBinding {
 readonly directory:string;readonly requiredHooks:readonly string[];
 readonly hooks:(input:unknown)=>Promise<Record<string,unknown>>;
 readonly log:(entry:string)=>void;
 readonly interviewBridge:ReviewedSlimInterviewBridgeBinding;
}
export function bindReviewedSlimHost(input:ReviewedSlimHostBinding):()=>void;

// ---------------------------------------------------------------------------
// Commands and hooks composed by the host.

export interface ReviewedSlimCommandPart {readonly type:string;readonly text?:string;readonly [key:string]:unknown}
export interface ReviewedSlimCommandHook {
 readonly registerCommand:(configuration:Record<string,unknown>)=>void;
 readonly handleCommandExecuteBefore:(input:{readonly command:string;readonly sessionID:string;readonly arguments:string},output:{parts:{type:string;text?:string}[]})=>Promise<void>;
}
export function createDeepworkCommandHook():ReviewedSlimCommandHook;
export function createLoopCommandHook():ReviewedSlimCommandHook;
export function createReflectCommandHook():ReviewedSlimCommandHook;

export interface ReviewedSlimToolInput {readonly tool:string;readonly sessionID:string;readonly callID?:string;readonly directory?:string;readonly [key:string]:unknown}
export interface ReviewedSlimToolOutput {args?:Record<string,unknown>;output?:string;readonly [key:string]:unknown}
export type ReviewedSlimHook=(input:Record<string,unknown>,output:Record<string,unknown>)=>Promise<void>;
export interface ReviewedSlimToolLoopGuard {
 readonly 'tool.execute.before':(input:{readonly tool:string;readonly sessionID?:string;readonly callID?:string},output:{args?:unknown})=>Promise<void>;
 readonly 'tool.execute.after':(input:{readonly tool:string;readonly sessionID?:string;readonly callID?:string},output:{output?:unknown;metadata?:unknown})=>Promise<void>;
 readonly observeNewUserMessage:(sessionID:string,messageID:string)=>void;
 readonly resetTurn:(sessionID:string)=>void;readonly resetSession:(sessionID:string)=>void;
}
export function createToolLoopGuardHook():ReviewedSlimToolLoopGuard;
export function createJsonErrorRecoveryHook(context:unknown):{readonly 'tool.execute.after':(input:{readonly tool:string},output:{output?:unknown})=>Promise<void>};
export function createPhaseReminderHook(options?:{readonly shouldInject?:(sessionID:string)=>boolean}):{readonly 'experimental.chat.messages.transform':(input:unknown,output:{messages?:unknown})=>Promise<void>};
export function createFilterAvailableSkillsHook(context:unknown,runtime:{readonly agents:()=>Readonly<Record<string,unknown>>;readonly disabledSkills:readonly string[]}):{readonly 'experimental.chat.messages.transform':ReviewedSlimHook};
export interface ReviewedChatHeadersContext {readonly directory:string;readonly client:{readonly session:{readonly message:(input:{readonly path:{readonly id:string;readonly messageID:string};readonly query:{readonly directory:string}})=>Promise<{readonly data?:{readonly parts:readonly unknown[]}}>}}}
export function createChatHeadersHook(context:ReviewedChatHeadersContext):{readonly 'chat.headers':(input:{readonly sessionID:string;readonly model:{readonly providerID:string;readonly api:{readonly npm:string}};readonly provider:{readonly info?:{readonly id?:string}};readonly message:{readonly id:string;readonly role:string}},output:{headers:Record<string,string>})=>Promise<void>};
export function collapseSystemInPlace(system:string[]):void;
export function createDisplayNameMentionRewriter(runtime:{readonly customAgentNames:readonly string[];readonly agents:()=>Readonly<Record<string,unknown>>}):(text:string)=>string;

export interface ReviewedSlimPathOwner {readonly stat:(file:string)=>Promise<{isFile():boolean}>;readonly realpath:(file:string)=>Promise<string>;readonly readText:(file:string)=>Promise<string>}
export function withReviewedSlimPathOwner<T>(owner:ReviewedSlimPathOwner,action:()=>Promise<T>):Promise<T>;
export interface ReviewedSlimPathHook {readonly 'tool.execute.before':(input:{readonly tool:string;readonly directory?:string},output:{args?:Record<string,unknown>})=>Promise<void>}
export function createApplyPatchHook(context:{readonly directory:string;readonly worktree?:string}):ReviewedSlimPathHook;
export function createAbsolutePathRescueHook(context:{readonly directory:string}):ReviewedSlimPathHook;
export function createSearchPathGuardHook(context:{readonly directory:string;readonly hostFlavor:'v2'}):ReviewedSlimPathHook;

// ---------------------------------------------------------------------------
// Agents, fallback and the task board.

export interface ReviewedSlimAgentData {readonly directory:string;readonly configuration:Record<string,unknown>;readonly hostConfiguration:Record<string,unknown>;readonly prompts:Record<string,{readonly prompt?:string;readonly appendPrompt?:string}>;readonly localSkills:readonly string[];readonly activePreset?:string}
export function resolveReviewedSlimAgents(input:ReviewedSlimAgentData):{readonly agents:Record<string,unknown>;readonly defaultAgent?:string;readonly runtimeChains:Readonly<Record<string,readonly string[]>>;readonly modelArrays:Readonly<Record<string,readonly {id:string;variant?:string}[]>>;readonly fallback:Readonly<Record<string,unknown>>;readonly backgroundJobs:Readonly<Record<string,unknown>>};

export type ReviewedFallbackEntry=string|{readonly id:string;readonly variant?:string};
export interface ReviewedSlimFallbackInput {readonly chains:Readonly<Record<string,readonly ReviewedFallbackEntry[]>>;readonly agent?:string;readonly currentModel?:string;readonly tried:readonly string[];readonly exhaustion:0|1|2}
export interface ReviewedSlimFallbackResult {readonly selection:null|'exhausted'|{readonly agentName?:string;readonly currentModel?:string;readonly nextModel:string;readonly ref:{readonly providerID:string;readonly modelID:string};readonly variant?:string};readonly tried:readonly string[];readonly exhaustion:0|1|2}
export function selectReviewedSlimFallback(input:ReviewedSlimFallbackInput):ReviewedSlimFallbackResult;
export function isReviewedSlimFailoverError(error:unknown):boolean;

export type ReviewedSlimBoardState='running'|'completed'|'error'|'cancelled'|'stopped'|'reconciled';
/** Board row in the 3.x record shape; the host maps its owned task rows to it. */
export interface ReviewedSlimBoardJob {
 taskID:string;parentSessionID:string;agent:string;description:string;objective?:string;state:ReviewedSlimBoardState;
 provisional?:boolean;background:boolean;timedOut:boolean;recoverableAfterLiveBusy:boolean;statusUncertain:boolean;statusUncertainSince?:number;
 cancellationRequested:boolean;terminalUnreconciled:boolean;launchedAt:number;lastLaunchedAt:number;
 generation:number;terminalRevision:number;activityRevision:number;taskGeneration:number;runStartedAt:number;
 deadlineExceededAt?:number;updatedAt:number;lastLiveBusyAt?:number;stopConfirmationStartedAt?:number;completedAt?:number;
 resultSummary?:string;lastStatusError?:string;alias:string;lastUsedAt:number;terminalState?:'running'|'completed'|'error'|'cancelled';
 contextFiles:{path:string;lineCount:number;lineNumbers?:number[];lastReadAt:number}[];
 totalErrors?:number;timeoutCount?:number;lastErrorAt?:number;
}
export interface ReviewedSlimBoardMetadata {text:string|undefined;terminalUnreconciledTaskIDs:{taskID:string;generation:number;terminalRevision?:number}[]}
export function formatReviewedSlimTaskBoard(input:{readonly jobs:readonly ReviewedSlimBoardJob[];readonly reusable:readonly ReviewedSlimBoardJob[];readonly readContextMaxFiles?:number;readonly now?:number}):ReviewedSlimBoardMetadata|null;
export interface ReviewedSlimBoardOwners {readonly shouldManageSession:(sessionID:string)=>boolean;readonly strategy?:'latest'|'checkpoint-compatible';readonly maxRetainedSnapshots?:number;
 readonly board:{readonly get:(taskID:string)=>ReviewedSlimBoardJob|undefined;readonly formatForPromptWithMetadata:(parentSessionID:string)=>ReviewedSlimBoardMetadata|null|undefined;
  /** Synchronous and revision-checked; the injection path refuses a promise. */
  readonly markReconciled:(taskID:string,at:undefined,generation:number,terminalRevision?:number)=>ReviewedSlimBoardJob|undefined}}
export function createReviewedSlimTaskBoardRenderer(owner:ReviewedSlimBoardOwners):{readonly transform:ReviewedSlimHook;readonly clearSession:(sessionID:string)=>void};

// ---------------------------------------------------------------------------
// Image attachments (confined worker only; stateless across runs).

/** Constructor binding is called only in the actual confined worker with cwd equal to its private view. */
export function bindReviewedSlimImageWorker(directory:string):void;
export function processReviewedSlimImageAttachments(input:{readonly messages:readonly unknown[];readonly workDir:string;readonly imageRouting:'auto'|'direct';readonly disabledAgents:ReadonlySet<string>;readonly modelAcceptsImages?:boolean;readonly log:(message:string)=>void}):boolean;

// ---------------------------------------------------------------------------
// Interview. The service runs in the host's interview owner; the document
// functions run only in its confined worker.

export interface ReviewedInterviewRecord {id:string;sessionID:string;idea:string;markdownPath:string;createdAt:string;abandonedAt?:string;abandonedOrder?:number;status:'active'|'abandoned';completed?:boolean;baseMessageCount:number}
export interface ReviewedInterviewQuestion {id:string;question:string;options:string[];suggested?:string}
export interface ReviewedInterviewAnswer {questionId:string;answer:string}
export interface ReviewedInterviewMessage {info?:{role?:string;[key:string]:unknown};parts?:{type?:string;text?:string}[]}
export interface ReviewedInterviewRuntime {
 messages(sessionID:string):Promise<ReviewedInterviewMessage[]>;
 notify(sessionID:string,text:string):Promise<void>;
 continue(sessionID:string,text:string,model?:{providerID:string;modelID:string}):Promise<void>;
 rename(sessionID:string,title:string):Promise<void>;
}
export interface ReviewedInterviewDocuments {
 withLock<T>(markdownPath:string,operation:()=>Promise<T>):Promise<T>;
 ensure(record:ReviewedInterviewRecord):Promise<void>;
 claim(markdownPath:string,sessionID:string,baseMessageCount:number):Promise<string>;
 read(record:ReviewedInterviewRecord):Promise<string>;
 /** Rejects with InterviewPatchApplyError / InterviewPatchRequiredError for an unusable patch. */
 rewrite(record:ReviewedInterviewRecord,summary:string,title?:string,patch?:string,consumedState?:string):Promise<string>;
 rewriteFinal(record:ReviewedInterviewRecord,finalMarkdown:string):Promise<string>;
 markComplete(record:ReviewedInterviewRecord):Promise<string>;
 markIncomplete(record:ReviewedInterviewRecord):Promise<string>;
 appendAnswers(record:ReviewedInterviewRecord,questions:ReviewedInterviewQuestion[],answers:ReviewedInterviewAnswer[]):Promise<void>;
 readText(file:string,encoding:'utf8'):Promise<string>;
 list(directory:string):Promise<string[]>;
 stat(file:string):Promise<{readonly mtimeMs:number}>;
 resolveExisting(directory:string,outputFolder:string,value:string):Promise<string|null>;
}
export type ReviewedInterviewNudgeAction='more-questions'|'confirm-complete';
export interface ReviewedInterviewState {interview:ReviewedInterviewRecord;url:string;markdownPath:string;
 mode:'awaiting-agent'|'awaiting-user'|'abandoned'|'completed'|'error'|'session-disconnected';lastParseError?:string;isBusy:boolean;
 summary:string;questions:ReviewedInterviewQuestion[];document:string;blocks:{id:string;title:string;content:string}[]}
export interface ReviewedInterviewFileItem {fileName:string;resumeCommand:string;title:string;summary:string;sessionID?:string;directory?:string}
export interface ReviewedInterviewListItem {id:string;idea:string;status:'active'|'abandoned';createdAt:string}
export interface ReviewedInterviewService {
 readonly setBaseUrlResolver:(resolver:()=>Promise<string>)=>void;
 readonly setStatePushCallback:(callback:(interviewID:string,state:ReviewedInterviewState)=>void)=>void;
 readonly setOnInterviewCreated:(callback:(record:ReviewedInterviewRecord)=>void)=>void;
 readonly getActiveInterviewId:(sessionID:string)=>string|null;
 readonly registerCommand:(configuration:Record<string,unknown>,enabled?:{interview?:boolean;implement?:boolean})=>void;
 readonly handleCommandExecuteBefore:(input:{command:string;sessionID:string;arguments:string},output:{parts:{type:string;text?:string;synthetic?:boolean;metadata?:Record<string,unknown>}[]})=>Promise<void>;
 readonly handleEvent:(input:{event:{type:string;properties?:Record<string,unknown>}})=>Promise<void>;
 readonly getInterviewState:(interviewID:string)=>Promise<ReviewedInterviewState>;
 readonly listInterviewFiles:()=>Promise<ReviewedInterviewFileItem[]>;
 readonly listInterviews:()=>ReviewedInterviewListItem[];
 readonly submitAnswers:(interviewID:string,answers:ReviewedInterviewAnswer[])=>Promise<void>;
 readonly submitBlockComment:(interviewID:string,section:string,comment:string)=>Promise<void>;
 readonly submitChat:(interviewID:string,message:string)=>Promise<void>;
 readonly handleNudgeAction:(interviewID:string,action:ReviewedInterviewNudgeAction)=>Promise<void>;
}
export interface ReviewedInterviewDependencies {readonly documents:ReviewedInterviewDocuments;readonly runtime:ReviewedInterviewRuntime;readonly openBrowser:(url:string)=>void;readonly env?:Readonly<Record<string,string|undefined>>}
export function createInterviewService(context:{readonly directory:string},configuration:Readonly<Record<string,unknown>>|undefined,dependencies:ReviewedInterviewDependencies):ReviewedInterviewService;

export class InterviewDocumentOwnershipError extends Error {readonly markdownPath:string;readonly ownerSessionID:string;constructor(markdownPath:string,ownerSessionID:string)}
export class InterviewPatchApplyError extends Error {readonly failedHunk:string;readonly contextWindow:string;constructor(failedHunk:string,contextWindow:string)}
export class InterviewPatchRequiredError extends InterviewPatchApplyError {constructor()}
export function ensureInterviewFile(record:ReviewedInterviewRecord):Promise<void>;
export function claimInterviewDocument(markdownPath:string,sessionID:string,baseMessageCount:number):Promise<string>;
export function readInterviewDocument(record:ReviewedInterviewRecord):Promise<string>;
export function rewriteInterviewDocument(record:ReviewedInterviewRecord,summary:string,title?:string,patch?:string,consumedState?:string):Promise<string>;
export function rewriteInterviewDocumentWithFinalSpec(record:ReviewedInterviewRecord,finalMarkdown:string):Promise<string>;
export function markInterviewDocumentComplete(record:ReviewedInterviewRecord):Promise<string>;
export function markInterviewDocumentIncomplete(record:ReviewedInterviewRecord):Promise<string>;
export function appendInterviewAnswers(record:ReviewedInterviewRecord,questions:ReviewedInterviewQuestion[],answers:ReviewedInterviewAnswer[]):Promise<void>;
export function resolveExistingInterviewPath(directory:string,outputFolder:string,value:string):string|null;
export function resolveReviewedExistingInterviewPath(directory:string,outputFolder:string,value:string,owners:{readonly exists:(candidate:string)=>Promise<boolean>}):Promise<string|null>;

export interface ReviewedInterviewHandlerOwners {
 readonly basePrefix?:string;
 readonly authorize:(request:IncomingMessage)=>Promise<void>;
 readonly outputFolder:string;
 readonly listInterviews:()=>ReviewedInterviewListItem[];
 readonly listInterviewFiles:()=>Promise<ReviewedInterviewFileItem[]>;
 readonly getState:(interviewID:string)=>Promise<ReviewedInterviewState>;
 readonly submitAnswers:(interviewID:string,answers:ReviewedInterviewAnswer[])=>Promise<void>;
 readonly submitBlockComment:(interviewID:string,section:string,comment:string)=>Promise<void>;
 readonly submitChat:(interviewID:string,message:string)=>Promise<void>;
 readonly handleNudgeAction:(interviewID:string,action:ReviewedInterviewNudgeAction)=>Promise<void>;
}
export function createInterviewHandler(owners:ReviewedInterviewHandlerOwners):(request:IncomingMessage,response:ServerResponse)=>Promise<void>;

export interface ReviewedSlimInterviewBridgeOwner {readonly runtime:unknown;
 readonly service:{readonly getActiveInterviewId:(sessionID:string)=>Promise<string|null>|string|null;readonly handleCommandExecuteBefore:ReviewedInterviewService['handleCommandExecuteBefore'];readonly handleEvent:ReviewedInterviewService['handleEvent']};
 readonly submitCommand:(invocation:unknown)=>Promise<void>;
 readonly assertAcceptedCommand:(input:{readonly sessionID:string;readonly messageID:string;readonly args:string;readonly event:unknown})=>Promise<void>;
 readonly dispose:()=>Promise<void>}
export function createReviewedSlimInterviewBridge(owner:ReviewedSlimInterviewBridgeOwner):ReviewedSlimInterviewBridgeBinding&{readonly getTranscript:(sessionID:string)=>readonly unknown[]};
export const reviewedSlimInterviewCommandDeclaration:{readonly description:string;readonly template:string};
