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
const requireDeveloperId = process.argv.includes('--require-developer-id');
const packageManifest = JSON.parse(fs.readFileSync(path.join(electronDirectory, 'package.json'), 'utf8'));

const run = (command, args, { output = false, allowedStatuses = [0] } = {}) => {
  const result = spawnSync(command, args, output ? { encoding: 'utf8' } : { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
};

const teamIdentifier = (result) => (
  /TeamIdentifier=([^\r\n]+)/.exec(`${result.stdout || ''}\n${result.stderr || ''}`)?.[1]?.trim() || null
);

const verifyApp = (candidateAppPath, label) => {
  if (!fs.statSync(candidateAppPath).isDirectory()) throw new Error(`${label} app is missing: ${candidateAppPath}`);
  const bridgePath = path.join(
    candidateAppPath,
    'Contents',
    'Resources',
    'native',
    'DevRyanRuntimeServiceControl.node',
  );
  const plistPath = path.join(
    candidateAppPath,
    'Contents',
    'Library',
    'LaunchAgents',
    'dev.openchamber.desktop.runtime-service.plist',
  );
  if (!fs.statSync(bridgePath).isFile()) throw new Error(`${label} native bridge is missing: ${bridgePath}`);
  if (!fs.statSync(plistPath).isFile()) throw new Error(`${label} LaunchAgent is missing: ${plistPath}`);
  if ((fs.statSync(bridgePath).mode & 0o111) === 0) {
    throw new Error(`${label} native bridge is not executable: ${bridgePath}`);
  }

  const lipo = run('/usr/bin/lipo', ['-archs', bridgePath], { output: true });
  const architectures = lipo.stdout.trim().split(/\s+/).filter(Boolean);
  if (!architectures.includes(expectedArchitecture)) {
    throw new Error(
      `${label} native bridge is missing ${expectedArchitecture}; found ${architectures.join(', ') || 'none'}`,
    );
  }
  run('/usr/bin/plutil', ['-lint', plistPath]);
  const plistResult = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { output: true });
  const plist = JSON.parse(plistResult.stdout);
  if (plist.Label !== 'dev.openchamber.desktop.runtime-service'
    || plist.BundleProgram !== 'Contents/MacOS/DevRyan'
    || !Array.isArray(plist.ProgramArguments)
    || plist.ProgramArguments[0] !== 'DevRyan'
    || plist.ProgramArguments[1] !== '--runtime-service') {
    throw new Error(`${label} LaunchAgent contract is invalid`);
  }

  run('/usr/bin/codesign', ['--verify', '--strict', bridgePath]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidateAppPath]);
  const appSignature = run('/usr/bin/codesign', ['-dv', '--verbose=4', candidateAppPath], { output: true });
  const bridgeSignature = run('/usr/bin/codesign', ['-dv', '--verbose=4', bridgePath], { output: true });
  const appTeam = teamIdentifier(appSignature);
  const bridgeTeam = teamIdentifier(bridgeSignature);
  if (appTeam !== bridgeTeam) {
    throw new Error(`${label} native bridge TeamIdentifier ${bridgeTeam || 'missing'} does not match ${appTeam || 'missing'}`);
  }
  const signatureText = `${appSignature.stdout || ''}\n${appSignature.stderr || ''}`;
  if (requireDeveloperId && (!appTeam || /Signature=adhoc/.test(signatureText))) {
    throw new Error(`${label} must be signed with a Developer ID identity`);
  }

  const executable = path.join(candidateAppPath, 'Contents', 'MacOS', 'DevRyan');
  if ((fs.statSync(executable).mode & 0o111) === 0) {
    throw new Error(`${label} DevRyan executable is not executable: ${executable}`);
  }
  const probe = run(executable, ['--runtime-service-control=status'], {
    output: true,
    allowedStatuses: [0],
  });
  const output = `${probe.stdout || ''}`.trim().split(/\r?\n/).at(-1) || '';
  const status = JSON.parse(output);
  if (status?.ok !== true
    || status?.state === 'unavailable'
    || status?.state === 'not_found') {
    throw new Error(`${label} runtime-service probe failed: ${output || '(empty)'}`);
  }
};

verifyApp(appPath, 'unpacked');

const artifactPrefix = `DevRyan-${packageManifest.version}-${requestedArchitecture}`;
const zipPath = path.join(electronDirectory, 'dist', `${artifactPrefix}.zip`);
const dmgPath = path.join(electronDirectory, 'dist', `${artifactPrefix}.dmg`);
if (!fs.statSync(zipPath).isFile()) throw new Error(`Runtime-service ZIP is missing: ${zipPath}`);
if (!fs.statSync(dmgPath).isFile()) throw new Error(`Runtime-service DMG is missing: ${dmgPath}`);

const temporaryRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'devryan-runtime-package-'));
try {
  const zipRoot = path.join(temporaryRoot, 'zip');
  fs.mkdirSync(zipRoot);
  run('/usr/bin/ditto', ['-x', '-k', zipPath, zipRoot]);
  verifyApp(path.join(zipRoot, 'DevRyan.app'), 'ZIP');

  const mountPoint = path.join(temporaryRoot, 'dmg');
  fs.mkdirSync(mountPoint);
  run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
  try {
    verifyApp(path.join(mountPoint, 'DevRyan.app'), 'DMG');
  } finally {
    run('/usr/bin/hdiutil', ['detach', mountPoint]);
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `[electron] verified packaged runtime service archives (${expectedArchitecture}) -> ${artifactPrefix}`,
);
