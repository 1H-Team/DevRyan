export interface NativeObservationExecution {readonly agent:string;readonly providerID:string;readonly modelID:string;readonly variant:string|null}
export interface NativeObservationIntent {readonly source:'prompt'|'command-definition';readonly variantPresent:boolean;readonly variant?:string|null;readonly agent?:string;readonly model?:{readonly providerID:string;readonly modelID:string}}
export interface NativeObservationAttempt {readonly traceID:string;readonly spanID:string}
interface Common {readonly schema:1;readonly controllerInstanceID:string;readonly configurationDigest:string;readonly sessionID:string;readonly directory:string}
export interface NativeCompactionBudget {
 readonly auto:boolean;readonly buffer:number|null;readonly keep:number;readonly ceiling:number|null;readonly budget:number;
 readonly estimatePrompt:{readonly measured:number;readonly estimated:number};readonly estimateContext:number;
 readonly limits:{readonly context:number;readonly input:number|null;readonly output:number};
 readonly anchorIndex:number;readonly checkpointIndex:number;readonly stateRevision:number;readonly due:boolean;
}
export interface NativeCompactionWitness {readonly sha256:string;readonly bytes:number}
export type NativeObservation = Common & (
 {readonly stage:'accepted-user';readonly messageID:string;readonly fingerprint:string;readonly intent:NativeObservationIntent;readonly execution?:NativeObservationExecution} |
 {readonly stage:'model-prepared';readonly requestID:string;readonly kind:'primary'|'title'|'compaction'|'generate';readonly execution:NativeObservationExecution;readonly options:Readonly<Record<string,unknown>>;readonly hookOptions:Readonly<Record<string,unknown>>;readonly modelLimits:{readonly context:number;readonly input:number|null;readonly output:number}} |
 {readonly stage:'physical';readonly requestID:string;readonly kind:'primary'|'title'|'compaction'|'generate';readonly transport:'http'|'ws';readonly wireOptions:Readonly<Record<string,unknown>>|null;readonly ordinal:number;readonly attempt:NativeObservationAttempt|null} |
 {readonly stage:'provider-refusal';readonly kind:'primary'|'title'|'compaction'|'generate';readonly hook:'http.request'|'http.response'|'experimental.ws.handshake'|'experimental.ws.send';readonly code:string} |
 {readonly stage:'step-link';readonly eventID:string;readonly sequence:number;readonly created:number;readonly assistantMessageID:string;readonly userMessageID:string;readonly execution:NativeObservationExecution;readonly attempt:NativeObservationAttempt|null} |
 {readonly stage:'compaction-trigger';readonly triggerID:string;readonly reason:'auto'|'overflow'|'manual';readonly inputID:string|null;readonly entered:number;readonly orderedInputDigest:string;readonly inputCount:number;readonly budget:NativeCompactionBudget|null;readonly anchorMessageID:string|null;readonly checkpointMessageID:string|null} |
 {readonly stage:'compaction-outcome';readonly triggerID:string;readonly status:'skipped'|'completed'|'failed';readonly finished:number} |
 {readonly stage:'compaction-event';readonly triggerID:string|null;readonly eventID:string;readonly sequence:number;readonly created:number;readonly event:'started'|'ended'|'failed';readonly reason:'auto'|'manual';readonly inputID:string|null;readonly messageID:string|null;readonly witness:{readonly recent:NativeCompactionWitness|null;readonly text:NativeCompactionWitness|null;readonly providerState:NativeCompactionWitness|null;readonly providerContext:NativeCompactionWitness|null}});
export function parseNativeObservation(value:unknown):NativeObservation;
export function parseNativeJournalObservation(value:unknown):NativeObservation;
export function projectNativeReasoningOptions(value:unknown):Readonly<Record<string,unknown>>;
export function isSafeNativeOpenAiRefusalCode(value:unknown):value is string;
