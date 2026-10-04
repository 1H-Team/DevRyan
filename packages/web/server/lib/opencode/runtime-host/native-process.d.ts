import type { NativeProcessBoot, NativeProcessCommand, NativeProcessReply } from './native-process-protocol.js';
export interface NativeProcessExit { readonly pid:number|null;readonly code:number|null;readonly signal:NodeJS.Signals|null;readonly expected:boolean;readonly instanceID:string;readonly startedAt:number;readonly observationUnavailable?:true;readonly receipt?:{readonly path:string;readonly terminated:true;readonly confined:true;readonly exitCode:number;readonly cancelled:boolean} }
export interface NativeControllerProcess {
  readonly url:string;readonly port:number;readonly instanceID:string;readonly pid:number;readonly startedAt:number;
  readonly bound:Extract<NativeProcessReply,{type:'bound'}>;
  readonly hasExited:()=>boolean;
  readonly call:(input:NativeProcessCommand extends infer C ? C extends NativeProcessCommand ? Omit<C,'protocol'|'id'> : never : never, options?:{timeoutMs?:number})=>Promise<unknown>;
  readonly close:()=>Promise<NativeProcessExit>;
  /** Signals only this owned child; resolves after its OS exit and the owner's awaited recovery barrier. */
  readonly killForRecovery:()=>Promise<NativeProcessExit>;
  /** Credential queue settlement cannot release on a timeout while the child may still mutate. */
  readonly killAndWaitForExit:()=>Promise<NativeProcessExit>;
}
export function createNativeControllerProcess(options:{readonly binary:string;readonly environment:NodeJS.ProcessEnv;readonly cwd:string;readonly boot:NativeProcessBoot;readonly supervisor?:{readonly launcher:string;readonly deniedReadDirectories?:readonly string[]};readonly logFile?:string;readonly timeoutMs?:number;readonly beforeSpawn?:()=>Promise<void>;readonly afterExit?:(exit:NativeProcessExit)=>Promise<void>;readonly onExit?:(exit:NativeProcessExit)=>void;readonly onObservationUnavailable?:(instanceID:string)=>void}):Promise<NativeControllerProcess>;

/** Shared accepted profile/receipt preparation; provider workers use the exact selected private roots. */
export function prepareSupervisedController(boot:Pick<NativeProcessBoot,'databasePath'|'globals'|'instanceID'>,supervisor:{readonly launcher:string;readonly deniedReadDirectories?:readonly string[]}):Promise<{readonly profile:string;readonly receiptPath:string;readonly arguments:readonly string[]}>;
