import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { WINDOWS_PREVIEW_VERSION, WINDOWS_PREVIEW_NAME, WINDOWS_PREVIEW_APP_ID, WINDOWS_PREVIEW_GUID } from '../packages/electron/windows-preview.mjs';
import { WINDOWS_PREVIEW_OPENCODE_PINS, verifyPreviewExecutable } from './windows-preview-opencode.mjs';

const repository = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const electronRoot = path.join(repository, 'packages/electron');
export function windowsPreviewBuilderConfig({ base, opencodeDirectory, outputDirectory, sessionSmoke }) {
  return { ...base, appId: WINDOWS_PREVIEW_APP_ID, productName: WINDOWS_PREVIEW_NAME, executableName: WINDOWS_PREVIEW_NAME,
    extraMetadata: { version: WINDOWS_PREVIEW_VERSION, main: './dist-bundle/windows-preview-entry.mjs', devryanRuntimeMode: 'standard-preview' },
    directories: { ...base.directories, output: outputDirectory },
    files: [...base.files, 'dist-bundle/windows-preview-entry.mjs', 'dist-bundle/windows-preview.mjs'],
    extraResources: [{ from: 'resources/web-dist', to: 'web-dist' }, { from: opencodeDirectory, to: 'opencode', filter: ['opencode.exe', 'opencode.json'] },
      { from: sessionSmoke, to: 'windows-preview-session-smoke.mjs' }],
    afterPack: undefined, publish: null, npmRebuild: false,
    win: { appId: WINDOWS_PREVIEW_APP_ID, target: ['nsis'], artifactName: 'DevRyan-${version}-win-${arch}.exe',
      signExecutable: false, verifyUpdateCodeSignature: true, extraResources: [] },
    nsis: { guid: WINDOWS_PREVIEW_GUID, oneClick: true, perMachine: false, allowElevation: false,
      runAfterFinish: false, deleteAppDataOnUninstall: false, artifactName: 'DevRyan-${version}-win-${arch}.exe' },
  };
}
export async function packageWindowsPreview({ arch, execute = (command, args, options) => spawnSync(command, args, options) }) {
  if (process.platform !== 'win32' || process.arch !== arch || !Object.hasOwn(WINDOWS_PREVIEW_OPENCODE_PINS, arch)) throw new Error('windows_preview_native_host_required');
  const directory = path.join(repository, '.cache/windows-preview', arch);
  const stock = path.join(directory, 'opencode');
  const receipt = JSON.parse(await fs.readFile(path.join(stock, 'opencode.json'), 'utf8'));
  const actual = await verifyPreviewExecutable(path.join(stock, 'opencode.exe'), arch);
  const pin = WINDOWS_PREVIEW_OPENCODE_PINS[arch];
  if (receipt.version !== '2.0.20' || receipt.package !== pin.package || receipt.integrity !== pin.integrity
    || receipt.sha256 !== actual.sha256 || receipt.size !== actual.size || receipt.arch !== arch) throw new Error('windows_preview_stock_unverified');
  const manifest = JSON.parse(await fs.readFile(path.join(electronRoot, 'package.json'), 'utf8'));
  const config = windowsPreviewBuilderConfig({ base: manifest.build, opencodeDirectory: stock,
    outputDirectory: path.join(directory, 'package'), sessionSmoke: path.join(repository, 'scripts/windows-preview-session-smoke.mjs') });
  const configFile = path.join(directory, 'electron-builder.json');
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
  const require = createRequire(path.join(electronRoot, 'package.json'));
  const result = execute(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', '--' + arch, '--publish', 'never', '--config', configFile],
    { cwd: electronRoot, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('windows_preview_packaging_failed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: package-windows-preview.mjs x64|arm64');
  await packageWindowsPreview({ arch: process.argv[2] });
}
