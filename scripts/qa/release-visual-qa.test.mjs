import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qaPackagedAppEnvironment } from './launch-environment.mjs';
import { captureScreenshot, connectStallMessage, electronLogFiles, relaunchDiagnostics, ownerCleanupTimedOut, ownerDiagnostics, ownerQuitForShippedCleanupTimeout, openSettingsAbout, expectedUpdate, gradeVisualQa, STEPS, versionPredates, installedReceiptComplete, observeInstalledDownload, observeInstalledRestart, parseVisualQaArgs, publicRelease, publicReleaseResponse, setQaLaunchEnvironment, visualQaHostRefusal } from './release-visual-qa.mjs';

test('isolated LaunchServices environment restores prior values and unwinds a partial setup', async () => {
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'DEVRYAN_ELECTRON_USER_DATA_DIR'];
  const environment = Object.fromEntries(keys.map(key => [key, `/run/${key}`]));
  for (const fail of [false, true]) {
    const values = new Map([['HOME', '/original']]);
    let refused = false;
    const run = async (_command, [action, key, value]) => {
      if (action === 'getenv') {
        if (!values.has(key)) throw Object.assign(new Error('unset'), { code: 1 });
        return { stdout: `${values.get(key)}\n` };
      }
      if (fail && !refused && key === 'XDG_DATA_HOME') { refused = true; throw new Error('setup refused'); }
      if (action === 'setenv') values.set(key, value); else values.delete(key);
      return { stdout: '' };
    };
    if (fail) await assert.rejects(setQaLaunchEnvironment(environment, run), /setup refused/);
    else {
      const restore = await setQaLaunchEnvironment(environment, run);
      assert.deepEqual(Object.fromEntries(values), environment);
      await restore(); await restore();
    }
    assert.deepEqual([...values], [['HOME', '/original']]);
  }
});

test('installed upgrade waits for the exact completed receipt and refuses rollback or another operation', () => {
  const expected = { target: '/run/home/Applications/DevRyan.app', from: '2.1.9', to: '2.1.18', sha256: 'a'.repeat(64), ownerPID: 42, ownerStart: 'original-start' };
  const receipt = { target: expected.target, previous: { version: expected.from }, version: expected.to,
    sha256: expected.sha256, ownerPID: expected.ownerPID, ownerStart: expected.ownerStart, phase: 'launching' };
  assert.equal(installedReceiptComplete(null, expected), false);
  for (const phase of ['prepared', 'waiting-for-owner', 'swapping', 'launching', 'accepted']) assert.equal(installedReceiptComplete({ ...receipt, phase }, expected), false);
  assert.equal(installedReceiptComplete({ ...receipt, phase: 'complete' }, expected), true);
  for (const phase of ['rolled-back', 'rollback-blocked', 'aborted']) assert.throws(() => installedReceiptComplete({ ...receipt, phase }, expected), /update failed/);
  for (const patch of [{ version: '2.1.17' }, { previous: { version: '2.1.13' } }, { target: '/other/app' }, { sha256: 'b'.repeat(64) }, { ownerPID: 43 }, { ownerStart: 'reused-pid' }]) {
    assert.throws(() => installedReceiptComplete({ ...receipt, ...patch, phase: 'complete' }, expected), /does not identify this upgrade/);
  }
});

test('installed download observation requires completion or advancing bytes and refuses lost, failed or stalled transfers', () => {
  const initial = { lastBytes: 0, lastProgressAt: 0 };
  const advanced = observeInstalledDownload({ state: 'pending', downloaded: 1024 }, initial, 80_000);
  assert.deepEqual(advanced, { lastBytes: 1024, lastProgressAt: 80_000 });
  assert.equal(observeInstalledDownload({ state: 'pending', downloaded: 1024 }, advanced, 100_000), advanced);
  assert.throws(() => observeInstalledDownload({ state: 'pending', downloaded: 1024 }, advanced, 170_000), /no download progress.*1024 bytes/);
  assert.throws(() => observeInstalledDownload(undefined, initial, 1), /observation was lost/);
  assert.throws(() => observeInstalledDownload({ state: 'failed', message: 'refused' }, initial, 1), /download failed: refused/);
  assert.equal(observeInstalledDownload({ state: 'complete' }, advanced, 170_000).complete, true);
});

