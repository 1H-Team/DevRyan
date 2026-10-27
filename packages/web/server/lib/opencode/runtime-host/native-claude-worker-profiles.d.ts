import type {NativeProviderBoot,NativeMeridianProfile} from './native-provider-worker-protocol.js';
import type {ClaudeLifecycleClient} from './native-claude-lifecycle.js';
export function projectNativeClaudeWorkerProfiles(options:{readonly profiles:readonly NativeMeridianProfile[];readonly globals:Pick<NativeProviderBoot['globals'],'home'|'config'|'data'>;readonly controlRoot:string;readonly workerInstanceID:string;readonly lifecycle:Pick<ClaudeLifecycleClient,'read'>},context:{readonly recheck:()=>Promise<void>;readonly signal?:AbortSignal}):Promise<readonly NativeMeridianProfile[]>;
