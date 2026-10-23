import fs from 'fs';
import { getRuntimeHome } from './runtime-host/runtime-bundle-binding.js';
import path from 'path';
import {
  AGENT_SCOPE,
  CONFIG_FILE,
  CUSTOM_CONFIG_FILE,
  OPENCODE_CONFIG_DIR,
  getFolderConfigPaths,
  isPlainObject,
  readConfigFile,
} from './shared.js';

const OFFICIAL_USER_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
const USER_CONFIG_PATHS = [
  CONFIG_FILE,
  OFFICIAL_USER_CONFIG_FILE,
  path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
];
const MCP_RECOVERY_MANIFEST_PATH = path.join(OPENCODE_CONFIG_DIR, '.devryan', 'mcp-recovery.json');

function getProjectOfficialConfigPaths(workingDirectory) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
  ];
}

function getProjectLegacyConfigPaths(workingDirectory) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
}

function getProjectMcpWritePath(workingDirectory) {
  if (!workingDirectory) return null;
  for (const candidate of getProjectLegacyConfigPaths(workingDirectory)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of getProjectOfficialConfigPaths(workingDirectory)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(workingDirectory, '.opencode', 'opencode.json');
}

function getUserMcpSourceKind(userPath) {
  if (userPath === CONFIG_FILE) return 'user-legacy';
  return 'user';
}

function backupPathsFor(configPath) {
  return [
    `${configPath}.devryan.backup`,
    `${configPath}.openchamber.backup`,
    `${configPath}.bak`,
  ];
}

function existingSource(source) {
  return source.path && fs.existsSync(source.path)
    ? { ...source, config: readConfigFile(source.path), exists: true }
    : { ...source, config: {}, exists: false };
}

function getActiveMcpSources(workingDirectory) {
  const sources = [];

  for (const userPath of USER_CONFIG_PATHS) {
    sources.push(existingSource({
      path: userPath,
      scope: AGENT_SCOPE.USER,
      kind: getUserMcpSourceKind(userPath),
      active: true,
      recoverable: false,
      targetPath: OFFICIAL_USER_CONFIG_FILE,
      origin: 'opencode',
    }));
  }

  // Same order as mcp.js and OpenCode 2: direct opencode.json(c) files from
  // the outermost parent folder in, then the .opencode files the same way. A
  // parent folder's file is user-scoped and edited in place; an unreadable
  // one is skipped.
  const projectTargetPath = getProjectMcpWritePath(workingDirectory);
  const ownSource = (projectPath, kind) => existingSource({
    path: projectPath,
    scope: AGENT_SCOPE.PROJECT,
    kind,
    active: true,
    recoverable: false,
    targetPath: projectTargetPath,
    origin: 'opencode',
  });
  const ownPaths = new Set([...getProjectOfficialConfigPaths(workingDirectory), ...getProjectLegacyConfigPaths(workingDirectory)]);
  const parentPaths = getFolderConfigPaths(workingDirectory).filter((folderPath) => !ownPaths.has(folderPath));
  const inDotFolder = (folderPath) => path.basename(path.dirname(folderPath)) === '.opencode';
  const parentSources = (paths) => paths.flatMap((folderPath) => {
    try {
      return [existingSource({
        path: folderPath,
        scope: AGENT_SCOPE.USER,
        kind: 'folder',
        active: true,
        recoverable: false,
        targetPath: folderPath,
        origin: 'opencode',
      })];
    } catch {
      return [];
    }
  });

  sources.push(...parentSources(parentPaths.filter((folderPath) => !inDotFolder(folderPath))));
  sources.push(...getProjectOfficialConfigPaths(workingDirectory).map((projectPath) => ownSource(projectPath, 'project')));
  sources.push(...parentSources(parentPaths.filter(inDotFolder)));
  sources.push(...getProjectLegacyConfigPaths(workingDirectory).map((projectPath) => ownSource(projectPath, 'project-legacy')));

  if (CUSTOM_CONFIG_FILE) {
    sources.push(existingSource({
      path: CUSTOM_CONFIG_FILE,
      scope: AGENT_SCOPE.USER,
      kind: 'custom',
      active: true,
      recoverable: false,
      targetPath: CUSTOM_CONFIG_FILE,
      origin: 'opencode',
    }));
  }

  return sources;
}

function getRecoveryMcpSources(workingDirectory) {
  const sources = [];
  for (const userPath of USER_CONFIG_PATHS) {
    for (const backupPath of backupPathsFor(userPath)) {
      if (!fs.existsSync(backupPath)) continue;
      sources.push(existingSource({
        path: backupPath,
        scope: AGENT_SCOPE.USER,
        kind: 'user-backup',
        active: false,
        recoverable: true,
        targetPath: OFFICIAL_USER_CONFIG_FILE,
        origin: 'backup',
      }));
    }
  }

  if (workingDirectory) {
    const projectTargetPath = getProjectMcpWritePath(workingDirectory);
    for (const projectPath of getProjectOfficialConfigPaths(workingDirectory)) {
      for (const backupPath of backupPathsFor(projectPath)) {
        if (!fs.existsSync(backupPath)) continue;
        sources.push(existingSource({
          path: backupPath,
          scope: AGENT_SCOPE.PROJECT,
          kind: 'project-backup',
          active: false,
          recoverable: true,
          targetPath: projectTargetPath,
          origin: 'backup',
        }));
      }
    }

    for (const legacyPath of getProjectLegacyConfigPaths(workingDirectory)) {
      if (fs.existsSync(legacyPath)) {
        sources.push(existingSource({
          path: legacyPath,
          scope: AGENT_SCOPE.PROJECT,
          kind: 'project-legacy',
          active: false,
          recoverable: true,
          targetPath: projectTargetPath,
          origin: 'legacy',
        }));
      }
      for (const backupPath of backupPathsFor(legacyPath)) {
        if (!fs.existsSync(backupPath)) continue;
        sources.push(existingSource({
          path: backupPath,
          scope: AGENT_SCOPE.PROJECT,
          kind: 'project-legacy-backup',
          active: false,
          recoverable: true,
          targetPath: projectTargetPath,
          origin: 'backup',
        }));
      }
    }
  }

  return sources;
}

function getCursorMcpSources() {
  const cursorPaths = [
    path.join(getRuntimeHome(), '.cursor', 'mcp.json'),
  ];

  return cursorPaths
    .filter((cursorPath) => fs.existsSync(cursorPath))
    .map((cursorPath) => existingSource({
      path: cursorPath,
      scope: AGENT_SCOPE.USER,
      kind: 'cursor-user',
      active: false,
      recoverable: false,
      targetPath: OFFICIAL_USER_CONFIG_FILE,
      origin: 'cursor',
    }));
}

function describeMcpSource(source) {
  if (!source) return null;
  return {
    path: source.path,
    scope: source.scope,
    kind: source.kind,
    active: source.active === true,
    recoverable: source.recoverable === true,
    targetPath: source.targetPath,
    origin: source.origin,
  };
}

function getMcpSection(config) {
  return isPlainObject(config?.mcp) ? config.mcp : {};
}

export {
  OFFICIAL_USER_CONFIG_FILE,
  USER_CONFIG_PATHS,
  MCP_RECOVERY_MANIFEST_PATH,
  getProjectOfficialConfigPaths,
  getProjectLegacyConfigPaths,
  getProjectMcpWritePath,
  backupPathsFor,
  getActiveMcpSources,
  getRecoveryMcpSources,
  getCursorMcpSources,
  describeMcpSource,
  getMcpSection,
};
