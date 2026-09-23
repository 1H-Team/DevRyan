#!/usr/bin/env node
// Bun runs a workspace `prepare` script on every install. Release jobs build
// web assets and native inputs in dedicated steps (or consume them from the
// shared web artifact), so their install steps opt out of this duplicate work.
// Explicit `bun run prepare` invocations never set the variable.

import { spawnSync } from 'node:child_process';

if (process.env.DEVRYAN_SKIP_INSTALL_PREPARE === '1') {
  console.log('[electron] skipped install-time prepare (DEVRYAN_SKIP_INSTALL_PREPARE=1)');
  process.exit(0);
}

for (const script of ['build:web-assets', 'prepare:native']) {
  const result = spawnSync('bun', ['run', script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
