import type {NativeProviderBoot, NativeProviderDiagnostic} from './native-provider-worker-protocol.js';
export const CLAUDE_CHECKPOINT_EVENTS:readonly string[];
export const CLAUDE_CHECKPOINT_REASONS:readonly string[];
export function nativeClaudeStateDirectory(input:{storage:string;home:string;profile:{readonly claudeConfigDir?:string};directory:string}):string;
export function createNativeClaudeCheckpointOwner(options:{boot:NativeProviderBoot;assertAttempt:(input:{attemptID:string;sessionID:string;directory:string})=>void;publish?:(diagnostic:NativeProviderDiagnostic)=>void}):{
  bindTransport:(raw:unknown,cwd:unknown)=>void;
  directory:(raw:unknown,cwd:unknown)=>string;
  diagnostic:(raw:unknown,event:unknown,detail:unknown)=>void;
  release:(attemptID:string)=>void;
  close:()=>void;
};
