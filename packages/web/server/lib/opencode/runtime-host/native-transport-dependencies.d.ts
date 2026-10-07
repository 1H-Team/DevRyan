declare module '@openchamber/harness-runtime/lib/session-execution.js' {
  import type {ChildProcessWithoutNullStreams} from 'node:child_process';
  import type {WindowsPrivateFileOwner} from '@openchamber/harness-runtime/lib/windows-private-files.js';
  export function startReadOnlySessionExecution(options:{launcher:string;storage:string;windowsOwner?:WindowsPrivateFileOwner;auxiliaryDirectory:string;logicalDirectory:string;command:string;args:readonly string[];signal:AbortSignal;interactive:true;env:NodeJS.ProcessEnv;socketDirectory:null;workerBrowsers:false}):Promise<{child:ChildProcessWithoutNullStreams;result:Promise<{terminated:boolean;confined:boolean;cancelled:boolean;exitCode:number}>}>;
}
