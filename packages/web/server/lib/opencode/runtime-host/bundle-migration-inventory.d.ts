import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type { VerifiedBundleContinuation } from './bundle-owned-continuations.js';
export type SQLValue = string | number | null;
export interface MigrationDatabase {
  all(sql: string, params?: readonly SQLValue[]): readonly unknown[];
  run(sql: string, params?: readonly SQLValue[]): void;
}
export interface ProjectMapping { readonly sourceDirectory: string; readonly targetDirectory: string; readonly mode: 'identity' | 'synthetic-copy' }
export interface MigrationRule { readonly action: string; readonly resource: string; readonly effect: 'allow' | 'deny' | 'ask' }
export interface MigrationInventory {
  readonly schema: 1;
  readonly sessions: readonly { readonly id: string; readonly projectID: string; readonly parentID: string | null;
    readonly workspaceID: string | null; readonly directory: string; readonly path: string | null;
    readonly permission: readonly MigrationRule[] | null; readonly metadataSha256: string; readonly archivedAt: number | null }[];
  readonly projects: readonly { readonly id: string; readonly worktree: string; readonly sandboxes: readonly string[] }[];
  readonly messages: readonly { readonly id: string; readonly sessionID: string; readonly role: 'user' | 'assistant'; readonly parentID: string | null;
    readonly summary: boolean; readonly sourceSha256: string }[];
  readonly parts: readonly { readonly id: string; readonly sessionID: string; readonly messageID: string; readonly type: string;
    readonly callID: string | null; readonly url: string | null; readonly mime: string | null; readonly sourceSha256: string }[];
  readonly remembered: readonly { readonly projectID: string; readonly action: string; readonly resource: string }[];
  readonly attachments: readonly { readonly partID: string; readonly originalURI: string; readonly sha256: string; readonly bytes: number; readonly disposition: 'data' }[];
}
export interface MigrationVerification {
  readonly schema: 1;
  readonly sessionIDs: readonly string[];
  readonly messages: readonly { readonly id: string; readonly disposition: 'preserved' | 'folded-compaction-summary'; readonly targetID: string }[];
  readonly nativeMessageIDs: readonly string[];
  readonly attachments: MigrationInventory['attachments'];
  readonly remembered: MigrationInventory['remembered'];
  readonly permissions: readonly { readonly id: string; readonly rules: readonly MigrationRule[] | null }[];
}
export function bundleFailure(code: string): Error & { code: string; status: number };
export function isRecord(value: unknown): value is Record<string, unknown>;
export function canonicalJSON(value: unknown): string;
export function sha256(value: string | Uint8Array): string;
export function containsPath(root: string, value: string): boolean;
export function saveBundleJSON(file: string, value: unknown, options?:{readonly windowsOwner?:WindowsPrivateFileOwner}): Promise<string>;
export function readBundleJSON(file: string, options?:{readonly windowsOwner?:WindowsPrivateFileOwner}): Promise<unknown>;
export function hasMigrationTable(db: MigrationDatabase, name: string): boolean;
export function migrationMarker(db: MigrationDatabase): { readonly phase: 'sessions' | 'completed'; readonly cursor?: string } | null;
export function assertBundlePendingInput(db: MigrationDatabase, verifiedContinuations?: readonly VerifiedBundleContinuation[]): void;
export function assertNoPendingMigration(db: MigrationDatabase): void;
export function captureMigrationInventory(db: MigrationDatabase): MigrationInventory;
export function applyMigrationProjectMap(db: MigrationDatabase, inventory: MigrationInventory, maps: readonly ProjectMapping[], protectedRoots?: readonly string[]): Promise<void>;
export function restoreMigrationPermissions(db: MigrationDatabase, inventory: MigrationInventory): void;
export function verifyMigrationReferences(db: MigrationDatabase, inventory: MigrationInventory, options?: { readonly phase?: 'prepared' | 'resume'; readonly projectMap?: readonly ProjectMapping[]; readonly verifiedContinuations?: readonly VerifiedBundleContinuation[]; readonly migrationReceiptMarker?: 'completed' | 'not-needed' }): MigrationVerification;
