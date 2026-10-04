import type {NativeGlobalRoots} from './native-process-protocol.js';
import type {NativeMeridianProfile} from './native-provider-worker-protocol.js';
export interface NativeProviderConfiguration{readonly profiles:readonly NativeMeridianProfile[];readonly defaultProfile?:string;readonly oauthTokenExpiries?:Readonly<Record<string,number>>;readonly sources:{readonly profiles:'env'|'disk'|'none';readonly defaultProfile:'env'|'disk'|'none'}}
export function resolveNativeProviderConfiguration(input:{readonly globals:NativeGlobalRoots;readonly environment:Pick<NodeJS.ProcessEnv,'MERIDIAN_PROFILES'|'MERIDIAN_DEFAULT_PROFILE'>;readonly controlRoot?:string}):Promise<NativeProviderConfiguration>;
