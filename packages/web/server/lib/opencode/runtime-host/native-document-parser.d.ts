import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type {NativeDocumentPayload,NativeDocumentParsed} from './native-document.js';
export interface NativeDocumentTerminationUnconfirmed extends Error {code:'native_document_termination_unconfirmed';nativeProcessUnsettled:true}
export function createNativeDocumentParser(options:{launcher:string;command:string;args?:readonly string[];storage:string;windowsOwner?:WindowsPrivateFileOwner;deniedReadDirectories?:readonly string[];onStarted?:(handle:{pid:number})=>void;onTermination?:(receipt:{terminated:boolean;confined:boolean;cancelled:boolean;exitCode:number})=>void|Promise<void>}):(payload:NativeDocumentPayload,signal:AbortSignal)=>Promise<NativeDocumentParsed>;
