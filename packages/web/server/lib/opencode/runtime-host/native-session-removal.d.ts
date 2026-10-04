import type {NativeAdmissionOwner} from './native-admission-owner.js';
import type {OperationPermit} from './native-admission-contract.js';
import type {SessionMutationRuntime} from '../../../../../harness-runtime/lib/session-mutations.js';
export interface NativeRemovalIdentity {id:string;parentID:string|null;directory:string}
export interface NativeRemovalState {sessionID:string;exists:boolean;active:boolean;claimed:boolean;inboxIDs:string[];pendingIDs:string[]}
export interface NativeRemovalSnapshot {members:NativeRemovalIdentity[];states:NativeRemovalState[]}
export interface NativeRemovalScope {directory:string;sessions:string[];intentID:string}
export type NativeRemovalCancellation = NativeRemovalScope & ({phase:'fence'}|{phase:'settle';settled:{terminated:true;sessions:readonly string[]}|null;absentSessions:readonly string[]});
export interface NativeSessionRemovalOptions {
  runtime:SessionMutationRuntime;admissionOwner:NativeAdmissionOwner;ownerID:string;
  inspectRemovalOwned:(input:{sessionID:string;permit:OperationPermit})=>Promise<NativeRemovalSnapshot>;
  removeLeafOwned:(input:{intentID:string;sessionID:string;permit:OperationPermit})=>Promise<{removed:true;sessionID:string}>;
  cancelManaged:(input:NativeRemovalCancellation)=>Promise<{fenced?:true;settled?:true;sessions:readonly string[];taskIDs?:readonly string[]}>;
  cancelAndWait:(input:{directory:string;sessions:string[]})=>Promise<{terminated:true;sessions:readonly string[]}>;
}
export function createNativeSessionRemoval(options:NativeSessionRemovalOptions):{
  remove:(input:{sessionID:string;directory?:string;quiet?:boolean})=>Promise<true>;
  recover:(input:{directory:string})=>Promise<void>;
};
