import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { build } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const runtimeCopy = (resources) => resources.find((resource) => resource.from === '../web/runtime');

test('the native runtime ships once, as the revert-runtime resource', () => {
  // The packaged server resolves executables from Resources/revert-runtime only
  // (packages/web/server/lib/opencode/execution-artifacts.js). A second copy inside
  // app.asar.unpacked added ~470 MB installed and ~165 MB to the DMG.
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.ok(build.files.includes(`!node_modules/@devryan/web/runtime/${platform}-*{,/**}`), platform);
  }
  // reviewed-inputs are build inputs of that runtime (the ast-grep input alone is ~49 MB).
  assert.ok(build.files.includes('!node_modules/@devryan/web/runtime/reviewed-inputs{,/**}'));
  assert.equal(runtimeCopy(build.mac.extraResources)?.to, 'revert-runtime');
  assert.equal(runtimeCopy(build.win.extraResources)?.to, 'revert-runtime');
});

test('the web package stays unpacked without the runtime forcing it', () => {
  assert.ok(build.asarUnpack.includes('node_modules/@devryan/web/**'));
});

test('the app ships no duplicate web build, source maps, tests, sources or Linux prebuilds', () => {
  // main.mjs serves Resources/web-dist only (DEVRYAN_DIST_DIR); nothing in the app
  // loads .ts: Electron's Node refuses type stripping under node_modules, Bun cannot
  // read inside app.asar and the runtime-host sources are compiled into revert-runtime.
  for (const pattern of ['!node_modules/@devryan/web/dist{,/**}', '!**/*.map', '!**/*.{test,spec}.*', '!**/__tests__{,/**}', '!**/*.{ts,tsx,mts,cts}']) {
    assert.ok(build.files.includes(pattern), pattern);
  }
  // Native modules load their compiled .node; no Linux app is built. Windows prebuilds
  // stay for the Windows preview package.
  for (const pattern of ['!**/*.{c,cc,cpp,h,hpp}', '!**/build/Release/obj{,/**}', '!**/prebuilds/linux-*{,/**}']) {
    assert.ok(build.files.includes(pattern), pattern);
  }
  // A platform `files` list makes electron-builder prepend `**/*`, which packs this
  // whole package directory (tests, scripts, a second web-dist) into app.asar.
  assert.equal(build.mac.files, undefined);
  assert.equal(build.win.files, undefined);
  assert.ok(build.extraResources.some((resource) => resource.from === 'resources/web-dist' && resource.to === 'web-dist'));
});

// The shell's dependencies install every macOS arch and some Windows prebuilds.
const PLATFORM_NATIVES = [
  'node_modules/@cursor/sdk-darwin-arm64/bin/rg',
  'node_modules/@cursor/sdk-darwin-x64/bin/rg',
  'node_modules/@ff-labs/fff-bin-darwin-arm64/fff',
  'node_modules/@ff-labs/fff-bin-darwin-x64/fff',
  'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node',
  'node_modules/@lydell/node-pty-darwin-x64/prebuilds/darwin-x64/pty.node',
  'node_modules/node-pty/bin/darwin-arm64-145/node-pty.node',
  'node_modules/node-pty/bin/darwin-x64-145/node-pty.node',
  'node_modules/node-pty/bin/win32-x64-145/node-pty.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
  'node_modules/node-pty/prebuilds/win32-arm64/pty.node',
  'node_modules/node-pty/prebuilds/win32-x64/pty.node',
  'node_modules/tree-sitter-bash/prebuilds/win32-x64/tree-sitter-bash.node',
];
const RUNTIME_FILES = [
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/lib/windowsPtyAgent.js',
  'node_modules/@cursor/sdk/dist/darwin-sandbox.js',
  'node_modules/@devryan/web/server/lib/win32-paths.js',
];

/** Paths electron-builder's own node-module matcher keeps for a target. */
const packedFor = (os, arch, files = [...PLATFORM_NATIVES, ...RUNTIME_FILES]) => {
  const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
  const { FileMatcher } = builderRequire('app-builder-lib/out/fileMatcher.js');
  const { expandMacro } = builderRequire('app-builder-lib/out/util/macroExpander.js');
  const excludes = build.files.filter((pattern) => typeof pattern === 'string' && pattern.startsWith('!'));
  const matcher = new FileMatcher('/app', '/out', (pattern) => expandMacro(pattern, arch, { productName: 'DevRyan' }, { os }), ['**/*', ...excludes]);
  const keep = matcher.createFilter();
  const stat = { isDirectory: () => false };
  return files.filter((file) => keep(`/app/${file}`, stat));
};

test('packages omit vendored OpenAPI documents and captured test vectors but keep runtime routes', () => {
  const root = 'node_modules/@devryan/web/server/lib/opencode/v2';
  const runtime = [`${root}/routes.generated.js`, `${root}/openapi-routes.js`, `${root}/route-policy.js`];
  const files = [...runtime, `${root}/openapi-2.2.2.json`, `${root}/openapi-2.0.20.json`,
    `${root}/__vectors__/openapi.json`, `${root}/__vectors__/01-two-step-tool-turn.json`];
  for (const [os, arch] of [['mac', 'arm64'], ['mac', 'x64'], ['win', 'x64']]) {
    assert.deepEqual(packedFor(os, arch, files), runtime);
  }
});

test('each package ships only its own platform and arch natives', () => {
  // `${os}` and `${arch}` are the target's, so the Windows preview keeps its
  // prebuilds and x64 Mac builds keep theirs; a platform `files` list is not used.
  assert.deepEqual(packedFor('mac', 'arm64'), [
    'node_modules/@cursor/sdk-darwin-arm64/bin/rg',
    'node_modules/@ff-labs/fff-bin-darwin-arm64/fff',
    'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node',
    'node_modules/node-pty/bin/darwin-arm64-145/node-pty.node',
    'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    ...RUNTIME_FILES,
  ]);
  assert.deepEqual(packedFor('mac', 'x64'), [
    'node_modules/@cursor/sdk-darwin-x64/bin/rg',
    'node_modules/@ff-labs/fff-bin-darwin-x64/fff',
    'node_modules/@lydell/node-pty-darwin-x64/prebuilds/darwin-x64/pty.node',
    'node_modules/node-pty/bin/darwin-x64-145/node-pty.node',
    'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    ...RUNTIME_FILES,
  ]);
  assert.deepEqual(packedFor('win', 'x64'), [
    'node_modules/node-pty/bin/win32-x64-145/node-pty.node',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    'node_modules/tree-sitter-bash/prebuilds/win32-x64/tree-sitter-bash.node',
    ...RUNTIME_FILES,
  ]);
});

test('afterPack checks packaged content before signing', () => {
  const source = fs.readFileSync(new URL('../scripts/adhoc-sign-macos-app.mjs', import.meta.url), 'utf8');
  assert.equal(build.afterPack, './scripts/adhoc-sign-macos-app.mjs');
  assert.match(source, /await assertPackagedApp\(\{ appPath, arch: resolvePackagedMacArch\(context\.arch\) \}\)/);
});
