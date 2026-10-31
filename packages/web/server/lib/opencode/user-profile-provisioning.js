import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { getAntigravityPluginGoogleModelKeyPaths } from './antigravity-retirement.js';
import { listDefaultConfigAssets } from './default-config-assets.js';
import { retireLegacyCursorPlugin } from './legacy-cursor-plugin.js';
import { removeJsoncKeyPaths, removeKeyPathsFromObject } from './jsonc-config.js';
import { migrateLegacyAgentsConfig } from './slim-config.js';
import {
  DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
  DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES,
  RETIRED_DEVRYAN_PROFILE_DEPENDENCIES,
  inspectDevRyanManagedPluginInstallation,
  reconcileDevRyanManagedPluginSpecs,
  removeDevRyanManagedLegacyPluginSpecs,
} from './managed-plugins.js';
import { applyImagegenModelHotfix } from './imagegen-model-hotfix.js';
import { migrateDevRyanSidecarDirectory } from './devryan-sidecar.js';

const DEFAULT_CONFIG_ROOT = path.resolve(process.cwd(), 'server', 'default-config');
const DEFAULT_PROFILE_ROOT = path.join(DEFAULT_CONFIG_ROOT, 'user-profile');
const MANIFEST_RELATIVE_PATH = path.join('.devryan', 'user-profile-manifest.json');
// Markers DevRyan wrote for the retired Meridian Claude runtime (removed 2026-10).
const RETIRED_CLAUDE_MARKER_RELATIVE_PATHS = Object.freeze([
  path.join('.devryan', 'meridian-sdk-features-policy.json'),
  path.join('.devryan', 'claude-runtime-compatibility.json'),
]);
// Overrides DevRyan pinned for that runtime, at the exact versions it pinned;
// a user-owned override at any other version is left alone.
const RETIRED_CLAUDE_PROFILE_OVERRIDES = Object.freeze({
  '@anthropic-ai/claude-agent-sdk': Object.freeze(['0.2.140', '0.2.141']),
  '@anthropic-ai/claude-code': Object.freeze(['2.1.215', '2.1.251', '2.1.280', '2.1.302']),
});

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

// Antigravity is retired: drop the Google models its plugin wrote into the
// profile. User-authored Google models and provider options stay.
const removeRetiredAntigravityModels = (config) => (
  removeKeyPathsFromObject(config, getAntigravityPluginGoogleModelKeyPaths(config))
);

const mergeOpenCodeConfig = (rawCurrent, baseline) => {
  const current = removeRetiredAntigravityModels(rawCurrent);
  return {
    ...current,
    ...baseline,
    plugin: reconcileDevRyanManagedPluginSpecs(current.plugin, baseline.plugin),
    agent: {
      ...(isRecord(current.agent) ? current.agent : {}),
      ...(isRecord(baseline.agent) ? baseline.agent : {}),
    },
  };
};

// Drop dependencies DevRyan used to pin, but only at the exact version it pinned;
// a user-owned version of the same package is left alone.
const removeRetiredProfileDependencies = (dependencies) => {
  if (!isRecord(dependencies)) return dependencies;
  const retained = { ...dependencies };
  for (const [packageName, retiredVersion] of Object.entries(RETIRED_DEVRYAN_PROFILE_DEPENDENCIES)) {
    if (retained[packageName] === retiredVersion) delete retained[packageName];
  }
  return retained;
};

const removeRetiredProfileOverrides = (overrides) => {
  if (!isRecord(overrides)) return overrides;
  const retained = { ...overrides };
  for (const [packageName, versions] of Object.entries(RETIRED_CLAUDE_PROFILE_OVERRIDES)) {
    if (versions.includes(retained[packageName])) delete retained[packageName];
  }
  return Object.keys(retained).length ? retained : undefined;
};

