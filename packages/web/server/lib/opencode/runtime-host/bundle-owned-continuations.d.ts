import type { MigrationDatabase } from './bundle-migration-inventory.js';
export interface VerifiedBundleContinuation {
  readonly id: string; readonly sessionID: string;readonly directory?:string;readonly itemProof?:{readonly type:string;readonly delivery:string;readonly hash:string};
  readonly inboxSha256: string | null; readonly sessionSha256: string; readonly sourceSha256: string;
  readonly file?: string; readonly fileSha256?: string;readonly paths?:readonly string[];
  readonly cancellation?:{readonly enqueuedSeq:number;readonly payloadHash:string;readonly type:'user'|'synthetic'|'compaction'|'move';readonly delivery:'queue'|'steer';readonly eventID:string;readonly seq:number;readonly receiptSha256:string};
}
export function readBundleRecoveryEnvelope(file: string,options?:{readonly windowsOwner?:import('../../../../../harness-runtime/lib/windows-private-files.js').WindowsPrivateFileOwner}): Promise<{ readonly envelope: { readonly version: 1; readonly key: string; readonly record: Record<string, unknown> }; readonly sha256: string }>;
/** Read-only startup integrity; this does not authorize dispatch. */
export function verifyBundleOwnedContinuations(db: MigrationDatabase, webDataDirectory: string,options?:{readonly allowUnownedPending?:boolean;readonly cancelledContinuations?:readonly VerifiedBundleContinuation[]}): Promise<readonly VerifiedBundleContinuation[]>;

export function bundleContinuationItem(record:import('@openchamber/harness-runtime').PrimaryRecoveryExecutionRecord):{readonly type:'user';readonly delivery:'queue';readonly payload:Readonly<Record<string,unknown>>};
