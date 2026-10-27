import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { readUpdateIntent, mutateUpdateIntent, runDesktopUpdateInstall, processStart } = await import(process.env.DEVRYAN_TEST_UPDATE_INSTALLER
  ? pathToFileURL(process.env.DEVRYAN_TEST_UPDATE_INSTALLER).href : '../desktop-update-install.mjs');

export { readUpdateIntent, mutateUpdateIntent, runDesktopUpdateInstall, processStart };

export const sha256 = 'a'.repeat(64);
export const fixture = async action => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-install-')));
  await fs.chmod(root, 0o700);
  try {
    const nonce = randomUUID(), target = path.join(root, 'DevRyan.app'), stage = path.join(root, `.DevRyan-update-${nonce}`);
    await fs.mkdir(target);await fs.writeFile(path.join(target, 'version'), '2.0.1');
    await fs.mkdir(stage, { mode: 0o700 });await fs.mkdir(path.join(stage, 'candidate.app'));
    await fs.writeFile(path.join(stage, 'candidate.app/version'), '2.0.2');
    const previous = await fs.lstat(target), stageStat = await fs.lstat(stage), intentPath = path.join(root, 'intent.json');
    const intent = { protocol: 'devryan.desktop-update/1', nonce, phase: 'prepared', target, stage,
      candidate: path.join(stage, 'candidate.app'), backup: path.join(stage, 'previous.app'), failed: path.join(stage, 'failed.app'),
      stageIdentity: { dev: stageStat.dev, ino: stageStat.ino }, previous: { version: '2.0.1', dev: previous.dev, ino: previous.ino },
      version: '2.0.2', arch: 'arm64', signing: { mode: 'adhoc', identifier: 'dev.openchamber.desktop', cdhash: 'a'.repeat(40) },
      candidateSigning: { mode: 'adhoc', identifier: 'dev.openchamber.desktop', cdhash: 'b'.repeat(40) },
      sha256, manifestSha256: sha256, bridgeSha256: sha256, installerSha256: sha256, ownerPID: 123456, ownerStart: 'fixture-owner' };
    await fs.writeFile(intentPath, JSON.stringify(intent), { mode: 0o600 });
    const roots = [root], mutate = (allowed, patch) => mutateUpdateIntent(intentPath, nonce, allowed, patch, roots);
    const verifyBundle = async (bundle, { version }) => {
      assert.equal(await fs.readFile(path.join(bundle, 'version'), 'utf8'), version);return { manifestSha256: sha256, signing: version === '2.0.1' ? intent.signing : intent.candidateSigning };
    };
    // Tests the state machine's exclusive-rename contract; the compiled native
    // bridge is qualified separately on macOS, never replaced by this fixture.
    const renameExclusive = process.env.DEVRYAN_TEST_UPDATE_BRIDGE
      ? createRequire(import.meta.url)(process.env.DEVRYAN_TEST_UPDATE_BRIDGE).renameExclusive : async (from, to) => {
      const exists = await fs.lstat(to).then(() => true, error => { if (error.code === 'ENOENT') return false;throw error; });
      if (exists) throw Object.assign(new Error('target exists'), { code: 'update_target_exists' });
      await fs.rename(from, to);
    };
    const swapApplications = process.env.DEVRYAN_TEST_UPDATE_BRIDGE
      ? createRequire(import.meta.url)(process.env.DEVRYAN_TEST_UPDATE_BRIDGE).swapApplications : async (from, to) => {
        const temporary = path.join(root, `swap-${randomUUID()}`);
        await fs.rename(from, temporary);await fs.rename(to, from);await fs.rename(temporary, to);
      };
    await action({ root, intentPath, intent, roots, mutate, verifyBundle, renameExclusive, swapApplications,
      options: { roots, verifyBundle, renameExclusive, swapApplications, ownerExited: async () => true, startupTimeoutMs: 1 } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
};

// Signature tool replies are synthetic in startup state tests; only the killed
// helper tests above use the actual compiled exchange bridge.
export const startupFixture = async f => {
  const manifest = JSON.stringify({ schema: 1, buildId: sha256, target: 'bun-darwin-arm64' });
  for (const bundle of [f.intent.target, f.intent.candidate]) {
    const runtime = path.join(bundle, 'Contents/Resources/revert-runtime/darwin-arm64');
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, 'native-bundle.json'), manifest);
  }
  const identity = await fs.lstat(f.intent.candidate);
  await f.swapApplications(f.intent.candidate, f.intent.target);await f.renameExclusive(f.intent.candidate, f.intent.backup);
  await f.mutate(['prepared'], { phase: 'launching', helperPID: process.pid, helperStart: await processStart(process.pid),
    candidateIdentity: { dev: identity.dev, ino: identity.ino }, manifestSha256: createHash('sha256').update(manifest).digest('hex') });
  const run = async (file, args) => {
    if (file === '/usr/bin/plutil') {
      if (args.at(-1).endsWith('/Info.plist')) {
        const bundle = path.dirname(path.dirname(args.at(-1)));
        return { stdout: JSON.stringify({ CFBundleIdentifier: 'dev.openchamber.desktop', CFBundleExecutable: 'DevRyan',
          CFBundleShortVersionString: await fs.readFile(path.join(bundle, 'version'), 'utf8') }) };
      }
      return { stdout: JSON.stringify({ Label: 'dev.openchamber.desktop.runtime-service', BundleProgram: 'Contents/MacOS/DevRyan',
        ProgramArguments: ['DevRyan', '--runtime-service'] }) };
    }
    if (file === '/usr/bin/lipo') return { stdout: 'arm64' };
    assert.equal(file, '/usr/bin/codesign');
    const bundle = args.at(-1);
    const version = await fs.readFile(path.join(bundle, 'version'), 'utf8').catch(() => '2.0.1');
    return { stdout: '', stderr: `Identifier=dev.openchamber.desktop\nCDHash=${(version === '2.0.1' ? 'a' : 'b').repeat(40)}\nSignature=adhoc\nTeamIdentifier=not set\n` };
  };
  return { run };
};

