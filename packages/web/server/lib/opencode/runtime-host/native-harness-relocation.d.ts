import type {NativeHarnessRequest,NativeHarnessResult} from './native-process-protocol.js';
import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
export function validateNativeGitConfig(bytes:Buffer):void;
export function runNativeHarnessRelocation(input:unknown,nonce:string|undefined):Promise<NativeHarnessResult>;
export function runNativeHarnessRelocationProcess(options:{binary:string;controlRoot:string;windowsOwner:WindowsPrivateFileOwner;request:NativeHarnessRequest;beforeSpawn:()=>Promise<unknown> }):Promise<NativeHarnessResult['harness']>;
