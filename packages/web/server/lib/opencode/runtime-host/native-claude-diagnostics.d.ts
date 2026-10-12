import type {EventEmitter} from 'node:events';
import type {Readable} from 'node:stream';
export type NativeClaudeDiagnosticClue='http_401'|'http_403'|'auth'|'model'|'unsupported_option'|'argument'|'config'|'permission'|'launcher'|'module'|'syntax'|'spawn'|'connection'|'native_receipt';
export interface NativeClaudeProcessReceipt {readonly code:number|null;readonly signalPresent:boolean;readonly stderrBytes:number;readonly scannedBytes:number;readonly truncated:boolean;readonly clues:readonly NativeClaudeDiagnosticClue[]}
export const NATIVE_CLAUDE_DIAGNOSTIC_CLUES:readonly NativeClaudeDiagnosticClue[];
export function createClaudeStderrDiagnostic():{readonly write:(chunk:Uint8Array|string)=>void;readonly receipt:(code:number|null,signal:unknown,spawnError?:boolean)=>NativeClaudeProcessReceipt};
export function observeClaudeProcessDiagnostic(child:EventEmitter&{readonly stderr:Readable|null},publish:(receipt:NativeClaudeProcessReceipt)=>void):void;
