import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(packageRoot, '..', 'web', 'server', 'default-config');
const targetRoot = path.join(packageRoot, 'dist', 'default-config');

const shouldCopy = (source) => {
  const relative = path.relative(sourceRoot, source);
  if (!relative || relative.startsWith('..')) return true;
  const segments = relative.split(path.sep);
  if (segments.includes('.DS_Store')) return false;
  const fileName = path.basename(source);
  if (/(^|[.-])(test|spec)\./.test(fileName) || fileName.endsWith('.d.ts')) return false;
  return segments[0] === 'agents'
    || segments[0] === 'plugins'
    || segments[0] === 'user-profile';
};

await fs.rm(targetRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(targetRoot), { recursive: true });
await fs.cp(sourceRoot, targetRoot, { recursive: true, filter: shouldCopy });
console.log('[vscode] copied packaged OpenCode defaults');
