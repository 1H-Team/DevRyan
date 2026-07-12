import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const resolveWorkspacePackageDirectory = (repoRoot, workspaceDirectory, packageName) => {
  const workspacePackagePath = path.resolve(repoRoot, workspaceDirectory, 'package.json');
  const workspaceRequire = createRequire(workspacePackagePath);
  const dependencyPackagePath = workspaceRequire.resolve(`${packageName}/package.json`);
  return fs.realpathSync(path.dirname(dependencyPackagePath));
};

export const resolveCursorSdkSqliteDirectory = (repoRoot) => {
  const cursorRuntimePackagePath = path.resolve(
    repoRoot,
    'packages',
    'cursor-sdk-runtime',
    'package.json',
  );
  const cursorRuntimeRequire = createRequire(cursorRuntimePackagePath);
  const cursorSdkEntryPath = cursorRuntimeRequire.resolve('@cursor/sdk');
  const cursorSdkRequire = createRequire(cursorSdkEntryPath);
  const sqlitePackagePath = cursorSdkRequire.resolve('sqlite3/package.json');
  return fs.realpathSync(path.dirname(sqlitePackagePath));
};
