// Vitest global setup: one scratch directory per test run in the OS temp dir.
// Every test file gets its own DevRyan data folder inside it (see
// isolated-data.setup.mjs), and the whole run directory is removed when the run
// ends, passed, failed or interrupted. DEVRYAN_KEEP_ARTIFACTS=1 or
// --keep-artifacts keeps it for a failed run.
import fs from 'node:fs';
import path from 'node:path';

import { keepArtifactsRequested, scratchParent } from '../../../scripts/qa/run-root.mjs';

export default function setup({ provide }) {
  const parent = scratchParent('web-test');
  fs.mkdirSync(parent, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(parent, 'run-'));
  provide('devryanTestRunRoot', runRoot);
  return () => {
    if (keepArtifactsRequested()) {
      process.stderr.write(`Kept web test scratch: ${runRoot}\n`);
      return;
    }
    fs.rmSync(runRoot, { recursive: true, force: true });
  };
}
