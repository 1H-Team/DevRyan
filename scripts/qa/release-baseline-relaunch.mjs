import { acceptableReleaseLocks } from './release-startup-evidence.mjs';

export function allowBaselineRelaunch({ receipt, artifact, candidate, failure, error }) {
  const process = failure?.afterStop?.process;
  return receipt.baselineRelaunches === 0 && artifact.publishedTag === `v${artifact.version}`
    && artifact.version !== candidate.version && artifact.dmgSha256 !== candidate.dmgSha256
    && failure?.terminalCode === 'native_process_boot_timeout'
    && error?.code !== 'release_startup_cleanup_failed' && !failure.evidenceError && !failure.forcedCleanup
    && process?.trackingClosed === true && process.rootObserved === true
    && process.observationErrors.length === 0 && process.remainingProcessIds.length === 0
    && (process.exitCode !== null || process.exitSignal !== null)
    && acceptableReleaseLocks(failure.afterStop);
}
