import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { listDefaultConfigAssets } from './default-config-assets.js';
import {
  DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
  DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES,
  inspectDevRyanManagedPluginInstallation,
  reconcileDevRyanManagedPluginSpecs,
  removeDevRyanManagedLegacyPluginSpecs,
} from './managed-plugins.js';
import { applyManagedMeridianSdkFeaturePolicy } from './meridian-sdk-features.js';

const DEFAULT_CONFIG_ROOT = path.resolve(process.cwd(), 'server', 'default-config');
const DEFAULT_PROFILE_ROOT = path.join(DEFAULT_CONFIG_ROOT, 'user-profile');
const MANIFEST_RELATIVE_PATH = path.join('.openchamber', 'user-profile-manifest.json');
const MERIDIAN_POLICY_MARKER_RELATIVE_PATH = path.join(
  '.openchamber',
  'meridian-sdk-features-policy.json',
);
const MERIDIAN_PACKAGE = '@rynfar/meridian';

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

const mergePackageJson = (current, baseline) => {
  const currentDependencies = isRecord(current.dependencies) ? current.dependencies : {};
  const dependencies = {
    ...currentDependencies,
    ...(isRecord(baseline.dependencies) ? baseline.dependencies : {}),
    ...DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
  };
  const explicitMeridianPin = currentDependencies[MERIDIAN_PACKAGE];
  if (typeof explicitMeridianPin === 'string' && explicitMeridianPin.trim()) {
    dependencies[MERIDIAN_PACKAGE] = explicitMeridianPin;
  }
  return {
    ...baseline,
    ...current,
    dependencies,
  };
};

const runCommandDefault = (command, args, options) => new Promise((resolve) => {
  const child = spawnChild(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => resolve({ ok: false, exitCode: null, stdout, stderr: error.message }));
  child.on('close', (exitCode) => resolve({ ok: exitCode === 0, exitCode, stdout, stderr }));
});

export const createUserProfileProvisioningRuntime = (dependencies = {}) => {
  const fsApi = dependencies.fs || fs;
  const pathApi = dependencies.path || path;
  const homedir = dependencies.homedir || (() => os.homedir());
  const runCommand = dependencies.runCommand || runCommandDefault;
  const inspectManagedPluginInstallation = dependencies.inspectManagedPluginInstallation
    || inspectDevRyanManagedPluginInstallation;
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
      warnings: [],
      meridianPolicy: null,
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
    const desiredPackage = mergePackageJson(currentPackage, baselinePackage);
    const dependenciesChanged = JSON.stringify(currentPackage.dependencies || {}) !== JSON.stringify(desiredPackage.dependencies || {});
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
    if (dependenciesChanged || missingDependency || managedPluginIssuesBeforeInstall.length > 0) {
      result.install = await runCommand('bun', ['install', '--ignore-scripts'], { cwd: configDirectory, env: process.env });
      if (!result.install.ok) {
        result.ok = false;
        result.error = `Failed to install OpenCode user plugins: ${result.install.stderr || `exit ${result.install.exitCode}`}`;
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

    return result;
  };

  return { provision, configDirectory, meridianConfigDirectory };
};

export { DEFAULT_PROFILE_ROOT };
