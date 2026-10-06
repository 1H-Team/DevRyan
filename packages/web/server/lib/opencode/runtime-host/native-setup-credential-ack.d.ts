import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type {NativeSetupCredentialAck} from './native-process-protocol.js';
export function captureNativeSetupCredentialSeed(file:string,windowsOwner:WindowsPrivateFileOwner):Promise<{expected:{sha256:string;count:number}|null;settle(ack:NativeSetupCredentialAck|undefined):Promise<void>}>;
