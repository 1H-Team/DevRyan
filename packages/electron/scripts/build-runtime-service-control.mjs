#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const electronDirectory = path.resolve(scriptDirectory, '..');
const source = path.join(
  electronDirectory,
  'native',
  'runtime-service-control',
  'RuntimeServiceControl.swift',
);
const outputDirectory = path.join(electronDirectory, 'resources', 'native');
const output = path.join(outputDirectory, 'DevRyanRuntimeServiceControl');

const targetArchitectures = Object.freeze({
  arm64: Object.freeze({ swiftTarget: 'arm64-apple-macosx13.0', lipoName: 'arm64' }),
  x64: Object.freeze({ swiftTarget: 'x86_64-apple-macosx13.0', lipoName: 'x86_64' }),
});

const requestedArchitecture = process.env.ELECTRON_BUILDER_ARCH?.trim() || process.arch;
const target = targetArchitectures[requestedArchitecture];

if (!target) {
  throw new Error(`Unsupported runtime-service helper architecture: ${requestedArchitecture}`);
}

await fs.mkdir(outputDirectory, { recursive: true });
if (process.platform !== 'darwin') {
  console.log('[electron] skipping runtime-service control build on non-macOS host');
  process.exit(0);
}

const result = spawnSync('xcrun', [
  'swiftc',
  source,
  '-O',
  '-target', target.swiftTarget,
  '-framework', 'ServiceManagement',
  '-o', output,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`swiftc failed with exit code ${result.status}`);

const architectureResult = spawnSync('/usr/bin/lipo', ['-archs', output], { encoding: 'utf8' });
if (architectureResult.error) throw architectureResult.error;
if (architectureResult.status !== 0) {
  throw new Error(`lipo failed with exit code ${architectureResult.status}`);
}
const architectures = architectureResult.stdout.trim().split(/\s+/).filter(Boolean);
if (!architectures.includes(target.lipoName)) {
  throw new Error(
    `Runtime-service helper is missing ${target.lipoName}; found ${architectures.join(', ') || 'none'}`,
  );
}
await fs.chmod(output, 0o755);
console.log(
  `[electron] runtime-service control built for ${target.lipoName} -> ${output}`,
);
