import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createMacDmgInstaller } from '../desktop-updater-macos.mjs';
const { readUpdateIntent, mutateUpdateIntent, runDesktopUpdateInstall, processStart } = await import(process.env.DEVRYAN_TEST_UPDATE_INSTALLER
  ? pathToFileURL(process.env.DEVRYAN_TEST_UPDATE_INSTALLER).href : '../desktop-update-install.mjs');

const sha256 = 'a'.repeat(64);
const fixture = async action => {
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
const startupFixture = async f => {
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

test('waits for the exact owner exit, then accepts startup while retaining the original app', async () => fixture(async f => {
  const calls = [];
  assert.equal(await runDesktopUpdateInstall(f.intentPath, { ...f.options,
    ownerExited: async (pid, start) => { calls.push([pid, start]);return true; },
    onWaiting: nonce => assert.equal(nonce, f.intent.nonce),
    launch: async () => { await f.mutate(['launching'], { phase: 'accepted' }); },
  }), 'complete');
  assert.deepEqual(calls, [[123456, 'fixture-owner']]);
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'complete');
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.2');
  assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
}));

for (const point of ['waiting-for-owner', 'before-exchange', 'after-exchange', 'after-backup']) {
  test(`an interrupted helper resumes ${point} without losing the original app`, async () => fixture(async f => {
    const candidate = await fs.lstat(f.intent.candidate);
    await f.mutate(['prepared'], { phase: point === 'waiting-for-owner' ? point : 'swapping',
      candidateIdentity: { dev: candidate.dev, ino: candidate.ino }, helperPID: 123457, helperStart: 'exited-helper' });
    if (point === 'after-exchange' || point === 'after-backup') await f.swapApplications(f.intent.candidate, f.intent.target);
    if (point === 'after-backup') await f.renameExclusive(f.intent.candidate, f.intent.backup);
    let launches = 0;
    assert.equal(await runDesktopUpdateInstall(f.intentPath, { ...f.options, launch: async () => {
      launches++;await f.mutate(['launching'], { phase: 'accepted' });
    } }), 'complete');
    assert.equal(launches, 1);
    assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.2');
    assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
  }));
}

for (const point of ['before-rollback-exchange', 'after-rollback-exchange', 'after-failed-naming']) {
  test(`an interrupted rollback resumes ${point} from the exact app identities`, async () => fixture(async f => {
    const candidate = await fs.lstat(f.intent.candidate);
    await f.swapApplications(f.intent.candidate, f.intent.target);
    await f.renameExclusive(f.intent.candidate, f.intent.backup);
    await f.mutate(['prepared'], { phase: 'rolling-back', candidateIdentity: { dev: candidate.dev, ino: candidate.ino },
      candidateStopped: true, candidatePID: 123458, candidateStart: 'exited-candidate', helperPID: 123457, helperStart: 'exited-helper' });
    if (point !== 'before-rollback-exchange') await f.swapApplications(f.intent.backup, f.intent.target);
    if (point === 'after-failed-naming') await f.renameExclusive(f.intent.backup, f.intent.failed);
    const launches = [];
    assert.equal(await runDesktopUpdateInstall(f.intentPath, { ...f.options,
      launch: async target => launches.push(await fs.readFile(path.join(target, 'version'), 'utf8')) }), 'rolled-back');
    assert.deepEqual(launches, ['2.0.1']);
    assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.1');
    assert.equal(await fs.readFile(path.join(f.intent.failed, 'version'), 'utf8'), '2.0.2');
  }));
}

test('recovery observes a lost launch acknowledgement without replaying the launch', async () => fixture(async f => {
  const candidate = await fs.lstat(f.intent.candidate);
  await f.swapApplications(f.intent.candidate, f.intent.target);await f.renameExclusive(f.intent.candidate, f.intent.backup);
  await f.mutate(['prepared'], { phase: 'launching', candidateIdentity: { dev: candidate.dev, ino: candidate.ino },
    helperPID: 123457, helperStart: 'exited-helper' });
  assert.equal(await runDesktopUpdateInstall(f.intentPath, { ...f.options,
    ownerExited: async () => { await f.mutate(['launching'], { phase: 'accepted' });return true; },
    launch: async () => assert.fail('A durable launch cannot be replayed'),
  }), 'complete');
}));

test('a live helper and an unexited recovery host refuse a second installation owner', async () => fixture(async f => {
  await f.mutate(['prepared'], { phase: 'waiting-for-owner', helperPID: process.pid, helperStart: await processStart(process.pid) });
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, f.options), { code: 'update_installer_still_active' });
  await f.mutate(['waiting-for-owner'], { helperPID: 123457, helperStart: 'exited-helper', recoveryOwnerPID: 123458, recoveryOwnerStart: 'live-recovery-host' });
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options,
    ownerExited: async pid => pid !== 123458 }), { code: 'update_owner_still_active' });
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.1');
}));

