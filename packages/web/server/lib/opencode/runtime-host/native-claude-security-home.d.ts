import type {ClaudeEnrollmentBinding} from './native-claude-lifecycle.js';
export interface NativeClaudeCommandOptions {readonly signal?:AbortSignal;readonly timeout?:number;readonly killSignal?:string;readonly env?:Readonly<Record<string,string|undefined>>}
export type NativeClaudeOwnedCommand=(file:string,args:readonly string[],options:NativeClaudeCommandOptions,recheck?:()=>Promise<void>)=>Promise<{stdout:string}>;
export type NativeClaudeOwnedCommandBinder=(binding:ClaudeEnrollmentBinding,recheck:()=>Promise<void>)=>Promise<NativeClaudeOwnedCommand>;
export function createNativeClaudeSecurityHome(options:{readonly controlRoot:string;readonly home:string;readonly securityHome:string;readonly account?:string;readonly execute:(file:string,args:readonly string[],options:NativeClaudeCommandOptions)=>Promise<{stdout:string}>}):NativeClaudeOwnedCommandBinder;
