import type { MigrationReceipt, NativeProcessBoot } from './native-process-protocol.js';
export function verifyNativeBootMigration(boot: Pick<NativeProcessBoot, 'bundleID'|'databasePath'|'manifestSha256'|'migrationEvidence'>): Promise<MigrationReceipt>;
