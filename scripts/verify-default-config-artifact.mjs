import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  isManagedDefaultConfigRelativePath,
  isProhibitedDefaultConfigRelativePath,
  listDefaultConfigAssets,
} from '../packages/web/server/lib/opencode/default-config-assets.js';

const hashFile = async (filePath) => crypto.createHash('sha256')
  .update(await fs.readFile(filePath))
  .digest('hex');

const listFiles = async (root, relative = '') => {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    if (entry.isFile()) files.push(next.split(path.sep).join('/'));
  }
  return files;
};

export const verifyDefaultConfigArtifact = async ({ source, artifactRoot }) => {
  const [expected, artifactFiles] = await Promise.all([
    listDefaultConfigAssets(source),
    listFiles(artifactRoot),
  ]);
  const missing = [];
  const altered = [];
  for (const relativePath of expected) {
    const sourcePath = path.join(source, relativePath);
    const artifactPath = path.join(artifactRoot, relativePath);
    try {
      const [sourceHash, artifactHash] = await Promise.all([hashFile(sourcePath), hashFile(artifactPath)]);
      if (sourceHash !== artifactHash) altered.push(relativePath);
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(relativePath);
      else throw error;
    }
  }
  const prohibited = artifactFiles.filter((relativePath) => (
    isManagedDefaultConfigRelativePath(relativePath)
    && isProhibitedDefaultConfigRelativePath(relativePath)
  ));
  return {
    ok: missing.length === 0 && altered.length === 0 && prohibited.length === 0,
    missing: missing.sort(),
    altered: altered.sort(),
    prohibited: prohibited.sort(),
  };
};

export const formatArtifactDiagnostics = (result) => {
  if (result.ok) return 'Default-config artifact verification passed.';
  const sections = [
    ['missing', result.missing],
    ['altered', result.altered],
    ['prohibited', result.prohibited],
  ].filter(([, entries]) => entries.length > 0)
    .map(([label, entries]) => `${label}:\n${entries.map((entry) => `- ${entry}`).join('\n')}`);
  return `Default-config artifact verification failed:\n${sections.join('\n')}`;
};

const readArg = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  const source = readArg('--source');
  const artifactRoot = readArg('--artifact-root');
  if (!source || !artifactRoot) {
    console.error('Usage: node scripts/verify-default-config-artifact.mjs --source <default-config> --artifact-root <default-config>');
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyDefaultConfigArtifact({ source, artifactRoot });
      console.log(formatArtifactDiagnostics(result));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`Default-config artifact verification failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
