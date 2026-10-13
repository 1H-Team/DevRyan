// The finite failure code of this process's cold startup upgrade, if any. A
// refused upgrade does not stop startup by itself: the selected runtime still
// launches when it passes its own verification and meets the version pin.
import { artifactDiagnostic } from '@openchamber/shared-runtime/startup-diagnostics.js';
let failure = null;
let diagnostic;
let detail;

export const recordStartupBundleUpgradeFailure = (code, error) => { failure = code; diagnostic = artifactDiagnostic(error); detail = error?.detail; };
export const readStartupBundleUpgradeFailure = () => failure;
export const readStartupBundleUpgradeDiagnostic = () => diagnostic;

// When the retained runtime cannot launch either, the refused upgrade is the
// cause to report: an old-pin rejection of that runtime must not mask it.
export const startupUpgradeFailureOver = (error) => failure
  ? Object.assign(new Error(failure), { code: failure, status: 503, cause: error, ...(diagnostic ? { diagnostic } : {}), ...(detail ? { detail } : {}) }) : error;