test('installed restart observation surfaces the preparation refusal code and diagnostic', () => {
  assert.equal(observeInstalledRestart({ state: 'complete' }), 'pending');
  assert.equal(observeInstalledRestart({ state: 'complete', restart: { state: 'pending' } }), 'pending');
  assert.equal(observeInstalledRestart({ state: 'complete', restart: { state: 'returned' } }), 'returned');
  assert.throws(() => observeInstalledRestart(undefined), /lost before restart/);
  assert.throws(() => observeInstalledRestart({ restart: { state: 'failed', code: 'native_runtime_artifacts_unverified',
    message: 'native_runtime_artifacts_unverified', diagnostic: '{"stage":"manifest","reason":"manifest_invalid","purpose":"current"}' } }),
  error => error.preparationRefused === true && error.code === 'native_runtime_artifacts_unverified'
    && /preparation refused: native_runtime_artifacts_unverified .*manifest_invalid/.test(error.message));
  assert.throws(() => observeInstalledRestart({ restart: { state: 'failed', message: 'Installer updates are unavailable' } }), /no code Installer updates/);
});

test('QA release metadata uses the read-only token when available and permits anonymous discovery', async () => {
  for (const token of ['qa-read-token', '']) {
    const release = await publicRelease('v2.1.18', async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/1H-Team/DevRyan/releases/tags/v2.1.18');
      assert.equal(options.headers.Authorization, token ? `Bearer ${token}` : undefined);
      return Response.json({ tag_name: 'v2.1.18' });
    }, token);
    assert.equal(release.tag_name, 'v2.1.18');
  }
});

test('arguments name exactly one absolute DMG or a version, and an absolute report', () => {
  assert.deepEqual(parseVisualQaArgs(['--dmg', '/r/DevRyan-2.1.11-arm64.dmg', '--report', '/r/out/report.json', '--upgrade-from', 'v2.1.9']),
    { isolatedHost: false, keepArtifacts: false, dmg: '/r/DevRyan-2.1.11-arm64.dmg', report: '/r/out/report.json', upgradeFrom: 'v2.1.9' });
  assert.equal(parseVisualQaArgs(['--version', '2.1.11', '--report', '/r/report.json', '--isolated-host']).isolatedHost, true);
  for (const argv of [[], ['--report', '/r/report.json'], ['--dmg', 'relative.dmg', '--report', '/r/report.json'], ['--dmg', '/r/a.dmg', '--version', '2.1.11', '--report', '/r/report.json'],
    ['--version', 'v2.1.11', '--report', '/r/report.json'], ['--version', '2.1.11', '--report', 'report.json'], ['--version', '2.1.11', '--report', '/r/report.json', '--upgrade-from', '2.1.9'],
    ['--version', '2.1.11', '--report', '/r/report.json', '--force']]) assert.throws(() => parseVisualQaArgs(argv), undefined, argv.join(' '));
});

test('it never runs beside the owner app: a disposable runner or an isolated host, and no DevRyan running for this user', () => {
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: { GITHUB_ACTIONS: 'true' } }), null);
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: {}, isolatedHost: true }), null);
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: {} }), 'disposable_host_required');
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: { GITHUB_ACTIONS: 'true' }, runningApps: ['4242'] }), 'devryan_running_for_this_user');
  assert.equal(visualQaHostRefusal({ platform: 'linux', arch: 'x64', environment: { GITHUB_ACTIONS: 'true' } }), 'macos_arm64_required');
});

test('the private profile keeps HOME, XDG, temp and Git inside the run root and inherits no secrets', () => {
  const env = qaPackagedAppEnvironment({ home: '/run/candidate/home', root: '/run' }, { PATH: '/usr/bin', HOME: '/Users/owner', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/run/candidate/home', XDG_CONFIG_HOME: '/run/candidate/home/.config', XDG_DATA_HOME: '/run/candidate/home/.local/share',
    XDG_STATE_HOME: '/run/candidate/home/.local/state', XDG_CACHE_HOME: '/run/candidate/home/.cache', TMPDIR: '/run', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: '/run' });
});

