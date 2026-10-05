import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedNativeSetup } from '../../packages/web/server/lib/opencode/runtime-host/native-setup-seed.js';
import {
  CHANGED_THEME_ID, DEFAULT_V200_ARTIFACTS, INITIAL_THEME_ID, PLAN_COUNTS, SHELL_EXPORTS, buildLegacyOwnerTree, buildShellExportRcFiles,
  classifyBundledRuntimeOffer, createV200PrepareEnvironment, findProcessesMatching, firstLaunchLayout, gradeShellExportLog, hashLegacyPlans,
  parseFirstLaunchArgs, parseSeedSkipSummary, parseStartupFailures, resolvePackageRepositoryRoot, writeLegacyOwnerTree, writeShellExportRcFiles,
} from './first-launch-smoke.mjs';

const projectPaths = Array.from({ length: 8 }, (_, index) => `/synthetic/workspace/project-${index + 1}`);
const evidence = '/repo/.cache/qa/packaged-electron-x/package-evidence.json';

test('CLI requires an absolute package, a known scenario and v2.0.0 source only for v200 scenarios', () => {
  assert.deepEqual(parseFirstLaunchArgs(['--package-evidence', evidence, '--scenario', 'owner-shaped']),
    { packageEvidence: evidence, scenario: 'owner-shaped', v200Artifacts: DEFAULT_V200_ARTIFACTS, timeoutMs: 180000, keepRuntime: false, shellExports: false });
  assert.deepEqual(parseFirstLaunchArgs(['--scenario', 'v200-selected', '--package-evidence', evidence, '--v200-source', '/v200',
    '--v200-artifacts', '/artifacts', '--timeout-ms', '60000', '--keep-runtime']),
  { packageEvidence: evidence, scenario: 'v200-selected', v200Source: '/v200', v200Artifacts: '/artifacts', timeoutMs: 60000, keepRuntime: true, shellExports: false });
  assert.equal(parseFirstLaunchArgs(['--shell-exports', '--package-evidence', evidence, '--scenario', 'owner-shaped']).shellExports, true);
  for (const argv of [[], ['--scenario', 'owner-shaped'], ['--package-evidence', 'relative.json', '--scenario', 'owner-shaped'],
    ['--package-evidence', evidence, '--scenario', 'v1'], ['--package-evidence', evidence, '--scenario', 'v200-half-seed'],
    ['--package-evidence', evidence, '--scenario', 'owner-shaped', '--v200-source', '/v200'],
    ['--package-evidence', evidence, '--scenario', 'owner-shaped', '--timeout-ms', '5'],
    ['--package-evidence', evidence, '--scenario', 'owner-shaped', '--timeout-ms', '1e5'],
    ['--package-evidence', evidence, '--package-evidence', evidence, '--scenario', 'owner-shaped'],
    ['--package-evidence', '--scenario', 'owner-shaped'], ['--package-evidence', evidence, '--scenario', 'owner-shaped', '--extra', 'x'],
    ['--package-evidence', evidence, '--scenario', 'owner-shaped', '--shell-exports', '--shell-exports']]) {
    assert.throws(() => parseFirstLaunchArgs(argv), error => error.code === 'qa_first_launch_usage', argv.join(' '));
  }
});

test('runtime layout matches the packaged QA host policy', () => {
  const layout = firstLaunchLayout('/qa/runtime');
  assert.equal(path.dirname(layout.profile), '/qa/runtime');
  assert.equal(layout.data, '/qa/runtime/home/.config/openchamber');
  assert.equal(layout.credentials, '/qa/runtime/credentials.env.json');
  assert.equal(layout.controlRoot, '/qa/runtime/home/.local/state/devryan/runtime-bundles');
  assert.equal(layout.freshSource, '/qa/runtime/home/.local/state/devryan/fresh-native-source');
  assert.equal(layout.shellConfig, '/qa/runtime/home/.config/qa-zsh');
});

