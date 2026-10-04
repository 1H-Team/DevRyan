// Provision/bind first: sibling static imports cannot enforce an async startup barrier.
import './lib/opencode/runtime-host/runtime-entry-bootstrap.js';
import { fileURLToPath } from 'node:url';
import { selectedRuntimeBundle } from './lib/opencode/runtime-host/runtime-bundle-binding.js';

const application = selectedRuntimeBundle?.admission==='held'||selectedRuntimeBundle?.selection.reconciliationRequired
  ? await import('./lib/opencode/runtime-host/runtime-bundle-recovery.js')
  : await import('./application.js');
export const { gracefulShutdown, setupProxy, restartOpenCode, startWebUiServer, parseArgs } = application;
application.runWebCliEntry(fileURLToPath(import.meta.url));
