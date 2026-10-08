import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseWindowsPreviewVersion, windowsPreviewAssetName, verifyWindowsPreviewAssetNames,
  verifyWindowsPreviewEvidence, sha256File } from './windows-preview-release.mjs';
import { assertPreviewPeArchitecture, stageWindowsPreviewOpencode, WINDOWS_PREVIEW_OPENCODE_PINS } from './windows-preview-opencode.mjs';
import { windowsPreviewBuilderConfig, windowsPreviewPackagingEnvironment } from './package-windows-preview.mjs';
import { readPreviewSigning, waitForPreviewExecutable, waitForPreviewRemoval } from './windows-preview-installer-smoke.mjs';
import { WINDOWS_PREVIEW_VERSION, WINDOWS_PREVIEW_GUID } from '../packages/electron/windows-preview.mjs';

test('preview release version and exact two branded assets are distinct from stable', () => {
  assert.equal(parseWindowsPreviewVersion(WINDOWS_PREVIEW_VERSION), '2.0.3-windows-preview.1');
  for (const value of ['2.0.2', 'v2.0.3-windows-preview.1', '2.0.3-windows-preview.0', '2.0.3-windows-preview.1/latest']) assert.throws(() => parseWindowsPreviewVersion(value));
  const names = ['x64', 'arm64'].map(arch => windowsPreviewAssetName(arch));
  assert.deepEqual(verifyWindowsPreviewAssetNames(names), names);
  for (const invalid of [names.slice(0, 1), [...names, 'latest.yml'], [names[0], names[0]],
    ['OpenChamber-2.0.3-windows-preview.1-win-x64.exe', names[1]], [windowsPreviewAssetName('x64', '2.0.4-windows-preview.1'), names[1]]]) {
    assert.throws(() => verifyWindowsPreviewAssetNames(invalid));
  }
});

test('actual PE architecture refuses swapped, truncated and non-PE official payloads', () => {
  const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(0x20b, 152);
  assert.doesNotThrow(() => assertPreviewPeArchitecture(bytes, 'x64'));
  assert.throws(() => assertPreviewPeArchitecture(bytes, 'arm64'));
  bytes.writeUInt16LE(0xaa64, 132);
  assert.doesNotThrow(() => assertPreviewPeArchitecture(bytes, 'arm64'));
  for (const bad of [bytes.subarray(0, 150), Buffer.alloc(512)]) assert.throws(() => assertPreviewPeArchitecture(bad, 'arm64'));
  bytes.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => assertPreviewPeArchitecture(bytes, 'arm64'));
});

test('download integrity is enforced before archive extraction', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-stock-'));
  try {
    let request;
    await assert.rejects(stageWindowsPreviewOpencode({ directory, arch: 'x64', fetchImpl: async (url, options) => {
      request = { url, options }; return new Response('tampered archive');
    } }), /windows_preview_archive_integrity_failed/);
    assert.match(request.url, /cli-windows-x64-2\.0\.20\.tgz$/);
    assert.equal(request.options.redirect, 'error');
    assert.deepEqual(await fs.readdir(directory), []);
    assert.notEqual(WINDOWS_PREVIEW_OPENCODE_PINS.x64.integrity, WINDOWS_PREVIEW_OPENCODE_PINS.arm64.integrity);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('builder uses separate identity, stock resources and per-user NSIS without stable native inputs', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../packages/electron/package.json', import.meta.url), 'utf8'));
  const stableVersion = manifest.version;
  const config = windowsPreviewBuilderConfig({ base: manifest.build, opencodeDirectory: '/fixture/stock', outputDirectory: '/fixture/output', sessionSmoke: '/fixture/smoke.mjs' });
  assert.notEqual(config.appId, manifest.build.win.appId);
  assert.notEqual(config.nsis.guid, manifest.build.nsis.guid);
  assert.equal(config.nsis.guid, WINDOWS_PREVIEW_GUID);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.extraMetadata.main, './dist-bundle/windows-preview-entry.mjs');
  assert.equal(config.extraMetadata.version, WINDOWS_PREVIEW_VERSION);
  assert.deepEqual(config.win.extraResources, []);
  assert.deepEqual(config.extraResources.map(resource => resource.to), ['web-dist', 'opencode', 'windows-preview-session-smoke.mjs']);
  assert.equal(config.publish, null);
  assert.equal(manifest.version, stableVersion);
  assert.match(manifest.build.win.extraResources[0].to, /revert-runtime/);
});