for (const stopAfter of [1, 2]) {
  test(`a killed helper recovers the ${stopAfter === 1 ? 'installation' : 'rollback'} atomic exchange`, { skip: process.platform !== 'darwin' }, async () => fixture(async f => {
    const bridge = new URL('../resources/native/DevRyanRuntimeServiceControl.node', import.meta.url).pathname;
    const installer = process.env.DEVRYAN_TEST_UPDATE_INSTALLER
      ? pathToFileURL(process.env.DEVRYAN_TEST_UPDATE_INSTALLER).href : new URL('../desktop-update-install.mjs', import.meta.url).href;
    const worker = path.join(f.root, 'interrupted-helper.mjs');
    await fs.writeFile(worker, `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      import { runDesktopUpdateInstall, mutateUpdateIntent } from ${JSON.stringify(installer)};
      const intent = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
      const roots = [path.dirname(intent.target)], bridge = createRequire(import.meta.url)(${JSON.stringify(bridge)});
      let swaps = 0;
      await runDesktopUpdateInstall(process.argv[2], { roots, startupTimeoutMs: 1000, ownerExited: async () => true,
        verifyBundle: async (bundle, { version }) => {
          if (await fs.readFile(path.join(bundle, 'version'), 'utf8') !== version) throw new Error('fixture_version_changed');
          return { manifestSha256: intent.manifestSha256, signing: version === '2.0.1' ? intent.signing : intent.candidateSigning };
        },
        renameExclusive: bridge.renameExclusive,
        swapApplications: async (from, to) => {
          bridge.swapApplications(from, to);
          if (++swaps === ${stopAfter}) { process.send({ point: swaps });await new Promise(() => { setInterval(() => {}, 1000); }); }
        },
        launch: async () => mutateUpdateIntent(process.argv[2], intent.nonce, ['launching'],
          { phase: 'rollback-requested', candidatePID: 123458, candidateStart: 'fixture-candidate', candidateStopped: true }, roots),
      });
    `, { mode: 0o600 });
    const child = spawn(process.execPath, [worker, f.intentPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { HOME: f.root, TMPDIR: f.root, PATH: '/usr/bin:/bin' } });
    let errorText = '';
    child.stderr.on('data', bytes => { errorText += bytes.toString(); });
    const exit = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const observed = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(`fixture_helper_exited: ${errorText}`); })]);
      assert.equal(observed[0].point, stopAfter);
      const recorded = await readUpdateIntent(f.intentPath, f.roots);
      assert.equal(recorded.helperPID, child.pid);
      assert.equal(recorded.helperStart, await processStart(child.pid));
      child.kill('SIGKILL');
      assert.deepEqual(await exit, [null, 'SIGKILL']);
      assert.notEqual(await processStart(child.pid), recorded.helperStart);
      const native = createRequire(import.meta.url)(bridge);
      const launches = [];
      const result = await runDesktopUpdateInstall(f.intentPath, { ...f.options,
        renameExclusive: native.renameExclusive, swapApplications: native.swapApplications,
        launch: async target => {
          launches.push(await fs.readFile(path.join(target, 'version'), 'utf8'));
          if (stopAfter === 1) await f.mutate(['launching'], { phase: 'accepted' });
        },
      });
      assert.equal(result, stopAfter === 1 ? 'complete' : 'rolled-back');
      assert.deepEqual(launches, [stopAfter === 1 ? '2.0.2' : '2.0.1']);
      assert.equal(await fs.readFile(path.join(stopAfter === 1 ? f.intent.backup : f.intent.target, 'version'), 'utf8'), '2.0.1');
    } finally { clearTimeout(timeout);if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');await exit; }
  }));
}