test('the update check expects exactly what the real feed should offer', () => {
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: '2.1.10' }), { available: false, version: null }, 'an unpublished candidate is newer than the feed');
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: '2.1.11' }), { available: false, version: null });
  assert.deepEqual(expectedUpdate({ current: '2.1.9', latest: '2.1.11' }), { available: true, version: '2.1.11' });
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: '2.10.0' }), { available: true, version: '2.10.0' });
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: null }), { available: false, version: null });
});

test('every step, the optional upgrade and cleanup must pass; a skipped upgrade is not a failure', () => {
  const steps = Object.fromEntries(['dmg', 'install', 'splash', 'ready', 'about', 'updateCheck', 'stopped'].map(name => [name, { passed: true }]));
  assert.deepEqual(gradeVisualQa({ steps }), { passed: true, failures: [] });
  assert.deepEqual(gradeVisualQa({ steps, upgrade: { status: 'skipped' } }), { passed: true, failures: [] });
  assert.deepEqual(gradeVisualQa({ steps, upgrade: { status: 'failed' } }), { passed: false, failures: ['upgrade'] });
  assert.deepEqual(gradeVisualQa({ steps: { ...steps, about: { passed: false } }, cleanupFailures: [{ step: 'app' }] }), { passed: false, failures: ['about', 'cleanup'] });
  assert.deepEqual(gradeVisualQa({ steps: {} }).failures, ['dmg', 'install', 'splash', 'ready', 'about', 'updateCheck', 'stopped']);
});

test('a stalled screenshot is retried after bringing the page forward; other failures and a persistent stall are not', async () => {
  const connection = (results) => ({ calls: [], send(method) {
    this.calls.push(method);
    if (method === 'Page.bringToFront') return Promise.resolve({});
    const next = results.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  } });
  const stall = () => new Error('Timed out waiting for CDP Page.captureScreenshot');
  const recovered = connection([stall(), { data: 'cG5n' }]);
  assert.deepEqual(await captureScreenshot(recovered), { data: 'cG5n' });
  assert.deepEqual(recovered.calls, ['Page.captureScreenshot', 'Page.bringToFront', 'Page.captureScreenshot']);
  const stalled = connection([stall(), stall(), stall(), { data: 'late' }]);
  await assert.rejects(captureScreenshot(stalled), /Timed out waiting for CDP Page\.captureScreenshot/);
  assert.equal(stalled.calls.filter(call => call === 'Page.captureScreenshot').length, 3);
  const closed = connection([new Error('CDP connection closed')]);
  await assert.rejects(captureScreenshot(closed), /connection closed/);
  assert.deepEqual(closed.calls, ['Page.captureScreenshot']);
});

