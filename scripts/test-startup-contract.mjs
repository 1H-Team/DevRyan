import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  ['node', ['--test', 'packages/electron/tests/startup-retry.test.mjs', 'packages/electron/tests/early-startup.test.mjs', 'packages/electron/tests/runtime-service-startup.test.mjs',
    'packages/electron/tests/runtime-service-source.test.mjs', 'packages/electron/tests/windows-preview.test.mjs',
    'packages/electron/tests/runtime-service.test.mjs', 'packages/electron/tests/runtime-bundle-bootstrap.test.mjs',
    'scripts/qa/release-startup-contract.test.mjs', 'scripts/qa/release-startup.test.mjs', 'scripts/qa/native-startup-benchmark.test.mjs',
    'scripts/qa/host-readiness.test.mjs', 'scripts/opencode-v2-native/artifacts.test.mjs']],
  ['bun', ['test', 'packages/shared-runtime/startup-diagnostics.test.js', 'packages/harness-runtime/lib/session-reboot-recovery.test.js']],
  ['node', ['scripts/test-ui.mjs', 'src/lib/startup/health.test.ts', 'src/lib/startup/readiness.test.ts',
    'src/lib/startup/agent-runtime-warmup.test.ts', 'src/lib/startup/chat-runtime-warmup.test.ts',
    'src/stores/useConfigStore.bootstrap-status.test.ts', 'src/sync/bootstrap-global.test.ts', 'src/sync/bootstrap-session-list.test.ts',
    'src/sync/global-sync-store.test.ts',
    'src/sync/input-subscription.mounted.test.tsx',
    'src/components/ui/RuntimeLoadingScreen.test.tsx', 'src/components/ui/RuntimeLoadingScreen.mounted.test.tsx']],
  ['bun', ['run', '--cwd', 'packages/web', 'vitest', 'run', '--no-file-parallelism', '--maxWorkers=1',
    'server/lib/opencode/execution-helper-command.test.js', 'server/lib/opencode/session-execution-host.test.js',
    'server/lib/opencode/lifecycle.test.js', 'server/lib/opencode/runtime-host/native-artifacts.test.js',
    'server/lib/opencode/runtime-host/bundle-startup-upgrade-status.test.js',
    'server/lib/opencode/runtime-host/runtime-entry-bootstrap.test.js',
    'server/lib/opencode/runtime-host/native-bundle-reboot-recovery.test.js',
    'server/lib/opencode/runtime-host/retained-native-artifacts.test.js', 'server/lib/opencode/runtime-host/runtime-bundle.test.js',
    'server/lib/opencode/runtime-host/native-setup-seed.test.js']],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
