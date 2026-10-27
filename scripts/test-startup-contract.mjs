#!/usr/bin/env node
// `bun run test:startup`: the curated startup and user-data contract.
// Each group names the full-suite runner that also owns its files (`owner`,
// a scripts/validate.mjs test key); test-suite-contract.test.mjs proves those
// runners discover them, so `validate` skips a group whose owner suite already
// runs in the same plan, and `test:full` (CI) runs every file without this script.
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runTestUnits, summarizeTestUnits, testConcurrency } from './test-pool.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export const STARTUP_CONTRACT_GROUPS = Object.freeze([
  { name: 'electron', owner: 'electron', command: 'node', args: ['--test', 'packages/electron/tests/startup-retry.test.mjs', 'packages/electron/tests/early-startup.test.mjs',
    'packages/electron/tests/runtime-service-startup.test.mjs', 'packages/electron/tests/runtime-service-source.test.mjs', 'packages/electron/tests/windows-preview.test.mjs',
    'packages/electron/tests/runtime-service.test.mjs', 'packages/electron/tests/runtime-bundle-bootstrap.test.mjs'] },
  { name: 'scripts', owner: 'scripts', command: 'node', args: ['--test', 'scripts/qa/native-startup-benchmark.test.mjs',
    'scripts/qa/host-readiness.test.mjs', 'scripts/opencode-v2-native/artifacts.test.mjs'] },
  { name: 'shared', owner: 'shared', command: 'bun', args: ['test', 'packages/shared-runtime/startup-diagnostics.test.js'] },
  { name: 'harness', owner: 'harness', command: 'bun', args: ['test', 'packages/harness-runtime/lib/session-reboot-recovery.test.js'] },
  { name: 'ui', owner: 'ui', command: 'node', args: ['scripts/test-ui.mjs', 'src/lib/startup/health.test.ts', 'src/lib/startup/readiness.test.ts',
    'src/lib/startup/agent-runtime-warmup.test.ts', 'src/lib/startup/chat-runtime-warmup.test.ts',
    'src/stores/useConfigStore.bootstrap-status.test.ts', 'src/sync/bootstrap-global.test.ts', 'src/sync/bootstrap-session-list.test.ts',
    'src/sync/global-sync-store.test.ts',
    'src/sync/input-subscription.mounted.test.tsx',
    'src/components/ui/RuntimeLoadingScreen.test.tsx', 'src/components/ui/RuntimeLoadingScreen.mounted.test.tsx'] },
  { name: 'web', owner: 'web', command: 'bun', args: ['run', '--cwd', 'packages/web', 'vitest', 'run',
    'server/lib/opencode/execution-helper-command.test.js', 'server/lib/opencode/session-execution-host.test.js',
    'server/lib/opencode/lifecycle.test.js', 'server/lib/opencode/runtime-host/native-artifacts.test.js',
    'server/lib/opencode/runtime-host/bundle-startup-upgrade-status.test.js',
    'server/lib/opencode/runtime-host/bundle-harness-integrity.test.js', 'server/lib/opencode/runtime-host/native-cursor-recovery.test.js',
    'server/lib/opencode/runtime-host/runtime-entry-bootstrap.test.js',
    'server/lib/opencode/runtime-host/native-bundle-reboot-recovery.test.js',
    'server/lib/opencode/runtime-host/retained-native-artifacts.test.js', 'server/lib/opencode/runtime-host/runtime-bundle.test.js',
    'server/lib/opencode/runtime-host/native-setup-seed.test.js'] },
].map(Object.freeze));

/** Startup groups not already covered by the given owner suites. */
export function startupContractGroups({ coveredBy = [] } = {}) {
  const covered = new Set(coveredBy);
  return STARTUP_CONTRACT_GROUPS.filter((group) => !covered.has(group.owner));
}

/** `--covered-by=web,ui` drops groups whose owner suite runs elsewhere in the same validation. */
export function parseStartupArgs(argv) {
  const coveredBy = [];
  for (const arg of argv) {
    if (!arg.startsWith('--covered-by=')) throw new Error(`Unknown argument: ${arg} (use --covered-by=<suite,...>)`);
    const owners = arg.slice('--covered-by='.length).split(',').filter(Boolean);
    const unknown = owners.filter((owner) => !STARTUP_CONTRACT_GROUPS.some((group) => group.owner === owner));
    if (unknown.length) throw new Error(`Unknown startup owner suite: ${unknown.join(', ')}`);
    coveredBy.push(...owners);
  }
  return { coveredBy };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { coveredBy } = parseStartupArgs(process.argv.slice(2));
  const groups = startupContractGroups({ coveredBy });
  if (coveredBy.length) console.log(`Startup contract: ${coveredBy.join(', ')} group(s) run in their owner suites.`);
  if (groups.length) {
    const outcome = await runTestUnits(groups.map((group) => ({ ...group, name: `startup:${group.name}`, cwd: root })),
      { concurrency: testConcurrency(), label: 'test:startup', cwd: root });
    summarizeTestUnits(outcome, { label: 'test:startup' });
    process.exitCode = outcome.passed ? 0 : 1;
  }
}
