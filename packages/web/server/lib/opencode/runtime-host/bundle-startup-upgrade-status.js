// The finite failure code of this process's cold startup upgrade, if any. The
// lifecycle reports it when the selected runtime still misses the version pin.
let failure = null;

export const recordStartupBundleUpgradeFailure = code => { failure = code; };
export const readStartupBundleUpgradeFailure = () => failure;
