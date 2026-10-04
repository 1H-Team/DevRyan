import type { MigrationRequest, MigrationReceipt } from './native-process-protocol.js';
export function runNativeMigrationProcess(options: {
  readonly binary: string; readonly environment: NodeJS.ProcessEnv; readonly cwd: string;
  readonly request: MigrationRequest; readonly timeoutMs?: number; readonly beforeSpawn?: () => Promise<void>;
}): Promise<MigrationReceipt>;
