// Worker-thread entry for OpenCode database maintenance. The deletes and an
// explicit VACUUM on a multi-GB database block for seconds to minutes; running
// them here keeps the server's event loop (health checks, splash status, UI)
// responsive while OpenCode is down between stop and launch.
import { parentPort, workerData } from 'node:worker_threads';

import { performOpenCodeDbMaintenance, resolveSqliteDriver } from './db-maintenance-core.js';

// The first message tells the parent the worker module loaded and started;
// a failure before it (module resolution, ABI) lets the parent fall back to an
// in-process run instead of reporting a maintenance error.
parentPort.postMessage({ type: 'started' });

try {
  const driver = resolveSqliteDriver();
  parentPort.postMessage({ type: 'done', ok: true, result: performOpenCodeDbMaintenance({ driver, ...workerData }) });
} catch (error) {
  parentPort.postMessage({
    type: 'done',
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