test('owner-shaped tree: 8 records, 608 v1 plans, a nested folder, Finder and AppleDouble metadata, fake credentials', () => {
  const tree = buildLegacyOwnerTree({ projectPaths });
  const names = [...tree.files.keys()];
  const projects = '.config/openchamber/projects/';
  const topLevel = names.filter(name => name.startsWith(projects) && !name.slice(projects.length).includes('/'));
  assert.deepEqual(topLevel.filter(name => name.endsWith('.json')).map(name => name.slice(projects.length)).sort(), tree.expectedRecords);
  assert.equal(tree.expectedRecords.length, 8);
  assert.ok(tree.expectedRecords.every(name => /^path_[A-Za-z0-9_-]+\.json$/.test(name)));
  assert.ok(topLevel.includes(`${projects}.DS_Store`));
  const plans = names.filter(name => /^\.config\/openchamber\/projects\/[^/]+\/plans\/[^/]+\.md$/.test(name));
  assert.equal(plans.length, 608);
  assert.equal(PLAN_COUNTS.reduce((sum, count) => sum + count, 0), 608);
  assert.equal(new Set(plans.map(name => name.split('/')[3])).size, 3);
  assert.ok(names.some(name => /\/plans\/archive\/old-0001\.md$/.test(name)));
  for (const required of ['.config/opencode/opencode.json', '.config/opencode/agents/.DS_Store', '.config/opencode/skills/.DS_Store',
    '.config/opencode/skills/qa-fixture-skill/SKILL.md', '.agents/skills/qa-shared-skill/SKILL.md', '.agents/skills/qa-shared-skill/._SKILL.md',
    '.local/share/opencode/auth.json']) assert.ok(tree.files.has(required), required);
  assert.equal(names.filter(name => name.startsWith('.config/opencode/agents/') && name.endsWith('.md')).length, 2);
  assert.equal(names.filter(name => name.startsWith('.config/openchamber/project-icons/') && name.endsWith('.png')).length, 2);
  const settings = JSON.parse(tree.files.get('.config/openchamber/settings.json'));
  assert.equal(settings.themeId, INITIAL_THEME_ID);
  assert.notEqual(settings.themeId, CHANGED_THEME_ID);
  assert.equal(settings.projects.length, 8);
  assert.deepEqual(settings.desktopWindowState, { width: 1280, height: 800, maximized: false });
  const auth = JSON.parse(tree.files.get('.local/share/opencode/auth.json'));
  for (const [id, value] of Object.entries(auth)) {
    assert.match(id, /^qa-fixture-/);
    assert.match(value.key, /^qa-fixture-not-a-real-key-/);
  }
  assert.equal(tree.facts.planFiles, 608);
  assert.equal(tree.facts.dsStoreFiles, 4);
});

test('selected variant omits plans, the nested folder and every .DS_Store but keeps the 8 records', () => {
  const tree = buildLegacyOwnerTree({ variant: 'selected', projectPaths });
  const names = [...tree.files.keys()];
  assert.ok(!names.some(name => name.includes('/plans/')));
  assert.ok(!names.some(name => name.endsWith('.DS_Store')));
  assert.equal(tree.expectedRecords.length, 8);
  assert.equal(tree.facts.planFiles, 0);
  assert.throws(() => buildLegacyOwnerTree({ variant: 'other', projectPaths }), /variant/);
  assert.throws(() => buildLegacyOwnerTree({ projectPaths: projectPaths.slice(1) }), /8 absolute/);
});

