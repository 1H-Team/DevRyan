export const CLAUDE_LIFECYCLE_PROTOCOL: 'devryan.claude-lifecycle/1';
export const CLAUDE_LIFECYCLE_KEY: 'devryan.claude-lifecycle/1';
export const CLAUDE_LIFECYCLE_LIMITS: Readonly<{accounts:64;unresolved:128;bytes:61440}>;
export interface ClaudeEnrollmentBinding {readonly profileID:string;readonly service:string;readonly configDirectory:string;readonly enrollmentID:string;readonly generation:string}
export interface ClaudeLifecycleAccount extends ClaudeEnrollmentBinding {readonly grantFingerprint:string;readonly recordFingerprint:string}
export interface ClaudeUnresolvedRefresh extends ClaudeLifecycleAccount {readonly attemptID:string;readonly phase:'in-flight'|'replacement-prepared'|'blocked';readonly replacementRecordFingerprint?:string;readonly replacementGrantFingerprint?:string}
export interface ClaudeLifecycleState {readonly protocol:typeof CLAUDE_LIFECYCLE_PROTOCOL;readonly revision:number;readonly accounts:readonly ClaudeLifecycleAccount[];readonly unresolved:readonly ClaudeUnresolvedRefresh[]}
export type ClaudeLifecycleOperation =
 | {readonly kind:'enroll';readonly account:ClaudeLifecycleAccount}
 | {readonly kind:'begin';readonly account:ClaudeLifecycleAccount;readonly attemptID:string}
 | {readonly kind:'prepare';readonly binding:ClaudeEnrollmentBinding;readonly attemptID:string;readonly recordFingerprint:string;readonly grantFingerprint:string}
 | {readonly kind:'settle';readonly binding:ClaudeEnrollmentBinding;readonly attemptID:string;readonly recordFingerprint:string}
 | {readonly kind:'cancel-before-dispatch';readonly binding:ClaudeEnrollmentBinding;readonly attemptID:string}
 | {readonly kind:'block-legacy';readonly account:ClaudeLifecycleAccount;readonly attemptID:string};
export interface ClaudeLifecycleClient {read():Promise<ClaudeLifecycleState>;transition(expectedRevision:number,operation:ClaudeLifecycleOperation):Promise<ClaudeLifecycleState>}
export function emptyClaudeLifecycle():ClaudeLifecycleState;
export function parseClaudeLifecycle(value:unknown):ClaudeLifecycleState;
export function parseClaudeLifecycleOperation(value:unknown):ClaudeLifecycleOperation;
export function transitionClaudeLifecycle(value:unknown,expectedRevision:number,operation:unknown):ClaudeLifecycleState;
export function claudeRecordFingerprint(value:unknown):string;
export function claudeGrantFingerprint(refreshToken:string):string;
export function hasLegacyClaudeFence(value:unknown):boolean;
export function sameClaudeEnrollment(left:ClaudeEnrollmentBinding,right:ClaudeEnrollmentBinding):boolean;
