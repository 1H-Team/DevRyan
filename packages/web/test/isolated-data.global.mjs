// Vitest global setup, in the main Vitest process before any worker starts.
// A run a repository runner started already carries the private environment of
// the test isolation guard (scripts/test-isolation-guard.mjs). A direct run
// (`bunx vitest run <file>`) builds it here, in-process: Node's os.homedir()
// follows HOME on every call and the workers inherit this process's
// environment, so every test file and product module sees the private home.
// The run is then checked, and one scratch directory per run is made inside the
// private root. Every test file gets its own DevRyan data folder inside it (see
// isolated-data.setup.mjs); the run directory, and a root built here, are
// removed when the run ends, passed, failed or interrupted.
// DEVRYAN_KEEP_ARTIFACTS=1 or --keep-artifacts keeps them for a failed run.
import fs from 'node:fs';
import path from 'node:path';

import { keepArtifactsRequested } from '../../../scripts/qa/run-root.mjs';
import { ISOLATION_ROOT_VARIABLE, assertTestIsolation, isolateCurrentProcess } from '../../../scripts/test-isolation-guard.mjs';

export default function setup({ provide }) {
  const isolation = process.env[ISOLATION_ROOT_VARIABLE] === undefined ? isolateCurrentProcess() : null;
  let root;
  try {
    ({ root } = assertTestIsolation());
  } catch (error) {
    // Printed here as well: Vitest can lose a global-setup error while mapping its stack.
    process.stderr.write(`\n${error.message}\n\n`);
    throw error;
  }
  const parent = path.join(root, 'web-test');
  fs.mkdirSync(parent, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(parent, 'run-'));
  provide('devryanTestRunRoot', runRoot);
  return () => {
    if (keepArtifactsRequested()) {
      process.stderr.write(`Kept web test scratch: ${runRoot}\n`);
      return;
    }
    fs.rmSync(runRoot, { recursive: true, force: true });
    isolation?.cleanup();
  };
}