test('a live original owner refuses installation without moving either app', async () => fixture(async f => {
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options, ownerExited: async () => false }),
    { code: 'update_owner_still_active' });
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'aborted');
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.1');
  assert.equal(await fs.readFile(path.join(f.intent.candidate, 'version'), 'utf8'), '2.0.2');
}));

test('an in-place re-signed original refuses before exchange and cannot claim a verified rollback', async () => fixture(async f => {
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options, verifyBundle: async (...args) => ({
    ...await f.verifyBundle(...args), signing: { ...f.intent.signing, cdhash: 'c'.repeat(40) },
  }), launch: () => assert.fail('An unverified original cannot relaunch') }), { code: 'update_installation_changed' });
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'rollback-blocked');
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.1');
  assert.equal(await fs.readFile(path.join(f.intent.candidate, 'version'), 'utf8'), '2.0.2');
}));

test('proven candidate shutdown rolls back, retains failed bytes, and relaunches the original app', async () => fixture(async f => {
  const launches = [];
  assert.equal(await runDesktopUpdateInstall(f.intentPath, { ...f.options, launch: async target => {
    launches.push(await fs.readFile(path.join(target, 'version'), 'utf8'));
    if (launches.length === 1) await f.mutate(['launching'], { phase: 'rollback-requested', candidatePID: 789,
      candidateStart: 'candidate-identity', candidateStopped: true });
  } }), 'rolled-back');
  assert.deepEqual(launches, ['2.0.2', '2.0.1']);
  assert.equal(await fs.readFile(path.join(f.intent.failed, 'version'), 'utf8'), '2.0.2');
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'rolled-back');
}));

test('an unconfirmed shutdown preserves both apps and records a blocked rollback', async () => fixture(async f => {
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options, launch: async () => {
    await f.mutate(['launching'], { phase: 'rollback-blocked', candidateStopped: false });
  } }), { code: 'update_candidate_shutdown_unconfirmed' });
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'rollback-blocked');
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.2');
  assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
}));

test('a concurrent application at publication is preserved, with the original app recoverable', async () => fixture(async f => {
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options, swapApplications: async (from, to) => {
    await f.swapApplications(from, to);
    await fs.rename(f.intent.target, path.join(f.root, 'saved-candidate'));
    await fs.mkdir(f.intent.target);await fs.writeFile(path.join(f.intent.target, 'version'), 'concurrent');
  } }), { code: 'update_installation_changed' });
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'rollback-blocked');
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), 'concurrent');
  assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
  assert.equal(await fs.readFile(path.join(f.root, 'saved-candidate/version'), 'utf8'), '2.0.2');
}));

test('a target replaced after candidate launch is never overwritten during rollback', async () => fixture(async f => {
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options, launch: async () => {
    await fs.rename(f.intent.target, path.join(f.root, 'saved-candidate'));
    await fs.mkdir(f.intent.target);await fs.writeFile(path.join(f.intent.target, 'version'), 'concurrent');
    await f.mutate(['launching'], { phase: 'rollback-requested', candidatePID: 789, candidateStart: 'candidate', candidateStopped: true });
  } }), { code: 'update_installation_changed' });
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'rollback-blocked');
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), 'concurrent');
  assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
}));

test('intent validation refuses stale phase, foreign roots, hard links, and replaced stages', async () => fixture(async f => {
  await assert.rejects(f.mutate(['launching'], { phase: 'complete' }), { code: 'update_intent_changed' });
  await assert.rejects(readUpdateIntent(f.intentPath, []), { code: 'update_intent_invalid' });
  const link = path.join(f.root, 'linked-intent');await fs.link(f.intentPath, link);
  await assert.rejects(readUpdateIntent(f.intentPath, f.roots), { code: 'update_intent_invalid' });await fs.unlink(link);
  await fs.rename(f.intent.stage, path.join(f.root, 'saved-stage'));await fs.mkdir(f.intent.stage, { mode: 0o700 });
  await assert.rejects(readUpdateIntent(f.intentPath, f.roots), { code: 'update_intent_invalid' });
}));

