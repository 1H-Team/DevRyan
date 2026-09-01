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
  'RuntimeServiceControl.mm',
);
const outputDirectory = path.join(electronDirectory, 'resources', 'native');
const output = path.join(outputDirectory, 'DevRyanRuntimeServiceControl.node');

const targetArchitectures = Object.freeze({
  arm64: Object.freeze({ clangArch: 'arm64', lipoName: 'arm64' }),
  x64: Object.freeze({ clangArch: 'x86_64', lipoName: 'x86_64' }),
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

const nodePrefix = process.config.variables.node_prefix;
const nodeDirectory = process.env.npm_config_nodedir?.trim();
const nodeIncludeCandidates = [
  nodeDirectory,
  nodeDirectory ? path.join(nodeDirectory, 'include', 'node') : '',
  typeof nodePrefix === 'string' ? path.join(nodePrefix, 'include', 'node') : '',
  path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
].filter((candidate, index, candidates) => candidate && candidates.indexOf(candidate) === index);

let nodeInclude = '';
for (const candidate of nodeIncludeCandidates) {
  try {
    await fs.access(path.join(candidate, 'node_api.h'));
    nodeInclude = candidate;
    break;
  } catch {
    // Try the next supported Node installation layout.
  }
}
if (!nodeInclude) {
  throw new Error(
    `Node N-API headers are unavailable; checked: ${nodeIncludeCandidates.join(', ') || '(none)'}`,
  );
}

const result = spawnSync('xcrun', [
  'clang++',
  source,
  '-std=c++17',
  '-O2',
  '-fobjc-arc',
  '-fmodules',
  '-mmacosx-version-min=13.0',
  '-arch', target.clangArch,
  '-I', nodeInclude,
  '-bundle',
  '-undefined', 'dynamic_lookup',
  '-framework', 'Foundation',
  '-framework', 'ServiceManagement',
  '-o', output,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`clang++ failed with exit code ${result.status}`);

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
