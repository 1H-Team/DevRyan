#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const fixtureDirectory = path.join(repositoryRoot, 'tests/visual-production-bots');
const outputDirectory = path.join(repositoryRoot, '.cache/e2e/production-bots-visual-shell');
const configPath = path.join(fixtureDirectory, 'electron-builder.cjs');
const requireElectronBuilder = createRequire(path.join(repositoryRoot, 'packages/electron/package.json'));
const electronBuilderCli = requireElectronBuilder.resolve('electron-builder/cli.js');
const productName = 'DevRyan Production Bots Visual Fixture';

export const packagedVisualShellCandidates = ({
  platform = process.platform,
  arch = process.arch,
  root = outputDirectory,
} = {}) => {
  if (platform === 'darwin') {
    const directories = arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-x64'];
    return directories.map((directory) => path.join(
      root,
      directory,
      `${productName}.app`,
      'Contents/MacOS',
      productName,
    ));
  }
  if (platform === 'win32') {
    return [path.join(root, 'win-unpacked', `${productName}.exe`)];
  }
  const directories = arch === 'arm64' ? ['linux-arm64-unpacked', 'linux-unpacked'] : ['linux-unpacked'];
  return directories.map((directory) => path.join(root, directory, productName));
};

const firstExecutable = async (candidates) => {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
};

export const resolvePackagedVisualShellBinary = async (options = {}) => {
  const candidates = packagedVisualShellCandidates(options);
  const binary = await firstExecutable(candidates);
  if (binary) return binary;
  throw new Error(
    `Packaged Production Bots visual shell is missing; run \`bun run visual:bots:package-shell\`. Checked: ${candidates.join(', ')}`,
  );
};

const runBuilder = (projectDirectory) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    electronBuilderCli,
    '--projectDir', projectDirectory,
    '--config', configPath,
    '--dir',
    '--publish', 'never',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`electron-builder exited with ${signal || code || 'unknown status'}`));
  });
});

export const packageProductionBotsVisualShell = async () => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'devryan-production-bots-visual-shell-'));
  try {
    await copyFile(
      path.join(fixtureDirectory, 'electron-shell.cjs'),
      path.join(stagingDirectory, 'electron-shell.cjs'),
    );
    await writeFile(path.join(stagingDirectory, 'package.json'), `${JSON.stringify({
      name: 'devryan-production-bots-visual-fixture',
      version: '0.0.0',
      description: 'Test-only packaged Electron shell for Production Bots visual verification',
      author: 'DevRyan',
      private: true,
      main: 'electron-shell.cjs',
    }, null, 2)}\n`);
    await runBuilder(stagingDirectory);
    const binary = await resolvePackagedVisualShellBinary();
    await writeFile(path.join(outputDirectory, 'package-evidence.json'), `${JSON.stringify({
      schemaVersion: 1,
      purpose: 'test-only Production Bots visual fixture shell',
      electronVersion: '41.2.1',
      platform: process.platform,
      arch: process.arch,
      binary: path.relative(repositoryRoot, binary),
      productionBundle: false,
    }, null, 2)}\n`);
    process.stdout.write(`[production-bots-visual] packaged shell ${binary}\n`);
    return binary;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  packageProductionBotsVisualShell().catch((error) => {
    console.error('[production-bots-visual] package FAIL', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
