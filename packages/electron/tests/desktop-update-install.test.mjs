import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createMacDmgInstaller } from '../desktop-updater-macos.mjs';
import { fixture, startupFixture, readUpdateIntent, mutateUpdateIntent, runDesktopUpdateInstall, processStart } from './desktop-update-install-fixture.mjs';

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
