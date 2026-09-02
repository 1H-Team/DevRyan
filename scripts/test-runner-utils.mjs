import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const testFilePattern = /(?:^|[./-])test\.[cm]?[jt]sx?$/;

const mockModulePattern = /\bmock\.module\s*\(/;
const globalWindowMutationPattern = /(?:global(?:This|WithWindow)|\([^)]*globalThis[^)]*\))\.window\s*=|Object\.defineProperty\s*\(\s*globalThis\s*,\s*['"]window['"]|delete\s+(?:global(?:This|WithWindow)|\([^)]*globalThis[^)]*\))\.window/;
const globalSessionStorageMutationPattern = /(?:global(?:This|WithWindow)|\([^)]*globalThis[^)]*\))\.sessionStorage\s*=|Object\.defineProperty\s*\(\s*globalThis\s*,\s*['"]sessionStorage['"]|delete\s+(?:global(?:This|WithWindow)|\([^)]*globalThis[^)]*\))\.sessionStorage/;
const globalFileReaderMutationPattern = /(?:global(?:This|WithWindow)|\([^)]*globalThis[^)]*\))\.FileReader\s*=|Object\.defineProperty\s*\(\s*globalThis\s*,\s*['"]FileReader['"]|delete\s+(?:global(?:This|WithWindow)|\([^)]*globalThis[^)]*\))\.FileReader/;

export function isIsolatedUiTestSource(source) {
  return mockModulePattern.test(source)
    || globalWindowMutationPattern.test(source)
    || globalSessionStorageMutationPattern.test(source)
    || globalFileReaderMutationPattern.test(source);
}

export function discoverTestFiles(directory, rootDirectory, options = {}) {
  const pattern = options.pattern ?? testFilePattern;
  const ignoredDirectories = options.ignoredDirectories ?? new Set(['node_modules', 'dist']);
  const results = [];

  function walk(currentDirectory) {
    if (!existsSync(currentDirectory)) return;

    for (const entry of readdirSync(currentDirectory)) {
      if (ignoredDirectories.has(entry)) continue;

      const absolutePath = path.join(currentDirectory, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join('/');
      if (pattern.test(relativePath)) results.push(relativePath);
    }
  }

  walk(directory);
  return results.sort();
}
