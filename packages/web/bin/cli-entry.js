import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

function normalizeCliEntryPath(filePath, realpath = fs.realpathSync) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  try {
    return realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isModuleCliExecution(
  entryPath = process.argv[1],
  moduleUrl,
  realpath = fs.realpathSync,
  expectedBinName,
) {
  if (typeof entryPath !== 'string' || entryPath.trim().length === 0) {
    return false;
  }
  if (typeof moduleUrl !== 'string' || moduleUrl.trim().length === 0) {
    return false;
  }

  try {
    const normalizedEntryPath = normalizeCliEntryPath(entryPath, realpath);
    const normalizedModulePath = normalizeCliEntryPath(fileURLToPath(moduleUrl), realpath);
    if (!normalizedEntryPath || !normalizedModulePath) {
      return false;
    }
    if (pathToFileURL(normalizedEntryPath).href === pathToFileURL(normalizedModulePath).href) {
      return true;
    }

    // One name or several (the `devryan` bin and its `openchamber` alias).
    const expectedNames = (Array.isArray(expectedBinName) ? expectedBinName : [expectedBinName])
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .map((name) => name.trim().toLowerCase());
    if (expectedNames.length > 0) {
      const parsedEntryName = path.parse(normalizedEntryPath).name.toLowerCase();
      return expectedNames.includes(parsedEntryName);
    }

    return false;
  } catch {
    return false;
  }
}

export {
  normalizeCliEntryPath,
  isModuleCliExecution,
};
