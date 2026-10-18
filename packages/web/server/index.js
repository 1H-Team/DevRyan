// Select composition only after the launcher has provisioned, verified and bound
// the native bundle; no composition or store owner is imported before that.
import { fileURLToPath } from 'node:url';
import { startStartupTiming } from './lib/opencode/startup-timing.js';

let application;
if (process.env.DEVRYAN_RUNTIME_MODE === 'standard-preview') {
  application = await import('./lib/opencode/standard-preview/application.js');
} else {
  if (process.env.DEVRYAN_RUNTIME_MODE && process.env.DEVRYAN_RUNTIME_MODE !== 'native') {
    throw Object.assign(new Error('Unsupported DevRyan runtime mode'), { code: 'runtime_mode_invalid' });
  }
  const finishPreparation = startStartupTiming('bundle_preparation');
  let binding;
  try {
    const { prepareNativeRuntimeEntry } = await import('./lib/opencode/runtime-host/runtime-entry-bootstrap.js');
    binding = await prepareNativeRuntimeEntry();
    finishPreparation();
  } catch (error) { finishPreparation('failed'); throw error; }
  const finishImport = startStartupTiming('application_import');
  try {
    application = binding.admission === 'held' || binding.selection.reconciliationRequired
      ? await import('./lib/opencode/runtime-host/runtime-bundle-recovery.js')
      : await import('./application.js');
    finishImport();
  } catch (error) { finishImport('failed'); throw error; }
}
export const { gracefulShutdown, setupProxy, restartOpenCode, startWebUiServer, parseArgs } = application;
application.runWebCliEntry(fileURLToPath(import.meta.url));