test('candidate startup binds its process before acknowledging readiness and retains the backup', async () => fixture(async f => {
  const setup = await startupFixture(f);
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots, ...setup });
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));
  f.intentPath = path.join(f.root, 'install-intent.json');
  await assert.rejects(installer.beginStartup('different'), { code: 'update_installation_pending' });
  assert.equal(await installer.beginStartup(f.intent.nonce), true);
  const held = await readUpdateIntent(f.intentPath, f.roots);
  assert.equal(held.candidatePID, process.pid);assert.ok(held.candidateStart);assert.equal(held.candidateStopped, false);
  await installer.acceptStartup();
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'accepted');
  assert.equal(installer.isCandidateStartup(), false);
  assert.ok(await fs.lstat(f.intent.stage));
}));

test('startup refuses a replaced candidate even while the installer helper is alive', async () => fixture(async f => {
  const setup = await startupFixture(f);
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));
  await fs.rename(f.intent.target, path.join(f.root, 'saved-candidate'));
  await fs.cp(path.join(f.root, 'saved-candidate'), f.intent.target, { recursive: true });
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots, ...setup });
  await assert.rejects(installer.beginStartup(f.intent.nonce), { code: 'update_installation_changed' });
  assert.equal(installer.isCandidateStartup(), false);
  assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
}));

test('startup refuses a re-signed candidate whose directory and native manifest did not change', async () => fixture(async f => {
  const setup = await startupFixture(f);
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots,
    run: async (file, args) => {
      const result = await setup.run(file, args);
      return file === '/usr/bin/codesign' && args[0] === '-d' && args.at(-1) === f.intent.target
        ? { ...result, stderr: result.stderr.replace('b'.repeat(40), 'c'.repeat(40)) } : result;
    } });
  await assert.rejects(installer.beginStartup(f.intent.nonce), { code: 'update_installation_changed' });
  assert.equal(installer.isCandidateStartup(), false);
}));

test('an accepted candidate commits completion after helper death without another launch', async () => fixture(async f => {
  const setup = await startupFixture(f);
  await f.mutate(['launching'], { phase: 'accepted', helperPID: 123457, helperStart: 'exited-helper' });
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));f.intentPath = path.join(f.root, 'install-intent.json');
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots,
    ...setup, spawnImpl: () => assert.fail('An accepted startup must not be launched again') });
  assert.equal(await installer.beginStartup(), false);
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'complete');
  assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
}));

test('reopening an interrupted exchange refuses a changed cached helper before starting it', async () => fixture(async f => {
  await f.mutate(['prepared'], { phase: 'waiting-for-owner', helperPID: 123457, helperStart: 'exited-helper' });
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));f.intentPath = path.join(f.root, 'install-intent.json');
  const helper = path.join(f.root, `installer-${f.intent.nonce}`, 'desktop-update-install.mjs');
  await fs.mkdir(path.dirname(helper), { mode: 0o700 });await fs.writeFile(helper, 'changed helper', { mode: 0o600 });
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.1', cacheDirectory: f.root, roots: f.roots,
    spawnImpl: () => assert.fail('Changed helper cannot execute') });
  await assert.rejects(installer.beginStartup(), { code: 'update_installer_changed' });
  assert.equal(installer.isRecoveryStartup(), false);
  assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.1');
}));

