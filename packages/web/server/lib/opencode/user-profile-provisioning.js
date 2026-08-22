import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { listDefaultConfigAssets } from './default-config-assets.js';
import {
  applyContextModeHotfix,
  CONTEXT_MODE_HOTFIX_INCOMPATIBLE,
} from './context-mode-hotfix.js';
import {
  DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
  DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES,
  inspectDevRyanManagedPluginInstallation,
  reconcileDevRyanManagedPluginSpecs,
  removeDevRyanManagedLegacyPluginSpecs,
} from './managed-plugins.js';
import { applyManagedMeridianSdkFeaturePolicy } from './meridian-sdk-features.js';
import {
  CLAUDE_RUNTIME_MANAGED_OVERRIDES,
  COMPATIBILITY_MARKER_RELATIVE_PATH,
  buildClaudeRuntimeCompatibilityMarker,
  inspectClaudeRuntimeCompatibility,
  mergeManagedClaudeRuntimeDependencies,
  mergeManagedClaudeRuntimeOverrides,
  readClaudeRuntimeCompatibilityMarker,
} from './claude-runtime-compatibility.js';

const DEFAULT_CONFIG_ROOT = path.resolve(process.cwd(), 'server', 'default-config');
const DEFAULT_PROFILE_ROOT = path.join(DEFAULT_CONFIG_ROOT, 'user-profile');
const MANIFEST_RELATIVE_PATH = path.join('.openchamber', 'user-profile-manifest.json');
const MERIDIAN_POLICY_MARKER_RELATIVE_PATH = path.join(
  '.openchamber',
  'meridian-sdk-features-policy.json',
);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

const readJson = (fsApi, filePath, fallback = {}) => {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const mergeOpenCodeConfig = (current, baseline) => ({
  ...current,
  ...baseline,
  plugin: reconcileDevRyanManagedPluginSpecs(current.plugin, baseline.plugin),
  agent: {
    ...(isRecord(current.agent) ? current.agent : {}),
    ...(isRecord(baseline.agent) ? baseline.agent : {}),
  },
});

const mergePackageJson = (
  current,
  baseline,
  previousClaudeRuntimeMarker,
  { assumePreviouslyManaged = false } = {},
) => {
  const currentDependencies = isRecord(current.dependencies) ? current.dependencies : {};
  const baselineDependencies = {
    ...currentDependencies,
    ...(isRecord(baseline.dependencies) ? baseline.dependencies : {}),
    ...DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
  };
  const claudeRuntimeDependencies = mergeManagedClaudeRuntimeDependencies(
    current,
    { ...baseline, dependencies: baselineDependencies },
    previousClaudeRuntimeMarker,
    { assumePreviouslyManaged },
  );
  const claudeRuntimeOverrides = mergeManagedClaudeRuntimeOverrides(
    current,
    baseline,
    previousClaudeRuntimeMarker,
    { assumePreviouslyManaged },
  );
  return {
    packageJson: {
      ...baseline,
      ...current,
      dependencies: claudeRuntimeDependencies.dependencies,
      overrides: claudeRuntimeOverrides.overrides,
    },
    claudeRuntimeSources: {
      ...claudeRuntimeDependencies.sources,
      ...claudeRuntimeOverrides.sources,
    },
  };
};

// App startup blocks on these commands; a hung install (e.g. an unreachable
// registry stuck on "Resolving dependencies") must not stall the boot forever.
const RUN_COMMAND_TIMEOUT_MS = 120_000;

const runCommandDefault = (command, args, options) => new Promise((resolve) => {
  const child = spawnChild(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    resolve(payload);
  };
  const killTimer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    const forceKillTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 5_000);
    forceKillTimer.unref?.();
    finish({
      ok: false,
      exitCode: null,
      stdout,
      stderr: stderr || `${command} timed out after ${Math.round(RUN_COMMAND_TIMEOUT_MS / 1000)}s`,
    });
  }, RUN_COMMAND_TIMEOUT_MS);
  killTimer.unref?.();
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => finish({ ok: false, exitCode: null, stdout, stderr: error.message }));
  child.on('close', (exitCode) => finish({ ok: exitCode === 0, exitCode, stdout, stderr }));
});

