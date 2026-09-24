import { OPENCODE_TARGET_INSTALL_COMMAND, TARGET_OPENCODE_VERSION } from './version-policy.js';

export const createOpenCodeResolutionRuntime = (dependencies) => {
  const {
    path,
    resolveOpencodeCliPath,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    resolveManagedOpenCodeLaunchSpec,
    getResolvedState,
    setResolvedOpencodeBinarySource,
    getDetectedOpenCodeVersion,
    getCompanionState,
  } = dependencies;

  const getOpenCodeResolutionSnapshot = async (settings) => {
    const configured = typeof settings?.opencodeBinary === 'string' ? settings.opencodeBinary : null;

    const { resolvedOpencodeBinarySource: previousSource } = getResolvedState();
    const detectedNow = resolveOpencodeCliPath();
    const { resolvedOpencodeBinarySource: rawDetectedSourceNow } = getResolvedState();
    setResolvedOpencodeBinarySource(previousSource);

    await applyOpencodeBinaryFromSettings();
    ensureOpencodeCliEnv();

    const {
      resolvedOpencodeBinary,
      resolvedOpencodeBinarySource,
      useWslForOpencode,
      resolvedWslBinary,
      resolvedWslOpencodePath,
      resolvedWslDistro,
      resolvedNodeBinary,
      resolvedBunBinary,
    } = getResolvedState();

    const resolved = resolvedOpencodeBinary || null;
    const source = resolvedOpencodeBinarySource || null;
    const detectedSourceNow =
      detectedNow &&
      resolved &&
      detectedNow === resolved &&
      rawDetectedSourceNow === 'env' &&
      source &&
      source !== 'env'
        ? source
        : rawDetectedSourceNow;
    const launchSpec = resolved && !useWslForOpencode
      ? resolveManagedOpenCodeLaunchSpec(resolved)
      : null;

    return {
      targetVersion: TARGET_OPENCODE_VERSION,
      installCommand: OPENCODE_TARGET_INSTALL_COMMAND,
      detectedVersion: typeof getDetectedOpenCodeVersion === 'function' ? getDetectedOpenCodeVersion() || null : null,
      companion: typeof getCompanionState === 'function' ? getCompanionState() : null,
      configured,
      resolved,
      resolvedDir: resolved ? path.dirname(resolved) : null,
      source,
      detectedNow,
      detectedSourceNow,
      launchBinary: launchSpec?.binary || null,
      launchArgs: launchSpec?.args || [],
      launchWrapperType: launchSpec?.wrapperType || null,
      viaWsl: useWslForOpencode,
      wslBinary: resolvedWslBinary || null,
      wslPath: resolvedWslOpencodePath || null,
      wslDistro: resolvedWslDistro || null,
      node: resolvedNodeBinary || null,
      bun: resolvedBunBinary || null,
    };
  };

  return {
    getOpenCodeResolutionSnapshot,
  };
};
