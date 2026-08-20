import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export const resolvePackagedMacArch = (arch) => {
  if (arch === 'x64' || arch === 1) {
    return 'x64';
  }
  if (arch === 'arm64' || arch === 3) {
    return 'arm64';
  }

  throw new Error(`Unsupported packaged macOS architecture: ${String(arch)}`);
};

export const getRequiredPackagedNativeArtifacts = (appPath, arch) => {
  const targetArch = resolvePackagedMacArch(arch);
  const nodeModulesPath = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
  );

  return [
    {
      name: 'better-sqlite3',
      path: path.join(nodeModulesPath, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      executable: false,
    },
    {
      name: 'node-pty',
      path: path.join(nodeModulesPath, 'node-pty', 'build', 'Release', 'pty.node'),
      executable: false,
    },
    {
      name: 'Cursor ripgrep',
      path: path.join(nodeModulesPath, '@cursor', `sdk-darwin-${targetArch}`, 'bin', 'rg'),
      executable: true,
    },
    {
      name: 'Cursor sandbox',
      path: path.join(nodeModulesPath, '@cursor', `sdk-darwin-${targetArch}`, 'bin', 'cursorsandbox'),
      executable: true,
    },
    {
      name: 'Cursor tree-sitter',
      path: path.join(nodeModulesPath, '@cursor', `sdk-darwin-${targetArch}`, 'vendor', 'tree-sitter', 'binding.node'),
      executable: false,
    },
    {
      name: 'Cursor tree-sitter-bash',
      path: path.join(nodeModulesPath, '@cursor', `sdk-darwin-${targetArch}`, 'vendor', 'tree-sitter-bash', 'binding.node'),
      executable: false,
    },
  ];
};

export const verifyPackagedNativeArtifacts = (appPath, arch) => {
  const failures = [];
  const artifacts = getRequiredPackagedNativeArtifacts(appPath, arch);

  for (const artifact of artifacts) {
    try {
      accessSync(artifact.path, constants.F_OK);
    } catch {
      failures.push(`${artifact.name}: missing ${artifact.path}`);
      continue;
    }

    if (!artifact.executable) {
      continue;
    }

    try {
      accessSync(artifact.path, constants.X_OK);
    } catch {
      failures.push(`${artifact.name}: not executable ${artifact.path}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Packaged native artifact verification failed:\n${failures.join('\n')}`);
  }

  return artifacts;
};
