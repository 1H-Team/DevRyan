import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleElectronMain } from '../../packages/electron/scripts/bundle-main.mjs';
import { captureQaArtifactIdentity, captureQaSourceIdentity } from './artifact-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const electronRoot = path.join(root, 'packages/electron');
const requireElectron = createRequire(path.join(electronRoot, 'package.json'));
const requireWeb = createRequire(path.join(root, 'packages/web/package.json'));
const requireBuilder = createRequire(requireElectron.resolve('electron-builder'));
const asar = requireBuilder('@electron/asar');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, target) => target.startsWith(`${parent.replace(/\/$/, '')}${path.sep}`);

// Explicit local QA build. Native modules are copied only after matching the
// existing local package's Electron version, architecture and npm versions.
// This avoids rebuilding binaries in the user's shared node_modules tree.
export async function packageQaElectron({ webDist, nativeSourceApp } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This local QA packager currently supports macOS arm64 only');
  if (!globalThis.Bun) throw new Error('Run the QA packager with the repository Bun runtime');
  const canonicalRoot = await realpath(root);
  const canonicalDist = await realpath(webDist);
  const nativeApp = await realpath(nativeSourceApp || path.join(electronRoot, 'dist/mac-arm64/DevRyan.app'));
  if (!inside(canonicalRoot, canonicalDist) || !inside(canonicalRoot, nativeApp)) throw new Error('QA inputs must stay inside the repository');
  const packageJson = JSON.parse(await readFile(path.join(electronRoot, 'package.json'), 'utf8'));
  const installedElectron = requireElectron('electron/package.json').version;
  const packagedElectron = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion',
    path.join(nativeApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist')], { encoding: 'utf8' }).trim();
  if (installedElectron !== packagedElectron) throw new Error('Native source app uses a different Electron version');
  const nativeResources = path.join(nativeApp, 'Contents/Resources');
  const nativeArchive = path.join(nativeResources, 'app.asar');
  const nativeArtifacts = [];
  for (const [name, files] of [['better-sqlite3', ['better_sqlite3.node']], ['node-pty', ['pty.node', 'spawn-helper']]]) {
    const installed = requireWeb(`${name}/package.json`).version;
    const packaged = JSON.parse(asar.extractFile(nativeArchive, `node_modules/${name}/package.json`).toString('utf8')).version;
    if (installed !== packaged) throw new Error(`Native source ${name} version differs from the candidate`);
    for (const file of files) {
      const relative = `node_modules/${name}/build/Release/${file}`;
      const source = path.join(nativeResources, 'app.asar.unpacked', relative);
      const kind = execFileSync('/usr/bin/file', ['-b', source], { encoding: 'utf8' }).trim();
      if (!kind.includes('arm64')) throw new Error(`Native source ${name}/${file} is not arm64`);
      nativeArtifacts.push({ name, version: installed, relative, source, sha256: sha256(await readFile(source)), kind });
    }
  }
  const outputRoot = path.join(root, '.cache/qa');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(path.join(outputRoot, 'packaged-electron-'));
  const staging = path.join(output, 'staging');
  const before = await captureQaSourceIdentity(root);
  const main = await bundleElectronMain({ outdir: path.join(staging, 'dist-bundle') });
  const web = await captureQaArtifactIdentity(canonicalDist);
  const { build, Platform, Arch } = requireElectron('electron-builder');
  const productName = 'DevRyan QA';
  const appPath = path.join(output, 'app/mac-arm64', `${productName}.app`);
  const afterPackPath = path.join(output, 'after-pack.cjs');
  await writeFile(afterPackPath, `const fs = require('node:fs/promises');\nconst path = require('node:path');\nmodule.exports = async context => {\n  const resources = path.join(context.appOutDir, ${JSON.stringify(`${productName}.app`)}, 'Contents/Resources');\n  for (const artifact of ${JSON.stringify(nativeArtifacts)}) {\n    await fs.copyFile(artifact.source, path.join(resources, 'app.asar.unpacked', artifact.relative));\n  }\n};\n`);
  const config = {
    ...packageJson.build,
    extends: null,
    productName,
    electronVersion: installedElectron,
    directories: { ...packageJson.build.directories, output: path.join(output, 'app') },
    files: [
      ...packageJson.build.files.filter(file => file !== 'dist-bundle/main.mjs'),
      { from: path.dirname(main), to: 'dist-bundle', filter: ['main.mjs'] },
      { from: path.join(root, 'scripts/qa'), to: '.', filter: ['packaged-host.mjs', 'packaged-host-policy.mjs', 'isolated-home.mjs'] },
    ],
    extraMetadata: { main: './packaged-host.mjs' },
    extraResources: packageJson.build.extraResources
      .filter(resource => ['web-dist', 'native'].includes(resource.to))
      .map(resource => resource.to === 'web-dist' ? { from: canonicalDist, to: 'web-dist' } : resource),
    extraFiles: [],
    mac: { ...packageJson.build.mac, target: ['dir'], identity: null, hardenedRuntime: false, notarize: false },
    publish: null,
    afterPack: afterPackPath,
  };
  // An explicit config file replaces package.json's build arrays. Passing an
  // object instead merges extraResources and can copy the stale normal UI too.
  const configPath = path.join(output, 'electron-builder.cjs');
  await writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`);
  await build({ projectDir: electronRoot, targets: Platform.MAC.createTarget('dir', Arch.arm64), config: configPath, publish: 'never' });
  const after = await captureQaSourceIdentity(root);
  if (before.sha256 !== after.sha256) throw new Error('Candidate source changed while Electron was packaging');
  const resources = path.join(appPath, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  const packagedMain = asar.extractFile(archive, 'dist-bundle/main.mjs');
  if (sha256(packagedMain) !== sha256(await readFile(main))) throw new Error('Packaged Electron main differs from the fresh bundle');
  const verifiedShellFiles = [];
  for (const [directory, files] of [
    [electronRoot, ['preload.mjs', 'origin-policy.mjs', 'browser-webview-policy.mjs', 'browser-cdp-bridge.mjs']],
    [path.join(root, 'scripts/qa'), ['packaged-host.mjs', 'packaged-host-policy.mjs', 'isolated-home.mjs']],
  ]) {
    for (const file of files) {
      const sourceHash = sha256(await readFile(path.join(directory, file)));
      if (sha256(asar.extractFile(archive, file)) !== sourceHash) throw new Error(`Packaged shell file differs from source: ${file}`);
      verifiedShellFiles.push({ file: path.relative(root, path.join(directory, file)), sha256: sourceHash });
    }
  }
  const verifiedWorkspaceFiles = [];
  const workspaceMappings = [
    ['node_modules/@openchamber/web/server/', 'packages/web/server/'],
    ['node_modules/@openchamber/shared-runtime/', 'packages/shared-runtime/'],
    ['node_modules/@openchamber/harness-runtime/', 'packages/harness-runtime/'],
    ['node_modules/@openchamber/orchestration-runtime/', 'packages/orchestration-runtime/'],
    ['node_modules/@openchamber/bot-egress/', 'packages/bot-egress/'],
  ];
  for (const entry of asar.listPackage(archive).map(file => file.replace(/^\//, ''))) {
    const mapping = workspaceMappings.find(([prefix]) => entry.startsWith(prefix));
    if (!mapping || typeof asar.statFile(archive, entry).size !== 'number') continue;
    const file = mapping[1] + entry.slice(mapping[0].length);
    const sourceHash = sha256(await readFile(path.join(root, file)));
    if (sha256(asar.extractFile(archive, entry)) !== sourceHash) throw new Error(`Packaged workspace file differs from source: ${file}`);
    verifiedWorkspaceFiles.push({ file, sha256: sourceHash });
  }
  if (!verifiedWorkspaceFiles.some(entry => entry.file === 'packages/web/server/index.js')) throw new Error('Packaged server source was not verified');
  const packagedWeb = await captureQaArtifactIdentity(path.join(resources, 'web-dist'));
  if (web.sha256 !== packagedWeb.sha256) throw new Error('Packaged UI differs from the candidate web artifact');
  for (const artifact of nativeArtifacts) {
    if (sha256(await readFile(path.join(resources, 'app.asar.unpacked', artifact.relative))) !== artifact.sha256) throw new Error('Packaged native binary differs from the verified local source');
  }
  const binary = path.join(appPath, 'Contents/MacOS', productName);
  const nativeSmoke = JSON.parse(execFileSync(binary, ['--input-type=commonjs', '--eval', `
    const load = require('node:module').createRequire(process.argv[1] + '/package.json');
    const Database = load('better-sqlite3');
    const db = new Database(':memory:');
    if (db.prepare('select 1 as value').get().value !== 1) throw Error('SQLite native smoke failed');
    db.close();
    const terminal = load('node-pty').spawn('/bin/sh', ['-c', 'exit 0'], { env: process.env });
    const timer = setTimeout(() => process.exit(1), 5000);
    terminal.onExit(({exitCode}) => { clearTimeout(timer); if (exitCode !== 0) process.exit(1);
      console.log(JSON.stringify({ electron: process.versions.electron, nodeModuleAbi: process.versions.modules, sqlite: 'passed', pty: 'passed' })); });
  `, archive], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 }));
  const evidence = { schemaVersion: 1, purpose: 'actual packaged Electron Coding Agents QA with isolated test bootstrap',
    output, binary, appPath, electronVersion: installedElectron, platform: process.platform, arch: process.arch,
    source: before, webArtifact: web, packagedWebArtifact: packagedWeb, verifiedShellFiles, verifiedWorkspaceFiles,
    mainSha256: sha256(packagedMain), preloadSha256: sha256(asar.extractFile(archive, 'preload.mjs')),
    archiveSha256: sha256(await readFile(archive)), bootstrapSha256: sha256(asar.extractFile(archive, 'packaged-host.mjs')),
    bootstrapPolicySha256: sha256(asar.extractFile(archive, 'packaged-host-policy.mjs')),
    packagerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    nativeSourceApp: nativeApp, nativeArtifacts, nativeSmoke,
    signing: 'disabled', publication: 'disabled', nativeRebuild: 'not-run; matched local packaged binaries copied into owned output',
    excludedAcceptance: ['signing/notarization', 'updater installation', 'global protocol registration', 'OS keychain integration', 'background Bot service', 'legacy Tauri'] };
  await writeFile(path.join(output, 'package-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await packageQaElectron({ webDist: process.env.DEVRYAN_QA_DIST_DIR });
  console.log(JSON.stringify({ binary: evidence.binary, evidence: path.join(evidence.output, 'package-evidence.json') }));
}
