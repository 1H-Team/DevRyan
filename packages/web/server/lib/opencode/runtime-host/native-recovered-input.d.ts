import type {MigrationDatabase} from './bundle-migration-inventory.js';
export interface RecoveredNativeInput {
  readonly messageID:string;readonly sessionID:string;readonly directory:string;
  readonly type:'user'|'synthetic'|'compaction'|'move';readonly delivery:'queue'|'steer';readonly location:'queued'|'promoted';
  readonly payloadHash:string;readonly enqueuedSeq:number;readonly rowHash:string;readonly sessionHash:string;readonly historyHash:string;
  readonly item:Readonly<Record<string,unknown>>;readonly session:Readonly<Record<string,unknown>>;
  readonly incompleteAssistant:boolean;readonly settled:boolean;
}
export function recoveredInputHash(item:unknown):string;
export function readRecoveredNativeInputs(db:MigrationDatabase,startedIDs?:readonly string[],sessionIDFilter?:string):RecoveredNativeInput[];
export function withRecoveredInputDatabase<A>(file:string,action:(db:MigrationDatabase)=>A):A;
export {nativeInputCancellation} from './native-input-cancellation.js';
import type {PrimaryRecoveryHost,PrimaryRecoveryExecutionRecord,RecoveredInputOwner} from '@openchamber/harness-runtime';
export interface NativeRecoveredPublication {
 readonly events:readonly {readonly type:string;readonly data:Readonly<Record<string,unknown>>}[];
 readonly pending:readonly {readonly id:string;readonly sessionID:string;readonly payloadHash:string;readonly enqueuedSeq?:number}[];
 readonly grant?:Readonly<{readonly reauthorize?:()=>Promise<void>;readonly recoveredInputGrant?:object;
  readonly recoveredInputCancellation?:{readonly messageID:string;readonly payloadHash:string;readonly enqueuedSeq:number}}>;
}
export function createNativeRecoveredInputOwner(options:{
 readonly databasePath:string;readonly primaryRuntime:PrimaryRecoveryHost;
 readonly readiness:()=>void;
 readonly withSessionLock:<A>(sessionID:string,action:()=>Promise<A>)=>Promise<A>;
 readonly captureAuthorization:(input:RecoveredNativeInput)=>Promise<()=>Promise<void>>;
 readonly runOwned:(input:{readonly action:'resume'|'discard';readonly input:RecoveredNativeInput;readonly recheck:()=>Promise<void>})=>Promise<unknown>;
}):RecoveredInputOwner&{
 install(instanceID:string):Promise<string[]>;
 automatic<A>(input:{readonly sessionID:string;readonly messageID:string;readonly expectedItem?:unknown;
  readonly shellReceipt?:{readonly token:string;readonly jobID:string;readonly command:string;readonly exitCode:number;readonly itemHash?:string;readonly itemDelivery?:'queue'|'steer'}},record:PrimaryRecoveryExecutionRecord|null,
  authorize:()=>Promise<void>,action:(recheck:()=>Promise<void>)=>Promise<A>):Promise<A>;
 assertOperation(request:{readonly sessionID?:string;readonly operation:string},entry?:Readonly<Record<string,unknown>>):object|undefined;
 beforePublish(input:NativeRecoveredPublication):Promise<readonly {readonly sessionID:string;readonly inboxID:string}[]>;
 published(sessionID:string):Promise<void>;
};
