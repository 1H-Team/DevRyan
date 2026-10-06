import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type {NativeCursorScope} from './native-cursor-owner.js';
import type {SessionMutationRuntime,MutationLease} from '../../../../../harness-runtime/lib/session-mutations.js';
export interface NativeCursorRecovery {
 readonly stage:(input:{readonly scope:NativeCursorScope;readonly revision:number})=>Promise<void>;
 readonly starting:(scope:NativeCursorScope)=>Promise<void>;
 readonly bind:(scope:NativeCursorScope,lease:MutationLease)=>Promise<void>;
 readonly complete:(scope:NativeCursorScope)=>Promise<void>;
 readonly recover:(input:{readonly directory:string;readonly settle:(scope:NativeCursorScope,revision:number)=>Promise<unknown>})=>Promise<void>;
 readonly drain:()=>Promise<void>;
}
export function createNativeCursorRecovery(options:{readonly directory:string;readonly ownerID:string;
 readonly windowsOwner?:WindowsPrivateFileOwner;readonly windowsLauncher?:string;
 readonly runtime:Pick<SessionMutationRuntime,'leaseForCall'|'executionOutcomes'>}):NativeCursorRecovery;
