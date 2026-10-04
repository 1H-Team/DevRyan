import type {MigrationDatabase} from './bundle-migration-inventory.js';
export interface NativeInputCancellationScope {
 readonly messageID:string;readonly sessionID:string;readonly enqueuedSeq:number;readonly payloadHash:string;
 readonly type:'user'|'synthetic'|'compaction'|'move';readonly delivery:'queue'|'steer';
}
export function nativeInputEnqueue(db:MigrationDatabase,input:Pick<NativeInputCancellationScope,'messageID'|'sessionID'|'enqueuedSeq'>,before?:number):Readonly<Record<string,unknown>>|null;
export function nativeInputCancellation(db:MigrationDatabase,input:NativeInputCancellationScope):{eventID:string;seq:number;receiptSha256:string}|null;
