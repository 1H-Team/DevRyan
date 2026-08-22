import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MERIDIAN_PACKAGE = '@rynfar/meridian';
const OPENCODE_WITH_CLAUDE_PACKAGE = 'opencode-with-claude';
const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';

const CLAUDE_RUNTIME_CONTROL = Object.freeze({
  opencodeWithClaude: '1.6.18',
  meridian: '1.57.0',
  agentSdk: '0.2.141',
  claudeCode: '2.1.215',
});

const CLAUDE_RUNTIME_CANDIDATE = Object.freeze({
  opencodeWithClaude: '1.8.0',
  meridian: '1.62.6',
  agentSdk: '0.2.141',
  claudeCode: '2.1.215',
});

// Claude Code 2.1.98 reduced the measured prefix, but Meridian 1.62.6 requires
// Claude Code ^2.1.198. Keep the compatible 2.1.215 control selected so stateful
// resume usage and session lineage use the runtime contract Meridian was built
// against. The broader cross-provider context ratio remains upstream-blocked.
const CLAUDE_RUNTIME_SELECTION = Object.freeze({
  channel: 'candidate',
  compatibilityStatus: 'upstream_blocked',
  versions: CLAUDE_RUNTIME_CANDIDATE,
});

const CLAUDE_RUNTIME_MANAGED_DEPENDENCIES = Object.freeze({
  [OPENCODE_WITH_CLAUDE_PACKAGE]: CLAUDE_RUNTIME_SELECTION.versions.opencodeWithClaude,
  [MERIDIAN_PACKAGE]: CLAUDE_RUNTIME_SELECTION.versions.meridian,
});

const CLAUDE_RUNTIME_MANAGED_OVERRIDES = Object.freeze({
  [CLAUDE_AGENT_SDK_PACKAGE]: CLAUDE_RUNTIME_SELECTION.versions.agentSdk,
  [CLAUDE_CODE_PACKAGE]: CLAUDE_RUNTIME_SELECTION.versions.claudeCode,
});