test('the current setup importer imports exactly the 8 records and leaves v1 plans in place', async () => {
  // Canonical root: the importer rejects symlinked targets (macOS /var -> /private/var).
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devryan-first-launch-')));
  try {
    const home = path.join(root, 'home'), target = path.join(root, 'target');
    const tree = buildLegacyOwnerTree({ projectPaths: projectPaths.map(value => path.join(root, value)) });
    await writeLegacyOwnerTree(home, tree);
    const before = await hashLegacyPlans(path.join(home, '.config/openchamber/projects'));
    assert.equal(before.count, 608 + 2 + 1);
    const warn = console.warn; const warnings = [];
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    let result;
    try {
      result = await seedNativeSetup({ source: { webDataDirectory: path.join(home, '.config/openchamber'), webConfigDirectory: path.join(home, '.config/openchamber'),
        opencodeConfigDirectory: path.join(home, '.config/opencode'), opencodeDataDirectory: path.join(home, '.local/share/opencode'), home },
      target: { webDataDirectory: path.join(target, 'web-data'), webConfigDirectory: path.join(target, 'web-config'),
        opencodeConfigDirectory: path.join(target, 'opencode-config'), global: { home: path.join(target, 'home') } }, environment: {} });
    } finally { console.warn = warn; }
    assert.ok(Array.isArray(result.files));
    assert.deepEqual((await readdir(path.join(target, 'web-config/projects'))).sort(), tree.expectedRecords);
    assert.equal((await hashLegacyPlans(path.join(home, '.config/openchamber/projects'))).sha256, before.sha256);
    const settings = JSON.parse(await readFile(path.join(target, 'web-data/settings.json'), 'utf8'));
    assert.equal(settings.projects.length, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plan hash list changes when a v1 plan changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devryan-first-launch-hash-'));
  try {
    const tree = buildLegacyOwnerTree({ projectPaths });
    await writeLegacyOwnerTree(root, tree);
    const projects = path.join(root, '.config/openchamber/projects');
    const before = await hashLegacyPlans(projects);
    const plan = [...tree.files.keys()].find(name => name.endsWith('plan-0001.md'));
    await writeFile(path.join(root, plan), 'changed\n');
    assert.notEqual((await hashLegacyPlans(projects)).sha256, before.sha256);
    assert.equal((await hashLegacyPlans(path.join(root, 'missing'))).count, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v2.0.0 child environment keeps only platform inputs and the private roots', () => {
  const env = createV200PrepareEnvironment({ home: '/qa/home' }, { PATH: '/bin', LANG: 'C', HOME: '/Users/person', OPENCODE_HOST: 'x',
    OPENCODE_CONFIG_DIR: '/Users/person/.config/opencode', DEVRYAN_RUNTIME_BUNDLE_ROOT: '/x', OPENCHAMBER_DATA_DIR: '/x', OPENAI_API_KEY: 'x', NODE_OPTIONS: 'x' });
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C', HOME: '/qa/home', XDG_CONFIG_HOME: '/qa/home/.config', XDG_DATA_HOME: '/qa/home/.local/share',
    XDG_STATE_HOME: '/qa/home/.local/state', XDG_CACHE_HOME: '/qa/home/.cache' });
});

test('startup failures are read from multi-line electron-log records and captured output', () => {
  const log = [
    '[2026-10-05 10:00:00.000] [info]  [electron] starting',
    "[2026-10-05 10:00:01.000] [error] [electron] startup failed {",
    "  message: 'native_setup_json_invalid',",
    "  code: 'native_setup_json_invalid',",
    "  causeMessage: '',",
    "  relativePath: 'projects/.DS_Store',",
    "  displayMessage: 'native_setup_json_invalid (native_setup_json_invalid)'",
    '}',
    '[2026-10-05 10:00:02.000] [info]  next',
  ].join('\n');
  assert.deepEqual(parseStartupFailures(log), [{ kind: 'startup', code: 'native_setup_json_invalid', relativePath: 'projects/.DS_Store' }]);
  assert.deepEqual(parseStartupFailures('[electron] deferred OpenCode startup failed { "code": "native_runtime_failed" }'),
    [{ kind: 'deferred-runtime', code: 'native_runtime_failed', relativePath: null }]);
  assert.deepEqual(parseStartupFailures('[2026-10-05 10:00:00.000] [info] [electron] started'), []);
});

test('seed skip summary is parsed from the importer warning', () => {
  assert.deepEqual(parseSeedSkipSummary('[native-setup] seed skipped 3 setup entries (excluded=2, unreadable=1): a/node_modules, b/.git, c'),
    { count: 3, reasons: { excluded: 2, unreadable: 1 }, sample: ['a/node_modules', 'b/.git', 'c'] });
  assert.equal(parseSeedSkipSummary('nothing'), null);
});

test('bundled-runtime offer mirrors the Providers page parser and states why', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.deepEqual(classifyBundledRuntimeOffer({ status: 200, body: { state: 'upgrade_available', revision: 1, bundleID: 'default-native',
    selectedManifestSha256: a, availableManifestSha256: b } }), { offered: true, restartRequired: false, reason: 'candidate_manifest_differs_from_selected',
    state: 'upgrade_available', revision: 1, bundleID: 'default-native', selectedManifestSha256: a, availableManifestSha256: b });
  assert.equal(classifyBundledRuntimeOffer({ status: 200, body: { state: 'ready', revision: 1, selectedManifestSha256: a, availableManifestSha256: a } }).reason,
    'candidate_manifest_matches_selected');
  assert.equal(classifyBundledRuntimeOffer({ status: 200, body: { state: 'ready', revision: 1, selectedManifestSha256: a, updateReason: 'bundle_candidate_artifact_invalid' } }).reason,
    'candidate_unavailable:bundle_candidate_artifact_invalid');
  assert.equal(classifyBundledRuntimeOffer({ status: 403, body: { code: 'bundle_administrator_required' } }).reason, 'http_403:bundle_administrator_required');
  assert.equal(classifyBundledRuntimeOffer({ status: 200, body: { state: 'ready', revision: -1, selectedManifestSha256: a } }).reason, 'status_invalid');
  assert.equal(classifyBundledRuntimeOffer(undefined).offered, false);
});

test('survivor sweep matches command lines without retaining them', () => {
  const ps = ['  10 /usr/bin/node runner.mjs', '  11 /qa/runtime/home/bin/helper --x', '  12 /pkg/app/DevRyan QA.app/Contents/MacOS/DevRyan QA --flag',
    '  13 /qa/runtime/thing', 'garbage'].join('\n');
  assert.deepEqual(findProcessesMatching(ps, [{ label: 'private-root', value: '/qa/runtime' }, { label: 'packaged-app', value: '/pkg/app/DevRyan QA.app' }], [13]),
    [{ pid: 11, matched: ['private-root'] }, { pid: 12, matched: ['packaged-app'] }]);
});

test('package evidence must be inside this checkout or its main worktree', () => {
  assert.equal(resolvePackageRepositoryRoot('/main/.cache/qa/p/package-evidence.json', ['/main/.cache/worktrees/w', '/main']), '/main');
  assert.equal(resolvePackageRepositoryRoot('/main/.cache/worktrees/w/.cache/qa/p.json', ['/main/.cache/worktrees/w', '/main']), '/main/.cache/worktrees/w');
  assert.throws(() => resolvePackageRepositoryRoot('/elsewhere/p.json', ['/main']), error => error.code === 'qa_first_launch_package_outside_repository');
});

test('--shell-exports writes the four v1-era exports into every private ZDOTDIR rc file, readable by a real login shell', async () => {
  assert.deepEqual(SHELL_EXPORTS, { OPENCODE_BINARY: '/opt/homebrew/bin/opencode', OPENCODE_HOST: 'http://127.0.0.1:4096',
    OPENCODE_SKIP_START: 'true', DEVRYAN_RUNTIME_BUNDLE_ROOT: '/nonexistent' });
  const files = buildShellExportRcFiles();
  assert.deepEqual([...files.keys()], ['.zshenv', '.zprofile', '.zshrc']);
  for (const text of files.values()) {
    for (const line of ['export OPENCODE_BINARY=/opt/homebrew/bin/opencode', 'export OPENCODE_HOST=http://127.0.0.1:4096',
      'export OPENCODE_SKIP_START=true', 'export DEVRYAN_RUNTIME_BUNDLE_ROOT=/nonexistent']) assert.ok(text.split('\n').includes(line), line);
  }
  assert.throws(() => buildShellExportRcFiles({ OPENCODE_HOST: 'x; rm -rf ~' }), /Unsafe/);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devryan-first-launch-rc-')));
  try {
    const shellConfig = firstLaunchLayout(root).shellConfig;
    assert.deepEqual(await writeShellExportRcFiles(shellConfig), ['.zshenv', '.zprofile', '.zshrc']);
    for (const name of files.keys()) {
      assert.equal(await readFile(path.join(shellConfig, name), 'utf8'), files.get(name));
      assert.equal((await stat(path.join(shellConfig, name))).mode & 0o777, 0o600);
    }
    await assert.rejects(writeShellExportRcFiles(shellConfig), error => error.code === 'EEXIST');
    if (existsSync('/bin/zsh')) {
      // main's probe: `$SHELL -il -c 'env -0'` with the packaged QA host's ZDOTDIR.
      const probe = spawnSync('/bin/zsh', ['-il', '-c', 'env -0'], { env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), ZDOTDIR: shellConfig } });
      const env = Object.fromEntries(probe.stdout.toString().split('\0').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      for (const [name, value] of Object.entries(SHELL_EXPORTS)) assert.equal(env[name], value, name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shell-export grading needs every name in a [shell-env] dropped line and no values', () => {
  const main = '[2026-10-05 10:00:00.000] [info]  [shell-env] ignored login-shell variables the desktop runtime does not support: DEVRYAN_RUNTIME_BUNDLE_ROOT, OPENCODE_BINARY, OPENCODE_HOST, OPENCODE_SKIP_START';
  assert.deepEqual(gradeShellExportLog(main), { logged: ['DEVRYAN_RUNTIME_BUNDLE_ROOT', 'OPENCODE_BINARY', 'OPENCODE_HOST', 'OPENCODE_SKIP_START'], missing: [], valuesLogged: false });
  assert.deepEqual(gradeShellExportLog('[info] [shell-env] server ignored login-shell variables the runtime does not support: OPENCODE_HOST\n[info] other OPENCODE_BINARY').missing,
    ['DEVRYAN_RUNTIME_BUNDLE_ROOT', 'OPENCODE_BINARY', 'OPENCODE_SKIP_START']);
  assert.equal(gradeShellExportLog('[shell-env] ignored login-shell variables: OPENCODE_HOST=http://127.0.0.1:4096').valuesLogged, true);
  assert.deepEqual(gradeShellExportLog('').missing.length, 4);
});
