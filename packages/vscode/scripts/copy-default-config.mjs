import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowedDefaultConfigRelativePath } from '../../web/server/lib/opencode/default-config-assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(packageRoot, '..', 'web', 'server', 'default-config');
const targetRoot = path.join(packageRoot, 'dist', 'default-config');

const shouldCopy = async (source) => {
  const relative = path.relative(sourceRoot, source);
  if (!relative || relative.startsWith('..')) return true;
  return isAllowedDefaultConfigRelativePath(relative, {
    directory: (await fs.stat(source)).isDirectory(),
  });
};

await fs.rm(targetRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(targetRoot), { recursive: true });
await fs.cp(sourceRoot, targetRoot, { recursive: true, filter: shouldCopy });
console.log('[vscode] copied packaged OpenCode defaults');