test('preview packaging overrides automatic executable filters with NSIS-decodable BCJ', () => {
  const inherited = { ELECTRON_BUILDER_7Z_FILTER: 'ARM', CSC_IDENTITY_AUTO_DISCOVERY: 'true', PATH: '/fixture/path' };
  const environment = windowsPreviewPackagingEnvironment(inherited);
  assert.equal(environment.ELECTRON_BUILDER_7Z_FILTER, 'BCJ');
  assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(environment.PATH, inherited.PATH);
  assert.equal(inherited.ELECTRON_BUILDER_7Z_FILTER, 'ARM');
  const require = createRequire(new URL('../packages/electron/package.json', import.meta.url));
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { compute7zCompressArgs } = builderRequire('app-builder-lib/out/targets/archive.js');
  const previous = process.env.ELECTRON_BUILDER_7Z_FILTER;
  try {
    process.env.ELECTRON_BUILDER_7Z_FILTER = environment.ELECTRON_BUILDER_7Z_FILTER;
    const args = compute7zCompressArgs('7z', { compression: 'normal' });
    assert.ok(args.includes('-mf=BCJ'), 'the installed builder must actually pin its NSIS archive filter');
    assert.equal(args.filter(argument => argument.startsWith('-mf=')).length, 1);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_BUILDER_7Z_FILTER;
    else process.env.ELECTRON_BUILDER_7Z_FILTER = previous;
  }
});

