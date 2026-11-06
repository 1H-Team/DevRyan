import type { MigrationDatabase } from './bundle-migration-inventory.js';
import type { WindowsPrivateFileOwner } from '../../../../../harness-runtime/lib/windows-private-files.js';
export function verifyBundleManagedJobs(input: {
  readonly db: MigrationDatabase;
  readonly webDataDirectory: string;
  readonly targetManifest?: { readonly compiledContracts?: readonly string[] };
  readonly windowsOwner?: WindowsPrivateFileOwner;
}): Promise<void>;
