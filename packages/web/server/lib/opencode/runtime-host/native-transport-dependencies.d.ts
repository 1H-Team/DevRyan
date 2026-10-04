declare module '@openchamber/harness-runtime/lib/session-execution.js' {
  import type {ChildProcessWithoutNullStreams} from 'node:child_process';
  export function startReadOnlySessionExecution(options:{launcher:string;storage:string;auxiliaryDirectory:string;logicalDirectory:string;command:string;args:readonly string[];signal:AbortSignal;interactive:true;env:NodeJS.ProcessEnv;socketDirectory:null;workerBrowsers:false}):Promise<{child:ChildProcessWithoutNullStreams;result:Promise<{terminated:boolean;confined:boolean;cancelled:boolean;exitCode:number}>}>;
}
