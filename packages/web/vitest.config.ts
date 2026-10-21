// Vitest for packages/web. Tests share the app's module resolution (aliases,
// defines) but none of its build plugins: React Compiler, PWA and asset
// plugins only cost transform time for server tests.
import { configDefaults, defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

const { plugins: _buildPlugins, ...resolution } = viteConfig;

// Bun-native suites (`bun run test:native`) and reviewed upstream inputs.
const notVitest = [
  'runtime/reviewed-inputs/**',
  'server/lib/opencode/runtime-host/native-helper.test.js',
  'server/lib/opencode/runtime-host/native-retention-quiet.test.ts',
  'server/lib/opencode/runtime-host/native-queued-input.test.ts',
  'server/lib/harness/native-integration/**',
];
// Native runtime-host suites copy bundles, ledgers and databases and spawn
// processes; they get few workers so filesystem contention cannot push their
// real-I/O tests past their timeouts. Everything else runs file-parallel.
const runtimeHost = ['server/lib/opencode/runtime-host/**'];

export default defineConfig({
  ...resolution,
  test: {
    exclude: [...configDefaults.exclude, ...notVitest],
    projects: [
      // File-parallel: real git and process work in some tests runs slower under
      // load than it did serially, so the per-test hang budget is 15 s, not 5 s.
      { extends: true, test: { name: 'web', exclude: runtimeHost, testTimeout: 15_000 } },
      { extends: true, test: { name: 'web-runtime-host', include: runtimeHost.map((glob) => `${glob}/*.test.{js,mjs,ts}`), maxWorkers: 2 } },
    ],
  },
});
