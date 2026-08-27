#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const electronDirectory = path.resolve(scriptDirectory, '..');
const architectureNames = Object.freeze({
  arm64: 'arm64',
  x64: 'x86_64',
});

const readArgument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const requestedArchitecture = readArgument('--arch')
  || process.env.ELECTRON_BUILDER_ARCH?.trim()
  || process.arch;
const expectedArchitecture = architectureNames[requestedArchitecture];
if (!expectedArchitecture) {
  throw new Error(`Unsupported packaged runtime-service architecture: ${requestedArchitecture}`);
}

const defaultAppDirectory = requestedArchitecture === 'arm64' ? 'mac-arm64' : 'mac';
const appPath = path.resolve(
  readArgument('--app')
    || path.join(electronDirectory, 'dist', defaultAppDirectory, 'DevRyan.app'),
);
const helperPath = path.join(
  appPath,
  'Contents',
  'Resources',
  'native',
  'DevRyanRuntimeServiceControl',
);
const plistPath = path.join(
  appPath,
  'Contents',
  'Library',
  'LaunchAgents',
  'dev.openchamber.desktop.runtime-service.plist',
);

const run = (command, args, { output = false } = {}) => {
  const result = spawnSync(command, args, output ? { encoding: 'utf8' } : { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
};

if (!fs.statSync(appPath).isDirectory()) throw new Error(`Packaged app is missing: ${appPath}`);
if (!fs.statSync(helperPath).isFile()) throw new Error(`Runtime-service helper is missing: ${helperPath}`);
fs.accessSync(helperPath, fs.constants.X_OK);
if (!fs.statSync(plistPath).isFile()) throw new Error(`Runtime-service LaunchAgent is missing: ${plistPath}`);

const lipo = run('/usr/bin/lipo', ['-archs', helperPath], { output: true });
const architectures = lipo.stdout.trim().split(/\s+/).filter(Boolean);
if (!architectures.includes(expectedArchitecture)) {
  throw new Error(
    `Runtime-service helper is missing ${expectedArchitecture}; found ${architectures.join(', ') || 'none'}`,
  );
}

run('/usr/bin/plutil', ['-lint', plistPath]);
const plistResult = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { output: true });
const plist = JSON.parse(plistResult.stdout);
if (plist.Label !== 'dev.openchamber.desktop.runtime-service') {
  throw new Error('Runtime-service LaunchAgent label is invalid');
}
if (plist.BundleProgram !== 'Contents/MacOS/DevRyan') {
  throw new Error('Runtime-service LaunchAgent BundleProgram is invalid');
}
if (!Array.isArray(plist.ProgramArguments)
  || plist.ProgramArguments[0] !== 'DevRyan'
  || plist.ProgramArguments[1] !== '--runtime-service') {
  throw new Error('Runtime-service LaunchAgent arguments are invalid');
}

run('/usr/bin/codesign', ['--verify', '--strict', helperPath]);
const appSignature = run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { output: true });
const helperSignature = run('/usr/bin/codesign', ['-dv', '--verbose=4', helperPath], { output: true });
const teamIdentifier = (result) => (
  /TeamIdentifier=([^\r\n]+)/.exec(`${result.stdout || ''}\n${result.stderr || ''}`)?.[1]?.trim() || null
);
const appTeam = teamIdentifier(appSignature);
const helperTeam = teamIdentifier(helperSignature);
if (appTeam && appTeam !== helperTeam) {
  throw new Error(`Runtime-service helper TeamIdentifier ${helperTeam || 'missing'} does not match ${appTeam}`);
}

console.log(
  `[electron] verified packaged runtime service (${expectedArchitecture}) -> ${appPath}`,
);
