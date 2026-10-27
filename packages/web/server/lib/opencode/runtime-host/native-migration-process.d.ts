import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type { MigrationRequest, MigrationReceipt } from './native-process-protocol.js';
export function runNativeMigrationProcess(options: {
  readonly windowsOwner?:WindowsPrivateFileOwner;readonly binary: string; readonly environment: NodeJS.ProcessEnv; readonly cwd: string;
  readonly request: MigrationRequest; readonly timeoutMs?: number; readonly beforeSpawn?: () => Promise<unknown>;
}): Promise<MigrationReceipt>;
