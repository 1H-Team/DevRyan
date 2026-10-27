// Retained command name; production builds only the verified native v2 bundle.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv.length !== 2) throw new Error('Use bun scripts/build-native-runtime.mjs [--output-root <repository-directory>]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('bun', ['scripts/build-native-runtime.mjs'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