test('a baseline that never becomes ready reports process, pages, health, last error and a bounded log tail', () => {
  const message = connectStallMessage({ origin: 'http://127.0.0.1:4100', pages: ['file:', 'http://127.0.0.1:4200'], health: undefined,
    error: 'Timed out waiting for CDP Debugger.paused', process: 'running', root: '/run/root',
    log: `${'x'.repeat(5000)}\nline /run/root/home/a\n[startup] token ${'a'.repeat(40)}\nlast` });
  assert.match(message, /^The upgrade app did not become ready within 180 seconds \(process: running; expected http:\/\/127\.0\.0\.1:4100; pages: \[file:, http:\/\/127\.0\.0\.1:4200\]; health: not probed; last error: Timed out waiting for CDP Debugger\.paused; log: /);
  assert.match(message, /<run>\/home\/a/);
  assert.match(message, /token <redacted>/);
  assert.ok(message.length <= 1200);
  assert.match(connectStallMessage({ origin: 'o', process: 'QA child exited: 1' }), /process: QA child exited: 1; expected o; pages: none listed; health: not probed; last error: none; log: empty/);
});

test('Settings is reopened when the shortcut was dropped; About must still appear', async () => {
  const run = async (outcomes) => {
    const calls = [];
    const ui = { key: async () => calls.push('key'), click: async ({ timeout }) => {
      calls.push(`click:${timeout ?? 'default'}`);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    } };
    let fronted = 0;
    const result = await openSettingsAbout(ui, async () => { fronted += 1; }).catch(error => error);
    return { result, calls, fronted };
  };
  const missing = () => new Error('Timed out: visible control About');
  const second = await run([missing(), 'clicked']);
  assert.equal(second.result, 'clicked');
  assert.deepEqual(second.calls, ['key', 'click:5000', 'key', 'click:5000']);
  assert.equal(second.fronted, 2);
  const never = await run([missing(), missing(), missing()]);
  assert.match(never.result.message, /visible control About/);
  assert.deepEqual(never.calls, ['key', 'click:5000', 'key', 'click:5000', 'key', 'click:default']);
  const crashed = await run([new Error('QA child exited: 1')]);
  assert.match(crashed.result.message, /child exited/);
  assert.deepEqual(crashed.calls, ['key', 'click:5000']);
});

test('the latest-release response keeps GitHub\'s exact body and refuses other failures', async () => {
  const body = '{ "tag_name": "v2.1.17" }';
  assert.deepEqual(await publicReleaseResponse('latest', async () => new Response(body, { status: 200 }), 'token'), { status: 200, body });
  assert.deepEqual(await publicReleaseResponse('latest', async () => new Response('{}', { status: 404 }), ''), { status: 404, body: '{}' });
  await assert.rejects(publicReleaseResponse('latest', async () => new Response('', { status: 403 }), ''), /failed \(403\)/);
  assert.equal(await publicRelease('v9.9.9', async () => new Response('{}', { status: 404 }), ''), null);
});

test('installer failures record the owner state and bounded, redacted log tails', async () => {
  const run = async (command, args) => { assert.equal(command, '/bin/ps'); assert.deepEqual(args.slice(-2), ['-p', '42']);
    return { stdout: 'S      02:10 Mon Oct 26 06:23:41 2026\n' }; };
  const files = { '/run/root/home/Library/Logs/DevRyan/main.log': `${Array.from({ length: 60 }, (_, n) => `line ${n}`).join('\n')}\n[electron] update cleanup refused { code: 'x' } /run/root/a token ${'b'.repeat(40)}` };
  const detail = await ownerDiagnostics({ pid: 42, start: 'Mon Oct 26 06:23:41 2026', log: 'one\ntwo', root: '/run/root', run,
    logFiles: ['/run/root/home/Library/Logs/DevRyan/main.log', '/missing.log'], readFile: async file => { if (!files[file]) throw new Error('ENOENT'); return files[file]; } });
  assert.deepEqual(detail.owner, { pid: 42, state: 'S      02:10 Mon Oct 26 06:23:41 2026', sameProcess: true });
  assert.equal(detail.output, 'one | two');
  assert.equal(detail.logFiles.length, 1);
  assert.equal(detail.logFiles[0].file, '<run>/home/Library/Logs/DevRyan/main.log');
  assert.match(detail.logFiles[0].tail, /^line 21 \| /);
  assert.match(detail.logFiles[0].tail, /update cleanup refused .* <run>\/a token <redacted>$/);
  assert.deepEqual((await ownerDiagnostics({ pid: 7, run: async () => ({ stdout: '' }) })).owner, { pid: 7, state: 'exited' });
});

test('only installs with the shipped update-cleanup defect are quit for their waiting installer', () => {
  const log = "06:46:01.325 \u203a [electron] update cleanup refused { code: 'update_cleanup_timeout' }\n06:46:01.518 \u203a Server close timeout reached";
  assert.equal(ownerCleanupTimedOut(log), true);
  assert.equal(ownerCleanupTimedOut("[electron] update cleanup refused { code: 'update_cleanup_failed' }"), false);
  assert.equal(ownerCleanupTimedOut(''), false);
  for (const from of ['1.2.21', '1.2.22']) assert.equal(ownerQuitForShippedCleanupTimeout(from).reason, 'update_cleanup_timeout');
  for (const from of ['2.0.0', '2.0.1', '2.1.18', '3.0.0']) assert.throws(() => ownerQuitForShippedCleanupTimeout(from), /only installs before v2\.0\.0/);
});

test('the update path is skipped only when the baseline does not predate the candidate', () => {
  assert.equal(versionPredates('2.0.0', '2.0.0'), false);
  assert.equal(versionPredates('2.0.1', '2.0.0'), false);
  assert.equal(versionPredates('2.0.0', '2.0.1'), true);
  assert.equal(versionPredates('1.9.9', '2.0.0'), true);
  assert.equal(versionPredates('2.0.9', '2.0.10'), true);
  assert.deepEqual(gradeVisualQa({ steps: Object.fromEntries(STEPS.map(step => [step, { passed: true }])), upgrade: { status: 'skipped', reason: 'no-older-supported-release' } }), { passed: true, failures: [] });
});

test('an upgrade-only lane requires the DMG check and the upgrade, not a repeat of the candidate launch', () => {
  assert.deepEqual(gradeVisualQa({ upgradeOnly: true, upgradeRequired: true, steps: { dmg: { passed: true } }, upgrade: { status: 'passed' } }), { passed: true, failures: [] });
  assert.deepEqual(gradeVisualQa({ upgradeOnly: true, upgradeRequired: true, steps: {}, upgrade: { status: 'skipped' } }).failures, ['dmg', 'upgrade']);
  assert.ok(gradeVisualQa({ upgradeRequired: true, steps: { dmg: { passed: true } }, upgrade: { status: 'passed' } }).failures.includes('ready'));
});

test('Electron log files are discovered under each home whatever the app named its log folder', async () => {
  const tree = { '/h/Library/Logs': ['DevRyan', '@devryan', 'Other'], '/h/Library/Logs/DevRyan': ['main.log', 'old.txt'],
    '/h/Library/Logs/@devryan': ['electron'], '/h/Library/Logs/@devryan/electron': ['main.log', 'renderer.log'], '/h/Library/Logs/Other': ['main.log'] };
  const readdir = async (directory, options) => {
    if (!tree[directory]) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return options?.withFileTypes ? tree[directory].map(name => ({ name, isDirectory: () => Boolean(tree[`${directory}/${name}`]) })) : tree[directory];
  };
  assert.deepEqual(await electronLogFiles(['/h', '/h', '/missing'], { readdir }),
    ['/h/Library/Logs/DevRyan/main.log', '/h/Library/Logs/@devryan/electron/main.log', '/h/Library/Logs/@devryan/electron/renderer.log']);
});

test('relaunch diagnostics keep the unified log, recent DevRyan crash reports and the launchd environment, bounded', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push(command);
    if (command === '/usr/bin/log') return { stdout: 'DevRyan: dyld: Library not loaded /run/root/x\nexit 6' };
    return { stdout: args[1] === 'HOME' ? '/run/root/upgrade/home\n' : '' };
  };
  const files = { '/h/Library/Logs/DiagnosticReports': ['DevRyan-2026-10-26.ips', 'Other.ips', 'DevRyan-old.ips'] };
  const detail = await relaunchDiagnostics({ homes: ['/h', '/h'], root: '/run/root', run, now: 1_000_000_000,
    readdir: async directory => files[directory] ?? [], readFile: async () => '{"exception":{"type":"EXC_CRASH"}}',
    stat: async file => ({ mtimeMs: file.endsWith('old.ips') ? 0 : 999_999_000 }) });
  assert.match(detail.unifiedLog, /Library not loaded <run>\/x \| exit 6/);
  assert.deepEqual(detail.crashReports, [{ name: 'DevRyan-2026-10-26.ips', head: '{"exception":{"type":"EXC_CRASH"}}' }]);
  assert.equal(detail.launchdEnvironment.HOME, '<run>/upgrade/home');
  assert.equal(detail.launchdEnvironment.TMPDIR, '(unset)');
  assert.equal(calls.filter(command => command === '/usr/bin/log').length, 1);
});
