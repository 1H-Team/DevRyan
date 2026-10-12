// The finite failure code of this process's cold startup upgrade, if any. The
// lifecycle reports it when the selected runtime still misses the version pin.
import { artifactDiagnostic } from '@openchamber/shared-runtime/startup-diagnostics.js';
let failure = null;
let diagnostic;

export const recordStartupBundleUpgradeFailure = (code, error) => { failure = code; diagnostic = artifactDiagnostic(error); };
export const readStartupBundleUpgradeFailure = () => failure;
export const readStartupBundleUpgradeDiagnostic = () => diagnostic;

// Stop before selected-bundle composition can mask a failed upgrade with an old-pin rejection.
export const assertStartupBundleUpgradeSucceeded = () => {
  if (failure) throw Object.assign(new Error(failure), { code: failure, status: 503, ...(diagnostic ? { diagnostic } : {}) });
};
