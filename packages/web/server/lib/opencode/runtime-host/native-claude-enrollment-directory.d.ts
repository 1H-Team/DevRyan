import type {NativeMeridianProfile} from './native-provider-worker-protocol.js';
export function isNativeClaudeEnrollmentDirectory(profile:NativeMeridianProfile,input:{readonly controlRoot?:string;readonly home:string}):Promise<boolean>;
