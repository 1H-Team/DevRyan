import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createMacDmgInstaller } from '../desktop-updater-macos.mjs';
import { fixture, readUpdateIntent, processStart, runDesktopUpdateInstall } from './desktop-update-install-fixture.mjs';

assert.equal(process.platform, 'darwin', 'Native DMG installer acceptance is unavailable on this platform');

for (const stopAfter of [1, 2]) {
  test(`a killed helper recovers the ${stopAfter === 1 ? 'installation' : 'rollback'} atomic exchange`, async () => fixture(async f => {
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

test('reopening an interrupted exchange binds and hands off to one verified helper', async () => fixture(async f => {
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
