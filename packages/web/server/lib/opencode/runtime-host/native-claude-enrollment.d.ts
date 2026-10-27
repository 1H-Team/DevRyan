import type {ClaudeLifecycleState,ClaudeLifecycleOperation} from './native-claude-lifecycle.js';
export interface NativeClaudeEnrollmentResult {
 readonly enrollmentID:string;
 readonly status:'pending'|'enrolled'|'selected'|'incomplete'|'unavailable'|'deleting'|'deleted';
 readonly url?:string;
 readonly profileID?:string;
}
export interface NativeClaudeEnrollmentOwner {
 list(context:unknown):Promise<readonly NativeClaudeEnrollmentResult[]>;
 begin(context:unknown):Promise<NativeClaudeEnrollmentResult>;
 complete(id:string,input:{readonly code:string;readonly state:string},context:unknown):Promise<NativeClaudeEnrollmentResult>;
 select(id:string,context:unknown):Promise<NativeClaudeEnrollmentResult>;
 remove(id:string,context:unknown):Promise<NativeClaudeEnrollmentResult>;
 close():Promise<void>;
}
export function createNativeClaudeEnrollmentOwner(options:{
 readonly controlRoot:string;readonly home:string;readonly asset:{readonly path:string;readonly sha256:string};
 readonly lifecycle:{read():Promise<ClaudeLifecycleState>;transition(revision:number,operation:ClaudeLifecycleOperation):Promise<ClaudeLifecycleState>};
 readonly withMutationQueue:<T>(action:()=>Promise<T>)=>Promise<T>;
 readonly captureBinding:(context:unknown)=>Promise<unknown>;
 readonly recheckBinding:(binding:unknown,context:unknown)=>Promise<void>;
 readonly publishProfile:(profile:{readonly id:string;readonly type:'claude-max';readonly claudeConfigDir:string;readonly keychainService:string},binding:unknown,context:unknown)=>Promise<unknown>;
 readonly bindOwnedCommand?:import('./native-claude-security-home.js').NativeClaudeOwnedCommandBinder;
 readonly beforeEnrollment?:(input:{readonly recheck:()=>Promise<void>;readonly signal:AbortSignal})=>Promise<void>;
 readonly withProfileRemoval?:<T>(action:()=>Promise<T>)=>Promise<T>;
 readonly assertProfileRemoval?:(profile:import('./native-claude-profile-publication.js').ClaudeEnrollmentProfile,binding:unknown,context:unknown)=>Promise<void>;
 readonly removeProfile?:(profile:import('./native-claude-profile-publication.js').ClaudeEnrollmentProfile,binding:unknown,context:unknown)=>Promise<void>;
 readonly recheckAfterRemoval?:(binding:unknown,context:unknown)=>Promise<void>;
}):NativeClaudeEnrollmentOwner;
