import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveStartupSplashPalette, withStartupSplashPalette } from '../startup-splash.mjs';
import { restartSupabaseHost } from '../supabase-host-restart.mjs';
import { finishQuitAfterCleanup } from '../quit-cleanup.mjs';
import { setDevRyanEnv } from '../../shared-runtime/lib/legacy-environment.js';

const repository = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const mainSource = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');
const bindingSpecifier = '@devryan/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
const dataRootUrl = new URL('../../shared-runtime/lib/data-root.js', import.meta.url).href;

// Keep the emitted import form intact: a static external import executes before
// even a textually earlier capture, including when the other code was inlined.
function bootstrapProbe(source, bindingUrl, failed = false, preview = false) {
  const start = source.search(/^(?:const|var) hostDataRootDirectory\s*=/m);
  const end = source.search(/^(?:const|var) shellRuntimeBundleBinding\s*=/m);
  assert.ok(start >= 0 && end > start, 'The shell bootstrap must remain identifiable');
  const capture = source.slice(start, end);
  const pathAlias = capture.match(/=\s*([\w$]+)\.resolve\(/)?.[1];
  const osAlias = capture.match(/([\w$]+)\.homedir\(\)/)?.[1];
  // The real data-root resolver, under whatever name the source or bundle uses.
  const resolverAlias = capture.match(/\.resolve\(\s*([\w$]+)\(\{/)?.[1];
  assert.ok(pathAlias && osAlias && resolverAlias, 'The capture resolves the shared data root');
  const staticBindingImports = source.split('\n').filter(line => (
    /^import\s/.test(line) && line.includes(bindingSpecifier)
  ));
  const importsAndCapture = [...staticBindingImports, capture].join('\n');
  assert.ok(importsAndCapture.includes(bindingSpecifier), 'Execute the real binding import');
  return `import ${pathAlias} from 'node:path';
import ${osAlias} from 'node:os';
import { resolveDevRyanDataRoot as ${resolverAlias} } from ${JSON.stringify(dataRootUrl)};
const isRuntimeServiceControlProbe=false;
const isPreview=${preview};
${importsAndCapture.replaceAll(bindingSpecifier, bindingUrl)}
process.stdout.write(JSON.stringify({ hostRoot: hostDataRootDirectory, selectedRoot: process.env.DEVRYAN_DATA_DIR${failed ? ', code:shellRuntimeBundleBindingError?.code' : ''} }));
`;
}

test('source and packaged ESM capture the shell root before bundle binding changes the environment', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-electron-bundle-bootstrap-'));
  try {
    const outdir = path.join(fixture, 'bundle');
    const build = spawnSync('bun', ['packages/electron/scripts/bundle-main.mjs', '--outdir', outdir], {
      cwd: repository, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    assert.equal(build.signal, null);
    const bundledSource = await fs.readFile(path.join(outdir, 'main.mjs'), 'utf8');
    const binding = path.join(fixture, 'binding.mjs');
    await fs.writeFile(binding, `process.env.DEVRYAN_DATA_DIR = process.env.DEVRYAN_TEST_SELECTED_DATA_ROOT;
export const readRuntimeBundleBinding = () => null;
`);
    const home = path.join(fixture, 'home');
    const selectedRoot = path.join(fixture, 'retained-bundle', 'web-data');
    for (const [label, source] of [['source', mainSource], ['packaged', bundledSource]]) {
      const probe = path.join(fixture, `${label}.mjs`);
      await fs.writeFile(probe, bootstrapProbe(source, pathToFileURL(binding).href));
      // A pre-rename folder that still holds the data (migration deferred or
      // impossible) stays the host root; otherwise the default is ~/.config/devryan.
      const legacyHome = path.join(fixture, 'legacy-home');
      await fs.mkdir(path.join(legacyHome, '.config', 'openchamber'), { recursive: true });
      for (const mode of ['configured', 'default', 'legacy']) {
        await t.test(`${label}: ${mode}`, () => {
          const probeHome = mode === 'legacy' ? legacyHome : home;
          const hostRoot = mode === 'configured' ? path.join(fixture, 'shell-data')
            : path.join(probeHome, '.config', mode === 'legacy' ? 'openchamber' : 'devryan');
          const result = spawnSync(process.execPath, [probe], {
            cwd: fixture, encoding: 'utf8', timeout: 10_000,
            env: { HOME: probeHome, PATH: process.env.PATH, DEVRYAN_TEST_SELECTED_DATA_ROOT: selectedRoot,
              ...(mode === 'configured' ? { DEVRYAN_DATA_DIR: hostRoot } : {}) },
          });
          assert.equal(result.status, 0, result.stderr || result.error?.message);
          assert.equal(result.signal, null);
          assert.deepEqual(JSON.parse(result.stdout), { hostRoot, selectedRoot });
        });
      }
      const brokenBinding = path.join(fixture, `${label}-broken-binding.mjs`);
      await fs.writeFile(brokenBinding, "throw new Error('private fixture must not escape');\n");
      const brokenProbe = path.join(fixture, `${label}-broken.mjs`);
      await fs.writeFile(brokenProbe, bootstrapProbe(source, pathToFileURL(brokenBinding).href, true));
      const result = spawnSync(process.execPath, [brokenProbe], { cwd: fixture, encoding: 'utf8', timeout: 10_000,
        env: { HOME: home, PATH: process.env.PATH } });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), { hostRoot: path.join(home, '.config', 'devryan'), code: 'runtime_bundle_binding_invalid' });
      assert.equal(result.stderr, '');
      await t.test(`${label}: preview excludes native binding`, async () => {
        const previewRoot = path.join(fixture, 'preview-data');
        const previewProbe = path.join(fixture, `${label}-preview.mjs`);
        // A broken binding would throw if preview accidentally imported it.
        await fs.writeFile(previewProbe, bootstrapProbe(source, pathToFileURL(brokenBinding).href, true, true));
        const previewResult = spawnSync(process.execPath, [previewProbe], { cwd: fixture, encoding: 'utf8', timeout: 10_000,
          env: { HOME: home, PATH: process.env.PATH, DEVRYAN_DATA_DIR: previewRoot } });
        assert.equal(previewResult.status, 0, previewResult.stderr || previewResult.error?.message);
        assert.equal(previewResult.signal, null);
        assert.deepEqual(JSON.parse(previewResult.stdout), { hostRoot: previewRoot, selectedRoot: previewRoot });
        assert.equal(previewResult.stderr, '');
      });
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('held recovery navigation stays canonical for existing and newly created windows', async () => {
  const start = mainSource.indexOf('const activateMainWindow = async (url, localOrigin, bootOutcome) => {');
  const end = mainSource.indexOf('const createAdditionalWindow = async (url) => {', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const activate = new AsyncFunction('owners', 'url', 'origin', `
    const { state, runtimeBundleRecoveryRequired, buildInitScript, currentStartupSplashPalette,
      withStartupSplashPalette, navigateWindow, createBrowserWindow } = owners;
    ${mainSource.slice(start, end)}
    return activateMainWindow(url, origin, null);
  `);
  const origin = 'http://127.0.0.1:3000', url = origin + '/';
  const palette = resolveStartupSplashPalette({ themeMode: 'dark' }, true);
  for (const held of [true, false]) for (const existing of [true, false]) {
    let navigatedUrl;
    const window = { isDestroyed: () => false, setBackgroundColor: () => {}, show: () => {}, focus: () => {} };
    const state = { mainWindow: existing ? window : null };
    await activate({
      state, runtimeBundleRecoveryRequired: held, buildInitScript: () => '',
      currentStartupSplashPalette: () => palette, withStartupSplashPalette,
      navigateWindow: async (target, nextUrl) => { assert.equal(target, window); navigatedUrl = nextUrl; },
      createBrowserWindow: options => { navigatedUrl = options.url; return window; },
    }, url, origin);
    assert.equal(state.mainWindow, window);
    assert.equal(navigatedUrl, held ? url : withStartupSplashPalette(url, origin, palette), `held=${held}, existing=${existing}`);
  }
});

function relaunchCallback(environment, relaunch, originalBundleRoot) {
  const start = mainSource.indexOf('const relaunchWithHostDataRoot = () => {');
  const end = mainSource.indexOf('const firstExistingPath =', start);
  assert.ok(start >= 0 && end > start);
  return new Function('app', 'process', 'hostDataRootDirectory', 'hostRuntimeBundleRoot', 'setDevRyanEnv', `
    ${mainSource.slice(start, end)}
    return relaunchWithHostDataRoot;
  `)({ relaunch }, { env: environment }, '/fixture/shell-data', originalBundleRoot, setDevRyanEnv);
}

test('relaunch inherits the shell root and always restores the current parent environment', () => {
  for (const selectedRoot of ['/fixture/retained-bundle/web-data', undefined]) for (const fails of [false, true]) {
    const environment = selectedRoot === undefined ? {} : { DEVRYAN_DATA_DIR: selectedRoot };
    let inherited;
    const relaunch = relaunchCallback(environment, () => {
      inherited = environment.DEVRYAN_DATA_DIR;
      assert.equal(environment.OPENCHAMBER_DATA_DIR, environment.DEVRYAN_DATA_DIR, 'The relaunch alias matches');
      if (fails) throw new Error('fixture relaunch failed');
    });
    if (fails) assert.throws(relaunch, /fixture relaunch failed/);
    else relaunch();
    assert.equal(inherited, '/fixture/shell-data');
    assert.deepEqual(environment, selectedRoot === undefined ? {} : { DEVRYAN_DATA_DIR: selectedRoot });
  }
  assert.equal(mainSource.match(/app\.relaunch\(\)/g)?.length, 1, 'All existing callbacks use the root-preserving handoff');
  assert.equal(mainSource.match(/relaunch:\s*(?:restart \? )?relaunchWithHostDataRoot/g)?.length, 3);
});

test('strict host restart hands off the shell root only after drain and release succeed', async () => {
  for (const failure of [null, 'drain', 'release']) for (const serviceMode of [false, true]) {
    const environment = { DEVRYAN_DATA_DIR: '/fixture/retained-bundle/web-data' }, calls = [];
    const selected = () => assert.equal(environment.DEVRYAN_DATA_DIR, '/fixture/retained-bundle/web-data');
    const operation = restartSupabaseHost({
      handle: { stop: async () => { selected(); calls.push('drain'); if (failure === 'drain') throw Error('fixture drain failed'); } },
      coordinator: { release: async () => { selected(); calls.push('release'); if (failure === 'release') throw Error('fixture release failed'); } },
      serviceMode, onStopped: () => { selected(); calls.push('stopped'); },
      relaunch: relaunchCallback(environment, () => { assert.equal(environment.DEVRYAN_DATA_DIR, '/fixture/shell-data'); calls.push('relaunch'); }),
      exit: code => { selected(); calls.push(`exit:${code}`); },
    });
    if (failure) await assert.rejects(operation, new RegExp(`fixture ${failure} failed`));
    else await operation;
    selected();
    assert.deepEqual(calls, failure === 'drain' ? ['drain'] : failure === 'release' ? ['drain', 'release']
      : ['drain', 'release', 'stopped', ...(serviceMode ? ['exit:1'] : ['relaunch', 'exit:0'])]);
  }
});

test('bounded ordinary restart preserves parent environment even while timed-out cleanup remains pending', async () => {
  const environment = { DEVRYAN_DATA_DIR: '/fixture/retained-bundle/web-data' }, calls = [];
  let timeout;
  const operation = finishQuitAfterCleanup({
    cleanupOwnedResources: () => { calls.push('cleanup'); return new Promise(() => {}); },
    relaunch: relaunchCallback(environment, () => { assert.equal(environment.DEVRYAN_DATA_DIR, '/fixture/shell-data'); calls.push('relaunch'); }),
    requestQuit: () => assert.fail('The pending cleanup must take the existing bounded fallback'),
    forceExit: () => { assert.equal(environment.DEVRYAN_DATA_DIR, '/fixture/retained-bundle/web-data'); calls.push('exit'); },
    scheduleTimeout: callback => { timeout = callback; return 1; }, cancelTimeout: () => {},
  });
  await Promise.resolve();
  assert.deepEqual(calls, ['cleanup']);
  assert.equal(environment.DEVRYAN_DATA_DIR, '/fixture/retained-bundle/web-data');
  timeout();
  assert.equal(await operation, 'forced');
  assert.deepEqual(calls, ['cleanup', 'relaunch', 'exit']);
});


test('Retry removes only the attempt-injected bundle root and preserves an explicit launch root', () => {
  for (const original of [undefined, '/fixture/user-selected-control']) for (const fails of [false, true]) {
    const environment = { DEVRYAN_DATA_DIR: '/fixture/selected-web', DEVRYAN_RUNTIME_BUNDLE_ROOT: '/fixture/attempt-control' };
    const parent = { ...environment };
    let inherited;
    const relaunch = relaunchCallback(environment, () => {
      inherited = { ...environment };
      if (fails) throw new Error('fixture retry failed');
    }, original);
    if (fails) assert.throws(relaunch, /fixture retry failed/);
    else relaunch();
    assert.equal(inherited.DEVRYAN_DATA_DIR, '/fixture/shell-data');
    assert.equal(inherited.DEVRYAN_RUNTIME_BUNDLE_ROOT, original);
    assert.equal(Object.hasOwn(inherited, 'DEVRYAN_RUNTIME_BUNDLE_ROOT'), original !== undefined);
    assert.deepEqual(environment, parent);
  }
});