test('reopening an interrupted exchange binds and hands off to one verified helper', { skip: process.platform !== 'darwin' }, async () => fixture(async f => {
  const bridge = new URL('../resources/native/DevRyanRuntimeServiceControl.node', import.meta.url).pathname;
  const installerModule = process.env.DEVRYAN_TEST_UPDATE_INSTALLER
    ? pathToFileURL(process.env.DEVRYAN_TEST_UPDATE_INSTALLER).href : new URL('../desktop-update-install.mjs', import.meta.url).href;
  const helper = path.join(f.root, `installer-${f.intent.nonce}`, 'desktop-update-install.mjs'), release = path.join(f.root, 'fixture-recovery-exit');
  await fs.mkdir(path.dirname(helper), { mode: 0o700 });
  const source = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { runDesktopUpdateInstall, mutateUpdateIntent } from ${JSON.stringify(installerModule)};
    const intentPath = process.argv[3], intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
    const roots = [path.dirname(intent.target)], bridge = createRequire(import.meta.url)('./DevRyanRuntimeServiceControl.node');
    const result = await runDesktopUpdateInstall(intentPath, { roots, startupTimeoutMs: 1000,
      renameExclusive: bridge.renameExclusive, swapApplications: bridge.swapApplications,
      verifyBundle: async (bundle, { version }) => {
        if (await fs.readFile(path.join(bundle, 'version'), 'utf8') !== version) throw new Error('fixture_version_changed');
        return { manifestSha256: intent.manifestSha256, signing: version === '2.0.1' ? intent.signing : intent.candidateSigning };
      },
      ownerExited: async pid => {
        if (pid === intent.recoveryOwnerPID) while (!await fs.stat(${JSON.stringify(release)}).catch(() => null)) await new Promise(resolve => setTimeout(resolve, 10));
        return true;
      },
      onWaiting: nonce => process.stdout.write(JSON.stringify({ protocol: 'devryan.desktop-update/1', nonce, status: 'waiting' }) + '\\n'),
      launch: () => mutateUpdateIntent(intentPath, intent.nonce, ['launching'], { phase: 'accepted' }, roots),
    });
    process.exitCode = result === 'complete' ? 0 : 2;
  `;
  const bridgeBytes = await fs.readFile(bridge);
  await fs.writeFile(helper, source, { mode: 0o600 });
  await fs.writeFile(path.join(path.dirname(helper), 'DevRyanRuntimeServiceControl.node'), bridgeBytes, { mode: 0o600 });
  await f.mutate(['prepared'], { phase: 'waiting-for-owner', helperPID: 123457, helperStart: 'exited-helper',
    installerSha256: createHash('sha256').update(source).digest('hex'), bridgeSha256: createHash('sha256').update(bridgeBytes).digest('hex') });
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));f.intentPath = path.join(f.root, 'install-intent.json');
  let child, exit;
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.1', cacheDirectory: f.root, roots: f.roots,
    spawnImpl: (...args) => { child = spawn(...args);exit = once(child, 'exit');return child; } });
  try {
    assert.equal(await installer.beginStartup(), false);
    assert.equal(installer.isRecoveryStartup(), true);
    const held = await readUpdateIntent(f.intentPath, f.roots);
    assert.equal(held.recoveryOwnerPID, process.pid);assert.equal(held.recoveryOwnerStart, await processStart(process.pid));
    assert.equal(held.helperPID, child.pid);assert.equal(held.helperStart, await processStart(child.pid));
    assert.equal(await fs.readFile(path.join(f.intent.target, 'version'), 'utf8'), '2.0.1');
    await fs.writeFile(release, 'fixture owner exit acknowledgement', { mode: 0o600 });
    assert.deepEqual(await exit, [0, null]);
    assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'complete');
    assert.equal(await fs.readFile(path.join(f.intent.backup, 'version'), 'utf8'), '2.0.1');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exit) await exit;
  }
}));

test('failed candidate startup records only verified cleanup and a later launch archives its completed intent', async () => fixture(async f => {
  const setup = await startupFixture(f);
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));f.intentPath = path.join(f.root, 'install-intent.json');
  let refusal = 0;
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots,
    ...setup, onRollbackRequested: async () => { refusal++;await installer.recordCandidateStopped(true); } });
  await installer.beginStartup(f.intent.nonce);await installer.refuseStartup();
  assert.equal(refusal, 1);assert.equal((await readUpdateIntent(f.intentPath, f.roots)).candidateStopped, true);
  await f.swapApplications(f.intent.backup, f.intent.target);await f.renameExclusive(f.intent.backup, f.intent.failed);
  await mutateUpdateIntent(f.intentPath, f.intent.nonce, ['rollback-requested'], { phase: 'rolled-back' }, f.roots);
  const prior = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.1', cacheDirectory: f.root, roots: f.roots,
    ...setup, trashItem: target => fs.rename(target, path.join(f.root, 'disposable-trash')) });
  assert.equal(await prior.beginStartup(), false);await prior.acceptStartup();
  await assert.rejects(fs.lstat(f.intentPath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, `install-${f.intent.nonce}.json`), 'utf8')).phase, 'rolled-back');
  assert.ok(await fs.lstat(path.join(f.root, 'disposable-trash')));
}));
