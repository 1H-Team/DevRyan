// The finite failure code of this process's cold startup upgrade, if any. A
// refused upgrade does not stop startup by itself: the selected runtime still
// launches when it passes its own verification and meets the version pin, or
// when it is the retained older reviewed runtime the refused upgrade left.
import { artifactDiagnostic } from '@openchamber/shared-runtime/startup-diagnostics.js';
let failure = null;
let diagnostic;
let detail;
let retainedVersion = null;

export const recordStartupBundleUpgradeFailure = (code, error, retained = null) => {
  failure = code; diagnostic = artifactDiagnostic(error); detail = error?.detail; retainedVersion = code ? retained : null;
};
export const readStartupBundleUpgradeFailure = () => failure;
export const readStartupBundleUpgradeDiagnostic = () => diagnostic;
// The older OpenCode version this process may run instead of the pin, because
// its startup upgrade was refused. Null when the upgrade was not refused.
export const readStartupRetainedRuntimeVersion = () => failure ? retainedVersion : null;

// When the retained runtime cannot launch either, the refused upgrade is the
// cause to report: an old-pin rejection of that runtime must not mask it.
export const startupUpgradeFailureOver = (error) => failure
  ? Object.assign(new Error(failure), { code: failure, status: 503, cause: error, ...(diagnostic ? { diagnostic } : {}), ...(detail ? { detail } : {}) }) : error;