const mergePackageJson = (rawCurrent, baseline) => {
  const current = { ...rawCurrent };
  if (isRecord(current.dependencies)) current.dependencies = removeRetiredProfileDependencies(current.dependencies);
  if ('overrides' in current) {
    const overrides = removeRetiredProfileOverrides(current.overrides);
    if (overrides === undefined) delete current.overrides;
    else current.overrides = overrides;
  }
  const currentDependencies = isRecord(current.dependencies) ? current.dependencies : {};
  return {
    ...baseline,
    ...current,
    dependencies: {
      ...currentDependencies,
      ...(isRecord(baseline.dependencies) ? baseline.dependencies : {}),
      ...DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
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
  const applyImagegenModelHotfixFn = dependencies.applyImagegenModelHotfix || applyImagegenModelHotfix;
  const profileRoot = dependencies.profileRoot || DEFAULT_PROFILE_ROOT;
  const configRoot = dependencies.configRoot || DEFAULT_CONFIG_ROOT;
  const configDirectory = dependencies.configDirectory || pathApi.join(homedir(), '.config', 'opencode');

  const provision = async () => {
    migrateDevRyanSidecarDirectory(configDirectory);
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
      warnings: [],
      managedPluginIssues: [],
      profileNotices: [],
    };

    // Retiring the legacy plugin is cleanup and must never block OpenCode.
    // An unresolved copy keeps loading as it did before, and the user is told
    // and offered an explicit retire action.
    const cursorRetirement = retireLegacyCursorPlugin({ configDirectory, fs: fsApi });
    result.legacyCursorPlugin = cursorRetirement;
    result.changed = cursorRetirement.changed;
    result.updated.push(...cursorRetirement.updated);
    result.removed.push(...cursorRetirement.removed);
    result.conflicts.push(...cursorRetirement.conflicts);
    if (!cursorRetirement.ok) {
      result.profileNotices.push({
        code: 'legacy_cursor_plugin_conflict',
        files: cursorRetirement.conflicts,
        message: 'A legacy Cursor plugin (cursor-acp.js) could not be retired automatically. It still loads, and its tools bypass OpenCode permission rules.',
        error: cursorRetirement.error,
      });
      result.warnings.push(`${cursorRetirement.error} (${cursorRetirement.conflicts.join(', ') || 'no conflicting path'})`);
    }

    fsApi.mkdirSync(configDirectory, { recursive: true });
    for (const relativePath of RETIRED_CLAUDE_MARKER_RELATIVE_PATHS) {
      const markerPath = pathApi.join(configDirectory, relativePath);
      try {
        fsApi.unlinkSync(markerPath);
        result.changed = true;
        result.removed.push(markerPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') result.warnings.push(`Could not remove retired Claude marker ${markerPath}`);
      }
    }

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
          !previousHash || currentHash !== previousHash
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
      if (parseErrors.length > 0 || !isRecord(parsed)) {
        if (parseErrors.length > 0) {
          result.warnings.push(
            `Skipped legacy managed plugin reconciliation for ${legacyConfigPath}: invalid JSON/JSONC`,
          );
        }
        continue;
      }
      let nextSource = source;
      if (Array.isArray(parsed.plugin)) {
        const reconciledPlugins = removeDevRyanManagedLegacyPluginSpecs(parsed.plugin);
        if (JSON.stringify(reconciledPlugins) !== JSON.stringify(parsed.plugin)) {
          const edits = modify(nextSource, ['plugin'], reconciledPlugins, {
            formattingOptions: {
              insertSpaces: true,
              tabSize: 2,
              eol: source.includes('\r\n') ? '\r\n' : '\n',
            },
          });
          nextSource = applyEdits(nextSource, edits);
        }
      }
      nextSource = removeJsoncKeyPaths(nextSource, getAntigravityPluginGoogleModelKeyPaths(parsed));
      if (nextSource === source) continue;
      fsApi.writeFileSync(legacyConfigPath, nextSource, 'utf8');
      result.changed = true;
      result.updated.push(legacyConfigPath);
    }

    const packagePath = pathApi.join(configDirectory, 'package.json');
    const baselinePackage = readJson(fsApi, pathApi.join(profileRoot, 'package.json'));
    const currentPackage = readJson(fsApi, packagePath);
    const desiredPackage = mergePackageJson(currentPackage, baselinePackage);
    const dependenciesChanged = JSON.stringify(currentPackage.dependencies || {}) !== JSON.stringify(desiredPackage.dependencies || {});
    const overridesChanged = JSON.stringify(currentPackage.overrides || {}) !== JSON.stringify(desiredPackage.overrides || {});
    // A personal legacy agent config becomes the new-name file first, so the
    // shipped default never shadows it.
    migrateLegacyAgentsConfig({ configDirectory });
    syncContent('devryan-agents.jsonc', fsApi.readFileSync(pathApi.join(profileRoot, 'devryan-agents.jsonc'), 'utf8'));

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
    // This merge retains unrelated user fields.
    syncContent('package.json', `${JSON.stringify(desiredPackage, null, 2)}\n`, { mergeSafe: true });
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
    const missingDependency = dependencyNames.some((name) => (
      !fsApi.existsSync(pathApi.join(configDirectory, 'node_modules', ...name.split('/')))
    ));
    const managedPluginIssuesBeforeInstall = inspectManagedPluginInstallation({
      configDirectory,
      fs: fsApi,
      path: pathApi,
    });
    if (
      dependenciesChanged
      || overridesChanged
      || missingDependency
      || managedPluginIssuesBeforeInstall.length > 0
    ) {
      result.install = await runCommand('bun', ['install', '--ignore-scripts'], { cwd: configDirectory, env: process.env });
      if (!result.install.ok) {
        const installFailure = `Failed to install OpenCode user plugins: ${result.install.stderr || `exit ${result.install.exitCode}`}`;
        const dependencyStillMissing = dependencyNames.some((name) => (
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

    if (result.ok) {
      result.imagegenModelHotfix = applyImagegenModelHotfixFn({ configDirectory, fs: fsApi });
      if (!result.imagegenModelHotfix.ok) {
        result.ok = false;
        result.error = `${result.imagegenModelHotfix.code}: ${result.imagegenModelHotfix.error}`;
      } else if (result.imagegenModelHotfix.changed) result.changed = true;
    }

    return result;
  };

  return { provision, configDirectory };
};

export { DEFAULT_PROFILE_ROOT };
