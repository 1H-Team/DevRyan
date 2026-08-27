#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..');
const sourceDir = path.join(electronDir, 'native', 'macos-speech');
const outputDir = path.join(electronDir, 'resources', 'native');
const sourceFile = path.join(sourceDir, 'MacosSpeechHelper.swift');
const infoPlist = path.join(sourceDir, 'Info.plist');
const outputFile = path.join(outputDir, 'macos-speech-helper');
const targetArchitectures = Object.freeze({
  arm64: Object.freeze({ swiftTarget: 'arm64-apple-macosx13.0', lipoName: 'arm64' }),
  x64: Object.freeze({ swiftTarget: 'x86_64-apple-macosx13.0', lipoName: 'x86_64' }),
});
const requestedArchitecture = process.env.ELECTRON_BUILDER_ARCH?.trim() || process.arch;
const target = targetArchitectures[requestedArchitecture];

if (!target) {
  throw new Error(`Unsupported speech-helper architecture: ${requestedArchitecture}`);
}

await fs.mkdir(outputDir, { recursive: true });

if (process.platform !== 'darwin') {
  console.log('[electron] skipping macOS speech helper build on non-macOS host');
  process.exit(0);
}

const result = spawnSync('xcrun', [
  'swiftc',
  sourceFile,
  '-O',
  '-target', target.swiftTarget,
  '-framework', 'Speech',
  '-framework', 'AVFoundation',
  '-Xlinker', '-sectcreate',
  '-Xlinker', '__TEXT',
  '-Xlinker', '__info_plist',
  '-Xlinker', infoPlist,
  '-o', outputFile,
], { stdio: 'inherit' });

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(`swiftc failed with exit code ${result.status}`);
}

const architectureResult = spawnSync('/usr/bin/lipo', ['-archs', outputFile], { encoding: 'utf8' });
if (architectureResult.error) throw architectureResult.error;
if (architectureResult.status !== 0) {
  throw new Error(`lipo failed with exit code ${architectureResult.status}`);
}
const architectures = architectureResult.stdout.trim().split(/\s+/).filter(Boolean);
if (!architectures.includes(target.lipoName)) {
  throw new Error(`Speech helper is missing ${target.lipoName}`);
}
await fs.chmod(outputFile, 0o755);
console.log(`[electron] macOS speech helper built for ${target.lipoName} -> ${outputFile}`);