test('preview evidence binds source and installer bytes and both functional app launches', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-evidence-'));
  try {
    const installer = path.join(directory, windowsPreviewAssetName('x64'));
    await fs.writeFile(installer, 'installer-fixture');
    const evidence = path.join(directory, 'evidence.json');
    const sourceSha = 'a'.repeat(40);
    const launch = { appVersion: WINDOWS_PREVIEW_VERSION, arch: 'x64', runtimeMode: 'standard-preview',
      opencodeVersion: '2.0.20', ordinaryUserPermissions: true, renderer: { body: true, bridge: true }, functional: { status: 'passed', phase: 'initial', runtimeMode: 'standard-preview',
        scenarios: ['authenticated-runtime-readiness', 'runtime-restart', 'project-file-read-write', 'file-traversal-refused', 'provider-api-key-setup', 'api-key-authenticated-provider-request', 'chat-completion', 'sse-text', 'session-history', 'active-chat-abort', 'unsupported-routes-refused'] } };
    const receipt = { schema: 1, status: 'passed', arch: 'x64', sourceSha, appVersion: WINDOWS_PREVIEW_VERSION,
      installer: { name: path.basename(installer), size: (await fs.stat(installer)).size, sha256: await sha256File(installer), signing: { status: 'NotSigned' } },
      installedExecutable: { size: 2000000, arch: 'x64', sha256: 'b'.repeat(64), signing: { status: 'NotSigned' } },
      opencode: { version: '2.0.20', arch: 'x64', ...WINDOWS_PREVIEW_OPENCODE_PINS.x64, size: 2000000, sha256: 'c'.repeat(64), archiveURL: 'https://registry.npmjs.org/@opencode/cli-windows-x64/-/cli-windows-x64-2.0.20.tgz' }, install: 'passed', uninstall: 'passed', launch, restart: structuredClone(launch) };
    receipt.restart.functional = { status: 'passed', phase: 'restart', runtimeMode: 'standard-preview', scenarios: ['authenticated-runtime-readiness', 'history-after-application-restart', 'files-after-application-restart'] };
    const verify = async value => { await fs.writeFile(evidence, JSON.stringify(value)); return verifyWindowsPreviewEvidence({ installer, evidence, arch: 'x64', sourceSha }); };
    await verify(receipt);
    await assert.rejects(verify({ ...receipt, opencode: { ...receipt.opencode, integrity: 'sha512-tampered' } }));
    await assert.rejects(verify({ ...receipt, launch: { ...launch, functional: { ...launch.functional, scenarios: [] } } }));
    await assert.rejects(verify({ ...receipt, sourceSha: 'b'.repeat(40) }));
    await assert.rejects(verify({ ...receipt, restart: { ...launch, functional: { status: 'failed' } } }));
    await assert.rejects(verify({ ...receipt, installer: { ...receipt.installer, signing: { status: 'HashMismatch' } } }));
    await fs.writeFile(installer, 'changed-installer');
    await assert.rejects(verify(receipt));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('preview workflow runs architecture-native packaging and installer checks before artifact upload', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/windows-preview.yml', import.meta.url), 'utf8');
  for (const pattern of [/windows-2022[\s\S]*arch: x64/, /windows-11-arm[\s\S]*arch: arm64/, /branches: \[fix\/windows-release\]/,
    /workflow_dispatch:/, /contents: read/, /windows-preview-installer-smoke.mjs/, /--publish.*never|package-windows-preview.mjs/]) assert.match(workflow, pattern);
  assert.ok(workflow.indexOf('Install, launch, exercise sessions') < workflow.indexOf('actions/upload-artifact'));
  assert.doesNotMatch(workflow, /pull_request:|contents: write|gh release|windows-native|supervisor_acceptance/);
});

test('signing probe records bounded command-only diagnostics and still rejects invalid signatures', async () => {
  const file = '/fixture/DevRyan-preview.exe';
  const read = value => readPreviewSigning(file, async (command, args, options) => {
    assert.equal(command, 'pwsh.exe');
    assert.equal(options.env.DEVRYAN_SIGNING_TARGET, file);
    assert.equal(options.timeout, 30000);
    assert.ok(args.includes('-NonInteractive'));
    assert.match(args.at(-1), /\$thumbprint=\$null; if\(\$s.SignerCertificate\)/);
    assert.doesNotMatch(args.at(-1), /thumbprint=if/);
    return { stdout: JSON.stringify(value), stderr: '' };
  });
  assert.deepEqual(await read({ status: 'NotSigned', thumbprint: null }), { status: 'NotSigned', thumbprint: null });
  await assert.rejects(read({ status: 'HashMismatch', thumbprint: null }), /windows_preview_signing_invalid/);
  await assert.rejects(readPreviewSigning(file, async () => { throw Object.assign(new Error('fixed signing probe failed'),
    { code: 1, stdout: '', stderr: 'x'.repeat(5000) }); }), error => {
    assert.equal(error.message, 'windows_preview_signing_probe_failed');
    assert.equal(error.signingProbe.code, 1);
    assert.equal(error.signingProbe.stderr.length, 4096);
    return true;
  });
});

test('installer completion waits for the exact executable and refuses missing or invalid output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-install-'));
  try {
    const executable = path.join(directory, 'DevRyan Windows Preview.exe');
    let completed = false;
    const completion = waitForPreviewExecutable(executable, { timeout: 1000, pollInterval: 5 }).then(() => { completed = true; });
    await fs.writeFile(path.join(directory, 'Uninstall DevRyan Windows Preview.exe'), 'uninstaller');
    await assert.rejects(waitForPreviewExecutable(path.join(directory, 'missing.exe'), { timeout: 20, pollInterval: 5 }),
      /windows_preview_installed_executable_timeout/);
    assert.equal(completed, false, 'an uninstaller alone cannot establish installation completion');
    await fs.writeFile(executable, 'actual-output');
    await completion;
    await fs.mkdir(path.join(directory, 'invalid.exe'));
    await assert.rejects(waitForPreviewExecutable(path.join(directory, 'invalid.exe')), /windows_preview_installed_executable_invalid/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('uninstall waits through delete-pending access errors and accepts only verified absence', async () => {
  const executable = '/fixture/DevRyan Windows Preview.exe';
  const states = ['EPERM', 'EACCES', 'present', 'ENOENT'];
  await waitForPreviewRemoval(executable, { timeout: 1000, pollInterval: 1, inspect: async file => {
    assert.equal(file, executable);
    const state = states.shift();
    if (state !== 'present') throw Object.assign(new Error('fixture'), { code: state });
    return {};
  } });
  assert.deepEqual(states, []);
  await assert.rejects(waitForPreviewRemoval(executable, { timeout: 20, pollInterval: 5,
    inspect: async () => { throw Object.assign(new Error('fixture'), { code: 'EPERM' }); } }),
    error => error.message === 'windows_preview_uninstall_failed' && error.code === 'EPERM');
  await assert.rejects(waitForPreviewRemoval(executable, { timeout: 20, pollInterval: 5, inspect: async () => ({}) }),
    /windows_preview_uninstall_failed/);
  await assert.rejects(waitForPreviewRemoval(executable, { inspect: async () => {
    throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
  } }), error => error.code === 'EIO');
});