export const createUserProfileProvisioningRuntime = (dependencies = {}) => {
  const fsApi = dependencies.fs || fs;
  const pathApi = dependencies.path || path;
  const homedir = dependencies.homedir || (() => os.homedir());
  const runCommand = dependencies.runCommand || runCommandDefault;
  const inspectManagedPluginInstallation = dependencies.inspectManagedPluginInstallation
    || inspectDevRyanManagedPluginInstallation;
  const applyContextModeHotfixFn = dependencies.applyContextModeHotfix
    || applyContextModeHotfix;
  const profileRoot = dependencies.profileRoot || DEFAULT_PROFILE_ROOT;
  const configRoot = dependencies.configRoot || DEFAULT_CONFIG_ROOT;
  const configDirectory = dependencies.configDirectory || pathApi.join(homedir(), '.config', 'opencode');
  const meridianConfigDirectory = dependencies.meridianConfigDirectory
    || pathApi.join(homedir(), '.config', 'meridian');
  const meridianSettingsPath = dependencies.meridianSettingsPath
    || pathApi.join(meridianConfigDirectory, 'sdk-features.json');
  const meridianPolicyMarkerPath = dependencies.meridianPolicyMarkerPath
    || pathApi.join(configDirectory, MERIDIAN_POLICY_MARKER_RELATIVE_PATH);

  const provision = async () => {
    const manifestPath = pathApi.join(configDirectory, MANIFEST_RELATIVE_PATH);
    const previousManifest = readJson(fsApi, manifestPath, { version: 1, files: {} });
    const previousFiles = isRecord(previousManifest.files) ? previousManifest.files : {};
    const nextFiles = {};
    const result = {
      ok: true,
      changed: false,
      conflicts: [],
      written: [],
      updated: [],
      removed: [],
      install: null,
      installDegraded: false,
      contextModeHotfix: null,
      contextModeHotfixReinstall: null,
      warnings: [],
      meridianPolicy: null,
      claudeRuntime: null,
      managedPluginIssues: [],
    };

    const meridianPolicy = applyManagedMeridianSdkFeaturePolicy({
      fs: fsApi,
      path: pathApi,
      settingsPath: meridianSettingsPath,
      markerPath: meridianPolicyMarkerPath,
    });
    result.meridianPolicy = meridianPolicy;
    if (!meridianPolicy.ok) {
      result.ok = false;
      result.error = meridianPolicy.error;
      return result;
    }
    result.changed = meridianPolicy.changed;
    if (meridianPolicy.warning) {
      result.warnings.push(meridianPolicy.warning);
    }

    fsApi.mkdirSync(configDirectory, { recursive: true });

    const syncContent = (relativePath, desiredContent, { mergeSafe = false } = {}) => {
      const targetPath = pathApi.join(configDirectory, relativePath);
      const desiredHash = hashContent(desiredContent);
      let currentContent = null;
      try { currentContent = fsApi.readFileSync(targetPath, 'utf8'); } catch { currentContent = null; }
      const previousHash = isRecord(previousFiles[relativePath]) ? previousFiles[relativePath].hash : null;
      const currentHash = currentContent === null ? null : hashContent(currentContent);
      if (currentContent === desiredContent) {
        nextFiles[relativePath] = { hash: desiredHash };
        return;
      }
      if (
        currentContent !== null
        && !mergeSafe
        && (
          previousHash && currentHash !== previousHash
        )
      ) {
        result.conflicts.push(targetPath);
        if (previousHash) {
          nextFiles[relativePath] = previousFiles[relativePath];
        }
        return;
      }
      fsApi.mkdirSync(pathApi.dirname(targetPath), { recursive: true });
      fsApi.writeFileSync(targetPath, desiredContent, 'utf8');
      result.changed = true;
      (currentContent === null ? result.written : result.updated).push(targetPath);
      nextFiles[relativePath] = { hash: desiredHash };
    };

    const configPath = pathApi.join(configDirectory, 'opencode.json');
    const baselineConfig = readJson(fsApi, pathApi.join(profileRoot, 'opencode.json'));
    const currentConfig = readJson(fsApi, configPath);
    // The desired config is assembled from the current user file plus the
    // narrowly reconciled DevRyan defaults. Treat it as merge-safe so legacy
    // managed specs cannot survive merely because the old managed file also
    // contains unrelated user edits.
    syncContent(
      'opencode.json',
      `${JSON.stringify(mergeOpenCodeConfig(currentConfig, baselineConfig), null, 2)}\n`,
      { mergeSafe: true },
    );

    for (const legacyConfigName of ['config.json', 'opencode.jsonc']) {
      const legacyConfigPath = pathApi.join(configDirectory, legacyConfigName);
      if (!fsApi.existsSync(legacyConfigPath)) continue;
      const source = fsApi.readFileSync(legacyConfigPath, 'utf8');
      const parseErrors = [];
      const parsed = parseJsonc(source, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0 || !isRecord(parsed) || !Array.isArray(parsed.plugin)) {
        if (parseErrors.length > 0) {
          result.warnings.push(
            `Skipped legacy managed plugin reconciliation for ${legacyConfigPath}: invalid JSON/JSONC`,
          );
        }
        continue;
      }
      const reconciledPlugins = removeDevRyanManagedLegacyPluginSpecs(parsed.plugin);
      if (JSON.stringify(reconciledPlugins) === JSON.stringify(parsed.plugin)) continue;
      const edits = modify(source, ['plugin'], reconciledPlugins, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: source.includes('\r\n') ? '\r\n' : '\n',
        },
      });
      fsApi.writeFileSync(legacyConfigPath, applyEdits(source, edits), 'utf8');
      result.changed = true;
      result.updated.push(legacyConfigPath);
    }

    const packagePath = pathApi.join(configDirectory, 'package.json');
    const baselinePackage = readJson(fsApi, pathApi.join(profileRoot, 'package.json'));
    const currentPackage = readJson(fsApi, packagePath);
    const previousClaudeRuntimeMarker = readClaudeRuntimeCompatibilityMarker(configDirectory, {
      fs: fsApi,
      path: pathApi,
    });
    let packageOwnedByManifest = false;
    try {
      const currentPackageContent = fsApi.readFileSync(packagePath, 'utf8');
      packageOwnedByManifest = previousFiles['package.json']?.hash === hashContent(currentPackageContent);
    } catch {
      packageOwnedByManifest = false;
    }
    const packageMerge = mergePackageJson(
      currentPackage,
      baselinePackage,
      previousClaudeRuntimeMarker,
      { assumePreviouslyManaged: packageOwnedByManifest },
    );
    const desiredPackage = packageMerge.packageJson;
    const dependenciesChanged = JSON.stringify(currentPackage.dependencies || {}) !== JSON.stringify(desiredPackage.dependencies || {});
    const overridesChanged = JSON.stringify(currentPackage.overrides || {}) !== JSON.stringify(desiredPackage.overrides || {});
    // package.json is assembled from the current user file plus managed defaults,
    // so writing that merged result cannot discard unrelated user fields. Allow
    // newly managed dependencies to land even when another package field changed
    // since the last provisioning manifest.
    syncContent('package.json', `${JSON.stringify(desiredPackage, null, 2)}\n`, { mergeSafe: true });

    syncContent('oh-my-opencode-slim.json', fsApi.readFileSync(pathApi.join(profileRoot, 'oh-my-opencode-slim.json'), 'utf8'));

    const canonicalAssets = await listDefaultConfigAssets(configRoot);
    for (const sourceRelativePath of canonicalAssets) {
      let targetRelativePath = null;
      if (sourceRelativePath.startsWith('agents/')) {
        targetRelativePath = sourceRelativePath;
      } else if (
        sourceRelativePath.startsWith('plugins/')
        && DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES.includes(sourceRelativePath.slice('plugins/'.length))
      ) {
        targetRelativePath = sourceRelativePath;
      }
      if (targetRelativePath) {
        syncContent(targetRelativePath, fsApi.readFileSync(pathApi.join(configRoot, sourceRelativePath), 'utf8'));
      }
    }
    const retiredSkillPaths = Object.keys(previousFiles)
      .filter((relativePath) => relativePath.startsWith('skills/'));
    const skillsDirectory = pathApi.join(configDirectory, 'skills');
    const retiredSkillDirectories = new Set(
      retiredSkillPaths.length > 0 ? [skillsDirectory] : [],
    );
    for (const relativePath of retiredSkillPaths) {
      const targetPath = pathApi.join(configDirectory, relativePath);
      let currentContent = null;
      try { currentContent = fsApi.readFileSync(targetPath, 'utf8'); } catch { currentContent = null; }
      const previousEntry = previousFiles[relativePath];
      if (
        currentContent !== null
        && isRecord(previousEntry)
        && hashContent(currentContent) === previousEntry.hash
      ) {
        fsApi.unlinkSync(targetPath);
        result.changed = true;
        result.removed.push(targetPath);
      }

      let candidateDirectory = pathApi.dirname(targetPath);
      while (
        candidateDirectory === skillsDirectory
        || candidateDirectory.startsWith(`${skillsDirectory}${pathApi.sep}`)
      ) {
        retiredSkillDirectories.add(candidateDirectory);
        if (candidateDirectory === skillsDirectory) break;
        candidateDirectory = pathApi.dirname(candidateDirectory);
      }
    }

    const retirementDirectories = [...retiredSkillDirectories]
      .sort((left, right) => right.split(pathApi.sep).length - left.split(pathApi.sep).length);
    for (const directoryPath of retirementDirectories) {
      try {
        const entries = fsApi.readdirSync(directoryPath);
        if (entries.length === 1 && entries[0] === '.DS_Store') {
          fsApi.unlinkSync(pathApi.join(directoryPath, '.DS_Store'));
        } else if (entries.length > 0) {
          continue;
        }
        fsApi.rmdirSync(directoryPath);
      } catch {
        // Retirement cleanup is best-effort. Non-empty and user-owned directories stay intact.
      }
    }

    const superpowersBootstrapPath = pathApi.join(
      configDirectory,
      'skills',
      'superpowers',
      'using-superpowers',
      'SKILL.md',
    );
    if (!fsApi.existsSync(superpowersBootstrapPath)) {
      result.warnings.push(
        'Superpowers skills are not installed; the optional adapter will remain disabled.',
      );
    }

    for (const [relativePath, previousEntry] of Object.entries(previousFiles)) {
      if (relativePath.startsWith('skills/')) continue;
      if (Object.prototype.hasOwnProperty.call(nextFiles, relativePath) || !isRecord(previousEntry)) continue;
      const targetPath = pathApi.join(configDirectory, relativePath);
      let currentContent = null;
      try { currentContent = fsApi.readFileSync(targetPath, 'utf8'); } catch { currentContent = null; }
      if (currentContent === null) continue;
      if (hashContent(currentContent) !== previousEntry.hash) {
        result.conflicts.push(targetPath);
        nextFiles[relativePath] = previousEntry;
        continue;
      }
      fsApi.unlinkSync(targetPath);
      result.changed = true;
      result.removed.push(targetPath);
    }

    const manifestContent = `${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`;
    const currentManifest = fsApi.existsSync(manifestPath) ? fsApi.readFileSync(manifestPath, 'utf8') : null;
    if (currentManifest !== manifestContent) {
      fsApi.mkdirSync(pathApi.dirname(manifestPath), { recursive: true });
      fsApi.writeFileSync(manifestPath, manifestContent, 'utf8');
      result.changed = true;
    }

    const dependencyNames = Object.keys(desiredPackage.dependencies || {});
    const missingDependency = [
      ...dependencyNames,
      ...Object.keys(CLAUDE_RUNTIME_MANAGED_OVERRIDES),
    ].some((name) => (
      !fsApi.existsSync(pathApi.join(configDirectory, 'node_modules', ...name.split('/')))
    ));
    const managedPluginIssuesBeforeInstall = inspectManagedPluginInstallation({
      configDirectory,
      fs: fsApi,
      path: pathApi,
    });
    const claudeRuntimeBeforeInstall = inspectClaudeRuntimeCompatibility({
      configDirectory,
      packageJson: desiredPackage,
      marker: previousClaudeRuntimeMarker,
      sources: packageMerge.claudeRuntimeSources,
      fs: fsApi,
      path: pathApi,
    });
    const claudeRuntimeNeedsInstall = claudeRuntimeBeforeInstall.runtimeStatus !== 'ready';
    if (
      dependenciesChanged
      || overridesChanged
      || missingDependency
      || managedPluginIssuesBeforeInstall.length > 0
      || claudeRuntimeNeedsInstall
    ) {
      result.install = await runCommand('bun', ['install', '--ignore-scripts'], { cwd: configDirectory, env: process.env });
      if (!result.install.ok) {
        const installFailure = `Failed to install OpenCode user plugins: ${result.install.stderr || `exit ${result.install.exitCode}`}`;
        const dependencyStillMissing = [
          ...dependencyNames,
          ...Object.keys(CLAUDE_RUNTIME_MANAGED_OVERRIDES),
        ].some((name) => (
          !fsApi.existsSync(pathApi.join(configDirectory, 'node_modules', ...name.split('/')))
        ));
        if (dependencyStillMissing) {
          result.ok = false;
          result.error = installFailure;
        } else {
          // Every managed dependency is already on disk from a prior install; a
          // failed refresh (offline, registry stall) must not block startup.
          result.installDegraded = true;
          result.warnings.push(`${installFailure}. Continuing with the previously installed plugins.`);
        }
      }
    }
    if (result.ok) {
      result.contextModeHotfix = applyContextModeHotfixFn({
        configDirectory,
        fs: fsApi,
      });
      if (!result.contextModeHotfix.ok && !result.installDegraded) {
        result.contextModeHotfixReinstall = await runCommand(
          'bun',
          ['install', '--force', '--ignore-scripts'],
          { cwd: configDirectory, env: process.env },
        );
        if (result.contextModeHotfixReinstall.ok) {
          result.contextModeHotfix = applyContextModeHotfixFn({
            configDirectory,
            fs: fsApi,
          });
        }
      }
      if (!result.contextModeHotfix.ok && result.installDegraded) {
        result.warnings.push(
          `${CONTEXT_MODE_HOTFIX_INCOMPATIBLE}: ${result.contextModeHotfix.error}. `
          + 'Continuing startup; provisioning will retry on the next launch.',
        );
      } else if (!result.contextModeHotfix.ok) {
        result.ok = false;
        result.error = `${CONTEXT_MODE_HOTFIX_INCOMPATIBLE}: ${result.contextModeHotfix.error}`;
      } else if (result.contextModeHotfix.changed) {
        result.changed = true;
      }
    }
    if (result.ok) {
      result.managedPluginIssues = inspectManagedPluginInstallation({
        configDirectory,
        fs: fsApi,
        path: pathApi,
      });
      if (result.managedPluginIssues.length > 0) {
        const issueSummary = result.managedPluginIssues
          .map((issue) => `${issue.pluginId}:${issue.kind}`)
          .join(', ');
        result.ok = false;
        result.error = `Managed OpenCode plugin validation failed after provisioning: ${issueSummary}`;
      }
    }

    result.claudeRuntime = inspectClaudeRuntimeCompatibility({
      configDirectory,
      packageJson: desiredPackage,
      marker: previousClaudeRuntimeMarker,
      sources: packageMerge.claudeRuntimeSources,
      fs: fsApi,
      path: pathApi,
    });
    if (
      result.ok
      && !result.installDegraded
      && result.claudeRuntime.source === 'managed'
      && result.claudeRuntime.runtimeStatus !== 'ready'
    ) {
      result.ok = false;
      result.error = `Managed Claude runtime installation remained ${result.claudeRuntime.runtimeStatus} after provisioning`;
    }
    const compatibilityMarkerPath = pathApi.join(
      configDirectory,
      COMPATIBILITY_MARKER_RELATIVE_PATH,
    );
    const compatibilityMarkerContent = `${JSON.stringify(buildClaudeRuntimeCompatibilityMarker({
      sources: packageMerge.claudeRuntimeSources,
      runtime: result.claudeRuntime,
    }), null, 2)}\n`;
    let previousCompatibilityMarkerContent = null;
    try {
      previousCompatibilityMarkerContent = fsApi.readFileSync(compatibilityMarkerPath, 'utf8');
    } catch {
      previousCompatibilityMarkerContent = null;
    }
    if (previousCompatibilityMarkerContent !== compatibilityMarkerContent) {
      fsApi.mkdirSync(pathApi.dirname(compatibilityMarkerPath), { recursive: true });
      fsApi.writeFileSync(compatibilityMarkerPath, compatibilityMarkerContent, 'utf8');
      result.changed = true;
      (previousCompatibilityMarkerContent === null ? result.written : result.updated)
        .push(compatibilityMarkerPath);
    }
    if (result.claudeRuntime.runtimeStatus !== 'ready') {
      result.warnings.push(
        `Claude runtime compatibility is ${result.claudeRuntime.runtimeStatus}; `
        + 'run user-profile provisioning again after repairing the managed packages.',
      );
    } else if (result.claudeRuntime.compatibilityStatus === 'upstream_blocked') {
      result.warnings.push(
        'Claude Code 2.1.215 is selected for Meridian compatibility; the broader cross-provider context target remains upstream-blocked.',
      );
    }

    return result;
  };

  return { provision, configDirectory, meridianConfigDirectory };
};

export { DEFAULT_PROFILE_ROOT };