const COMPATIBILITY_MARKER_RELATIVE_PATH = path.join(
  '.openchamber',
  'claude-runtime-compatibility.json',
);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readJson = (fsApi, filePath) => {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeVersion = (value) => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

function resolveInstalledPackageVersion(configDirectory, packageName, dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const pathApi = dependencies.path || path;
  const packageSegments = packageName.split('/');
  const candidates = [
    pathApi.join(configDirectory, 'node_modules', ...packageSegments, 'package.json'),
    pathApi.join(
      configDirectory,
      'node_modules',
      ...MERIDIAN_PACKAGE.split('/'),
      'node_modules',
      ...packageSegments,
      'package.json',
    ),
  ];

  for (const packageJsonPath of candidates) {
    const packageJson = readJson(fsApi, packageJsonPath);
    const version = normalizeVersion(packageJson?.version);
    if (version) return version;
  }
  return null;
}

function readClaudeRuntimeCompatibilityMarker(configDirectory, dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const pathApi = dependencies.path || path;
  return readJson(
    fsApi,
    pathApi.join(configDirectory, COMPATIBILITY_MARKER_RELATIVE_PATH),
  );
}

function mergeManagedPackageVersions({
  currentValues,
  baselineValues,
  managedValues,
  previousManagedValues,
  previousSources,
  assumePreviouslyManaged = false,
}) {
  const values = { ...currentValues, ...baselineValues };
  const sources = {};

  for (const [packageName, managedVersion] of Object.entries(managedValues)) {
    const currentVersion = normalizeVersion(currentValues[packageName]);
    const previousManagedVersion = normalizeVersion(previousManagedValues[packageName]);
    const isPreviouslyManaged = currentVersion && (
      assumePreviouslyManaged
      || (
        previousSources[packageName] === 'managed'
        && previousManagedVersion === currentVersion
      )
    );
    if (!currentVersion || isPreviouslyManaged) {
      values[packageName] = managedVersion;
      sources[packageName] = 'managed';
      continue;
    }
    values[packageName] = currentVersion;
    sources[packageName] = 'user-managed';
  }

  return { values, sources };
}

function mergeManagedClaudeRuntimeDependencies(
  currentPackage,
  baselinePackage,
  previousMarker,
  options = {},
) {
  const currentDependencies = isRecord(currentPackage?.dependencies)
    ? currentPackage.dependencies
    : {};
  const baselineDependencies = isRecord(baselinePackage?.dependencies)
    ? baselinePackage.dependencies
    : {};
  const previousManagedDependencies = isRecord(previousMarker?.managedDependencies)
    ? previousMarker.managedDependencies
    : {};
  const previousSources = isRecord(previousMarker?.sources) ? previousMarker.sources : {};
  const result = mergeManagedPackageVersions({
    currentValues: currentDependencies,
    baselineValues: baselineDependencies,
    managedValues: CLAUDE_RUNTIME_MANAGED_DEPENDENCIES,
    previousManagedValues: previousManagedDependencies,
    previousSources,
    assumePreviouslyManaged: options.assumePreviouslyManaged === true,
  });
  return { dependencies: result.values, sources: result.sources };
}

function mergeManagedClaudeRuntimeOverrides(
  currentPackage,
  baselinePackage,
  previousMarker,
  options = {},
) {
  const currentOverrides = isRecord(currentPackage?.overrides) ? currentPackage.overrides : {};
  const baselineOverrides = isRecord(baselinePackage?.overrides) ? baselinePackage.overrides : {};
  const previousManagedOverrides = isRecord(previousMarker?.managedOverrides)
    ? previousMarker.managedOverrides
    : {};
  const previousSources = isRecord(previousMarker?.sources) ? previousMarker.sources : {};
  const result = mergeManagedPackageVersions({
    currentValues: currentOverrides,
    baselineValues: baselineOverrides,
    managedValues: CLAUDE_RUNTIME_MANAGED_OVERRIDES,
    previousManagedValues: previousManagedOverrides,
    previousSources,
    assumePreviouslyManaged: options.assumePreviouslyManaged === true,
  });
  return { overrides: result.values, sources: result.sources };
}

function inspectClaudeRuntimeCompatibility(options = {}) {
  const pathApi = options.path || path;
  const configDirectory = options.configDirectory
    || pathApi.join((options.homedir || (() => os.homedir()))(), '.config', 'opencode');
  const packageJson = options.packageJson || readJson(
    options.fs || fs,
    pathApi.join(configDirectory, 'package.json'),
  ) || {};
  const marker = options.marker || readClaudeRuntimeCompatibilityMarker(configDirectory, options);
  const overrides = isRecord(packageJson.overrides) ? packageJson.overrides : {};
  const markerSources = isRecord(options.sources)
    ? options.sources
    : isRecord(marker?.sources)
      ? marker.sources
      : {};
  const installed = {
    opencodeWithClaude: resolveInstalledPackageVersion(
      configDirectory,
      OPENCODE_WITH_CLAUDE_PACKAGE,
      options,
    ),
    meridian: resolveInstalledPackageVersion(configDirectory, MERIDIAN_PACKAGE, options),
    agentSdk: resolveInstalledPackageVersion(configDirectory, CLAUDE_AGENT_SDK_PACKAGE, options),
    claudeCode: resolveInstalledPackageVersion(configDirectory, CLAUDE_CODE_PACKAGE, options),
  };
  const expected = {
    opencodeWithClaude: normalizeVersion(
      packageJson.dependencies?.[OPENCODE_WITH_CLAUDE_PACKAGE],
    ) || CLAUDE_RUNTIME_SELECTION.versions.opencodeWithClaude,
    meridian: normalizeVersion(packageJson.dependencies?.[MERIDIAN_PACKAGE])
      || CLAUDE_RUNTIME_SELECTION.versions.meridian,
    agentSdk: normalizeVersion(overrides[CLAUDE_AGENT_SDK_PACKAGE])
      || CLAUDE_RUNTIME_SELECTION.versions.agentSdk,
    claudeCode: normalizeVersion(overrides[CLAUDE_CODE_PACKAGE])
      || CLAUDE_RUNTIME_SELECTION.versions.claudeCode,
  };
  const managementSources = {
    opencodeWithClaude: markerSources[OPENCODE_WITH_CLAUDE_PACKAGE] === 'user-managed'
      || expected.opencodeWithClaude !== CLAUDE_RUNTIME_SELECTION.versions.opencodeWithClaude
      ? 'user-managed'
      : 'managed',
    meridian: markerSources[MERIDIAN_PACKAGE] === 'user-managed'
      || expected.meridian !== CLAUDE_RUNTIME_SELECTION.versions.meridian
      ? 'user-managed'
      : 'managed',
    agentSdk: markerSources[CLAUDE_AGENT_SDK_PACKAGE] === 'user-managed'
      || expected.agentSdk !== CLAUDE_RUNTIME_SELECTION.versions.agentSdk
      ? 'user-managed'
      : 'managed',
    claudeCode: markerSources[CLAUDE_CODE_PACKAGE] === 'user-managed'
      || expected.claudeCode !== CLAUDE_RUNTIME_SELECTION.versions.claudeCode
      ? 'user-managed'
      : 'managed',
  };
  const userManaged = Object.values(managementSources).includes('user-managed');
  const missingPackages = Object.entries(installed)
    .filter(([, version]) => version === null)
    .map(([name]) => name);
  const versionMismatches = Object.entries(expected)
    .filter(([name, version]) => installed[name] !== null && installed[name] !== version)
    .map(([name]) => name);
  const runtimeStatus = missingPackages.length > 0
    ? 'missing'
    : versionMismatches.length > 0
      ? 'drifted'
      : 'ready';
  const compatibilityStatus = userManaged
    ? 'user_managed'
    : runtimeStatus !== 'ready'
      ? 'drifted'
      : CLAUDE_RUNTIME_SELECTION.compatibilityStatus;

  return {
    source: userManaged ? 'user-managed' : 'managed',
    channel: CLAUDE_RUNTIME_SELECTION.channel,
    compatibilityStatus,
    runtimeStatus,
    expected,
    installed,
    managementSources,
    missingPackages,
    versionMismatches,
  };
}

function buildClaudeRuntimeCompatibilityMarker({ sources, runtime }) {
  return {
    version: 2,
    channel: CLAUDE_RUNTIME_SELECTION.channel,
    compatibilityStatus: runtime.compatibilityStatus,
    managedDependencies: { ...CLAUDE_RUNTIME_MANAGED_DEPENDENCIES },
    managedOverrides: { ...CLAUDE_RUNTIME_MANAGED_OVERRIDES },
    sources: { ...sources },
    installed: { ...runtime.installed },
  };
}

export {
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_CODE_PACKAGE,
  CLAUDE_RUNTIME_CANDIDATE,
  CLAUDE_RUNTIME_CONTROL,
  CLAUDE_RUNTIME_MANAGED_DEPENDENCIES,
  CLAUDE_RUNTIME_MANAGED_OVERRIDES,
  CLAUDE_RUNTIME_SELECTION,
  COMPATIBILITY_MARKER_RELATIVE_PATH,
  MERIDIAN_PACKAGE,
  OPENCODE_WITH_CLAUDE_PACKAGE,
  buildClaudeRuntimeCompatibilityMarker,
  inspectClaudeRuntimeCompatibility,
  mergeManagedClaudeRuntimeDependencies,
  mergeManagedClaudeRuntimeOverrides,
  readClaudeRuntimeCompatibilityMarker,
  resolveInstalledPackageVersion,
};
