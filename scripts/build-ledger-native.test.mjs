// The native ledger workspace's contract, with no Rust toolchain: its files,
// its locked dependencies, the test-only probe, where every unsafe block may
// live, the build script's private environment, and the shared atomic-file
// specification run against the JavaScript alone. The comparison with the
// Rust runs in the build script's --verify (fast validate and CI), which
// needs the pinned toolchain.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LINUX_LINT_COMMANDS, LINUX_LINT_TARGET, PROBE_BUILD_ARGS, VERIFY_COMMANDS, WORKSPACE_DIR, WORKSPACE_FILE_RULES, cargoEnvironment, linuxLintPlan, treeFiles } from './ledger-native/workspace.mjs';
import { scratchParent } from './qa/run-root.mjs';
import { NOT_RESTATED, RESTATED, SCENARIOS, runJavaScript, scenarioRoot } from './ledger-native/atomic-spec.mjs';
import { LEDGER_NATIVE_INPUTS, isLedgerNativeInput } from './ledger-native/inputs.mjs';
import { electronBinary } from './ledger-native/reference-runtime.mjs';
import { buildPlan } from './validate.mjs';
import { DIFFERENTIAL_TESTS, EXTENDED_TESTS } from './build-ledger-native.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(repositoryRoot, WORKSPACE_DIR);
const read = (file) => readFileSync(path.join(workspace, file), 'utf8');
const parent = scratchParent('ledger-native');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(path.join(parent, 'contract-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Repository-relative files a module loads: static imports, `--import=./…`
 * arguments it passes on, literal dynamic imports of scripts, and the files
 * it starts or reads by path (`path.join(here, '…', 'x.mjs')`, the arms, the
 * workers and the interposer source). A product module behind a dynamic
 * import is left out: in this closure only the isolation guard has those, in
 * a canary the verify never calls.
 */
function localLoads(file) {
  const text = readFileSync(path.join(repositoryRoot, file), 'utf8');
  const resolve = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const loads = [];
  for (const match of text.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g)) loads.push(resolve(match[1] ?? match[2]));
  for (const match of text.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const target = resolve(match[1]);
    if (!target.startsWith('packages/')) loads.push(target);
  }
  for (const match of text.matchAll(/--import=\.\/([^'"\s]+)/g)) loads.push(path.posix.normalize(match[1]));
  for (const match of text.matchAll(/\bpath\.(?:join|resolve)\(\s*here\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*\.(?:mjs|cjs|js|c)')\s*\)/g)) {
    loads.push(resolve([...match[1].matchAll(/'([^']*)'/g)].map((part) => part[1]).join('/')));
  }
  return loads;
}

/** Every repository file the verify loads from its entry points; a product module is reached but not followed. */
function verifyClosure(entries) {
  const reached = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (reached.has(file)) continue;
    reached.add(file);
    if (file.startsWith('packages/')) continue;
    queue.push(...localLoads(file));
  }
  return [...reached].sort();
}

/** `[[package]]` entries of a Cargo.lock: name, version, source and checksum. */
function lockedPackages(text) {
  return text.split('[[package]]').slice(1).map((block) => Object.fromEntries(
    [...block.matchAll(/^(name|version|source|checksum) = "([^"]*)"$/gm)].map((match) => [match[1], match[2]])));
}

describe('native ledger workspace contract', () => {
  test('holds only manifests, the lockfile, the ignore file and Rust sources; no toolchain file of its own', () => {
    const stray = treeFiles(workspace).filter((file) => !WORKSPACE_FILE_RULES.some((rule) => rule.test(file)));
    assert.deepEqual(stray, [], `${WORKSPACE_DIR} holds files outside its rules`);
    assert.ok(treeFiles(workspace).includes('Cargo.lock'), 'the lockfile is tracked');
  });

  test('locks exactly ledger-io, ledger-core, the pinned crates and their dependencies, each registry crate with a checksum', () => {
    const packages = lockedPackages(read('Cargo.lock'));
    // libc for the system calls; sha1, sha2 and miniz_oxide for the object
    // database (research file 28, section 6), with their own dependencies.
    assert.deepEqual(packages.map((entry) => entry.name).sort(), ['adler2', 'block-buffer', 'cfg-if', 'cpufeatures', 'crypto-common', 'digest', 'hybrid-array',
      'ledger-core', 'ledger-io', 'libc', 'miniz_oxide', 'sha1', 'sha2', 'typenum']);
    for (const crate of ['libc', 'sha1', 'sha2', 'miniz_oxide']) {
      const pin = new RegExp(`^${crate} = (?:"=([0-9.]+)"|\\{ version = "=([0-9.]+)"[^}]*\\})$`, 'm').exec(read('ledger-io/Cargo.toml'));
      assert.ok(pin, `ledger-io pins ${crate} exactly (${crate} = "=x.y.z")`);
      assert.equal(packages.find((entry) => entry.name === crate).version, pin[1] ?? pin[2]);
    }
    for (const entry of packages.filter((item) => !item.name.startsWith('ledger-'))) {
      assert.equal(entry.source, 'registry+https://github.com/rust-lang/crates.io-index', entry.name);
      assert.match(entry.checksum ?? '', /^[0-9a-f]{64}$/, entry.name);
    }
    assert.match(read('ledger-io/Cargo.toml'), /^ledger-core = \{ path = "\.\.\/\.\.\/ledger-core" \}$/m);
  });

  test('the probe is test-only: built only with the probe feature, which the library never reads', () => {
    const manifest = read('ledger-io/Cargo.toml');
    for (const probe of ['atomic-probe', 'odb-probe']) {
      assert.match(manifest, new RegExp(`\\[\\[bin\\]\\]\\nname = "${probe}"\\npath = "src\\/bin\\/${probe}\\.rs"\\nrequired-features = \\["probe"\\]`));
    }
    for (const file of treeFiles(workspace).filter((name) => name.startsWith('ledger-io/src/') && !name.includes('/bin/'))) {
      assert.doesNotMatch(read(file), /feature\s*=\s*"probe"/, `${file} reads the probe feature`);
    }
  });

  test('every unsafe block is in ledger-io/src/fs.rs; the other modules forbid unsafe code', () => {
    const offenders = [];
    for (const file of treeFiles(workspace).filter((name) => name.endsWith('.rs') && name !== 'ledger-io/src/fs.rs')) {
      const code = read(file).replace(/\/\/.*$/gm, '').replace(/forbid\(unsafe_code\)/g, '');
      if (/\bunsafe\b/.test(code)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
    for (const module of ['atomic', 'path', 'git/mod', 'git/odb/mod', 'git/odb/config', 'git/odb/delta', 'git/odb/inflate', 'git/odb/loose', 'git/odb/pack', 'git/odb/refs', 'git/odb/repo', 'git/odb/walk', 'git/odb/write']) {
      assert.match(read(`ledger-io/src/${module}.rs`), /^#!\[forbid\(unsafe_code\)\]$/m, module);
    }
  });

  test('cargo runs locked, with a private home and target directory and no inherited cargo settings', () => {
    for (const args of [...VERIFY_COMMANDS.slice(1), PROBE_BUILD_ARGS]) assert.ok(args.includes('--locked') && args.includes('--offline'), args.join(' '));
    const located = { bin: '/toolchain/bin' };
    const env = cargoEnvironment({ located, toolchain: { channel: '1.99.1' }, scratch: '/tmp/x', environment: { PATH: '/usr/bin', CARGO_HOME: '/home/me/.cargo', RUSTFLAGS: '-Cfoo', HOME: '/home/me' } });
    assert.equal(env.CARGO_HOME, '/tmp/x/cargo-home');
    assert.equal(env.CARGO_TARGET_DIR, '/tmp/x/target');
    assert.equal(env.RUSTUP_TOOLCHAIN, '1.99.1');
    assert.equal(env.RUSTFLAGS, undefined);
    assert.equal(env.PATH, `/toolchain/bin${path.delimiter}/usr/bin`);
  });

  test('the shared specification restates every in-scope case of the JavaScript test file', () => {
    const source = readFileSync(path.join(repositoryRoot, 'packages/harness-runtime/lib/atomic-file.test.js'), 'utf8');
    const titles = [...source.matchAll(/test(?:\.skipIf\([^)]*\))?\(\s*'([^']+)'/g)].map((match) => match[1]).sort();
    assert.equal(titles.length, RESTATED.length + NOT_RESTATED.length);
    assert.deepEqual([...RESTATED, ...NOT_RESTATED].map((entry) => entry.source).sort(), titles);
    assert.equal(new Set(SCENARIOS.map((scenario) => scenario.name)).size, SCENARIOS.length, 'scenario names are unique');
  });

  test('every local file the verify and its differential tests load reruns them in validate and in both CI steps', () => {
    // What the verify runs: the build script and the differential tests it starts, which start their arms, workers and fixtures by path.
    // The extended run's own files are not entries: a change to them, or to what only they load, does not rerun the gate.
    const entries = ['scripts/build-ledger-native.mjs', ...DIFFERENTIAL_TESTS];
    const closure = verifyClosure(entries);
    for (const started of ['scripts/ledger-native/atomic-js-arm.mjs', 'scripts/ledger-native/atomic-js-worker.mjs', 'scripts/ledger-native/odb-js-arm.mjs']) assert.ok(closure.includes(started), `the closure misses ${started}, started by path`);
    for (const extended of EXTENDED_TESTS) assert.ok(!closure.includes(extended), `${extended} is the extended run's, not the gate's`);
    for (const file of closure) assert.ok(existsSync(path.join(repositoryRoot, file)), `${file} is loaded but missing`);
    for (const required of ['packages/harness-runtime/lib/atomic-file.js', 'scripts/qa/run-root.mjs', 'scripts/test-isolation-preload.mjs', 'scripts/build-ledger-core.mjs']) assert.ok(closure.includes(required), `the closure misses ${required}`);
    assert.deepEqual(closure.filter((file) => !isLedgerNativeInput(file)), [], 'loaded by the verify but not in LEDGER_NATIVE_INPUTS (scripts/ledger-native/inputs.mjs)');
    // No input is stale: each names a file or directory that exists, and each single file is one the verify loads.
    for (const input of LEDGER_NATIVE_INPUTS) assert.ok(existsSync(path.join(repositoryRoot, input)), `${input} is listed but missing`);
    assert.deepEqual(LEDGER_NATIVE_INPUTS.filter((input) => !input.endsWith('/') && !closure.includes(input)), [], 'listed in LEDGER_NATIVE_INPUTS but not loaded by the verify');
    for (const file of [...closure, `${WORKSPACE_DIR}/ledger-io/src/new.rs`, 'packages/harness-runtime/native/ledger-core/src/lib.rs']) {
      assert.ok(buildPlan('fast', [file]).commands.some((command) => command.label === 'ledger-native'), `fast validate does not run the native ledger verify for ${file}`);
    }
    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    const steps = workflow.split(/\n(?=\s*- name: )/).filter((step) => /- name: Rust native ledger I\/O/.test(step));
    assert.equal(steps.length, 2, 'ci.yml runs the native ledger verify on Ubuntu and on macOS');
    for (const step of steps) {
      assert.match(step, /paths="\$\(node scripts\/ledger-native\/inputs\.mjs\) \.github\/workflows\/ci\.yml"/, 'the CI filter prints LEDGER_NATIVE_INPUTS');
      assert.match(step, /node scripts\/build-ledger-native\.mjs --verify/);
    }
    assert.match(steps.find((step) => step.includes('on macOS')), /matrix\.lane == 'native-1'/);
  });

  test('the Linux lint runs where the target is installed, is native on x86_64 Linux and says when it cannot run', () => {
    assert.ok(LINUX_LINT_COMMANDS.every((args) => args.includes('--locked') && args.includes('--offline') && args.includes(LINUX_LINT_TARGET)));
    assert.deepEqual(LINUX_LINT_COMMANDS.map((args) => args[0]), ['check', 'clippy']);
    assert.deepEqual(LINUX_LINT_COMMANDS[1].slice(-3), ['--', '-D', 'warnings']);
    const plan = (platform, arch, installed) => linuxLintPlan({ toolchainHome: '/t', channel: '1.99.1', platform, arch, exists: (file) => installed && file === `/t/lib/rustlib/${LINUX_LINT_TARGET}/lib` });
    assert.equal(plan('darwin', 'arm64', true).action, 'lint');
    assert.equal(plan('linux', 'x64', false).action, 'native');
    assert.equal(plan('darwin', 'arm64', false).action, 'missing');
    assert.match(plan('darwin', 'arm64', false).line, new RegExp(`no ${LINUX_LINT_TARGET} target`));
  });

  test('the reference runtime is the binary the electron package names, and only an absent one falls back', () => {
    assert.deepEqual(electronBinary({ load: () => '/e/Electron', exists: () => true }), { binary: '/e/Electron', reason: null });
    assert.match(electronBinary({ load: () => '/e/Electron', exists: () => false }).reason, /absent/);
    assert.match(electronBinary({ load: () => { throw new Error('not installed'); } }).reason, /not installed/);
  });

  for (const scenario of SCENARIOS) {
    test(`the JavaScript meets the specification: ${scenario.name}`, () => {
      const { root, remove } = scenarioRoot(scratch, 'js');
      try { scenario.expect(runJavaScript(scenario, root)); } finally { remove(); }
    });
  }
});
