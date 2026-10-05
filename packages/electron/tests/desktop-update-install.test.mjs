import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createMacDmgInstaller } from '../desktop-updater-macos.mjs';
const { readUpdateIntent, mutateUpdateIntent, runDesktopUpdateInstall } = await import(process.env.DEVRYAN_TEST_UPDATE_INSTALLER
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
      version: '2.0.2', arch: 'arm64', signing: { mode: 'adhoc', identifier: 'dev.openchamber.desktop' },
      sha256, manifestSha256: sha256, bridgeSha256: sha256, ownerPID: 123456, ownerStart: 'fixture-owner' };
    await fs.writeFile(intentPath, JSON.stringify(intent), { mode: 0o600 });
    const roots = [root], mutate = (allowed, patch) => mutateUpdateIntent(intentPath, nonce, allowed, patch, roots);
    const verifyBundle = async (bundle, { version }) => {
      assert.equal(await fs.readFile(path.join(bundle, 'version'), 'utf8'), version);return { manifestSha256: sha256 };
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

test('a live original owner refuses installation without moving either app', async () => fixture(async f => {
  await assert.rejects(runDesktopUpdateInstall(f.intentPath, { ...f.options, ownerExited: async () => false }),
    { code: 'update_owner_still_active' });
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'aborted');
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
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots });
  await fs.rename(f.intentPath, path.join(f.root, 'install-intent.json'));
  f.intentPath = path.join(f.root, 'install-intent.json');
  await mutateUpdateIntent(f.intentPath, f.intent.nonce, ['prepared'], { phase: 'launching' }, f.roots);
  await assert.rejects(installer.beginStartup('different'), { code: 'update_installation_pending' });
  assert.equal(await installer.beginStartup(f.intent.nonce), true);
  const held = await readUpdateIntent(f.intentPath, f.roots);
  assert.equal(held.candidatePID, process.pid);assert.ok(held.candidateStart);assert.equal(held.candidateStopped, false);
  await installer.acceptStartup();
  assert.equal((await readUpdateIntent(f.intentPath, f.roots)).phase, 'accepted');
  assert.equal(installer.isCandidateStartup(), false);
  assert.ok(await fs.lstat(f.intent.stage));
}));

test('failed candidate startup records only verified cleanup and a later launch archives its completed intent', async () => fixture(async f => {
  f.intentPath = path.join(f.root, 'install-intent.json');
  await fs.writeFile(f.intentPath, JSON.stringify({ ...f.intent, phase: 'launching' }), { mode: 0o600 });
  let refusal = 0;
  const installer = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.2', cacheDirectory: f.root, roots: f.roots,
    onRollbackRequested: async () => { refusal++;await installer.recordCandidateStopped(true); } });
  await installer.beginStartup(f.intent.nonce);await installer.refuseStartup();
  assert.equal(refusal, 1);assert.equal((await readUpdateIntent(f.intentPath, f.roots)).candidateStopped, true);
  await mutateUpdateIntent(f.intentPath, f.intent.nonce, ['rollback-requested'], { phase: 'rolled-back' }, f.roots);
  const prior = createMacDmgInstaller({ installedBundle: f.intent.target, currentVersion: '2.0.1', cacheDirectory: f.root, roots: f.roots,
    trashItem: target => fs.rename(target, path.join(f.root, 'disposable-trash')) });
  assert.equal(await prior.beginStartup(), false);await prior.acceptStartup();
  await assert.rejects(fs.lstat(f.intentPath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, `install-${f.intent.nonce}.json`), 'utf8')).phase, 'rolled-back');
  assert.ok(await fs.lstat(path.join(f.root, 'disposable-trash')));
}));
