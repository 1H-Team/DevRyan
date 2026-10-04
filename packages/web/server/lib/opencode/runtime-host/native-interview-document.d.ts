import type {NativeInterviewDocumentOperation} from './native-interview-worker.js';
import type {RegistrationOrigin} from './registration-origin.js';
import type {MutationPublication} from '../../../../../harness-runtime/lib/session-mutations.js';
export interface NativeInterviewDocumentScope {directory:string;sessionID:string;messageID:string;path:string;operation:NativeInterviewDocumentOperation}
export interface NativeInterviewDocumentAuthority {recheck:()=>Promise<void>;signal?:AbortSignal;origin:RegistrationOrigin}
export interface NativeInterviewDocumentResult {result:string|null;receipt:{terminated:boolean;confined:boolean;cancelled:boolean;exitCode:number};publication:MutationPublication}
export function executeNativeInterviewDocument(input:NativeInterviewDocumentScope,authority:NativeInterviewDocumentAuthority,deps:unknown):Promise<NativeInterviewDocumentResult>;
