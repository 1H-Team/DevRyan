#!/usr/bin/env node
// Builds, lints and tests the native ledger's Rust workspace
// (packages/harness-runtime/native/ledger: the crates ledger-io and
// ledger-native, whose binary is devryan-ledger), which nothing in the
// product calls yet. The toolchain is the ledger core's pin, selected
// through RUSTUP_TOOLCHAIN; every cargo command runs with --locked on a copy
// of the workspace and of the ledger-core crate it depends on, under the OS
// temp dir, with a private CARGO_HOME and target directory there (removed
// afterwards unless --keep-artifacts). The dependencies are fetched once per
// run with `cargo fetch --locked` (checksums from the tracked Cargo.lock);
// everything after that is --offline. When the developer's own cargo cache
// already holds every locked crate (its checksum checked against Cargo.lock)
// and its index entry, they are copied into the private CARGO_HOME first and
// the fetch runs --offline too, so a local run needs no network; a cold
// runner finds nothing there and fetches as before.
//
//   node scripts/build-ledger-native.mjs            build the workspace, the test-only probes and devryan-ledger
//   node scripts/build-ledger-native.mjs --verify   cargo fmt --check, clippy -D warnings, cargo test,
//                                                   cargo check and clippy for x86_64 Linux when that
//                                                   target is installed, the licence gate (and RustSec
//                                                   advisories when cargo-deny is on PATH), then the Node
//                                                   differential tests against the probes and the two
//                                                   devryan-ledger builds (JavaScript on the Node inside
//                                                   Electron where its binary exists)
//   node scripts/build-ledger-native.mjs --extended the verify, then the long run outside the gate:
//                                                   all the fuzz rounds and the ledgers the product
//                                                   writes (the aged-profile corpus and every dual-run
//                                                   scenario); it fails, never skips, without Electron's
//                                                   Node, the Linux target or a scenario
//
// packages/harness-runtime/DOCUMENTATION.md ("Native ledger I/O") describes
// the workspace; the Rust-free contract is this script's test.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CRATE_DIR as CORE_DIR, ancestorCargoConfigs, locateToolchain, readToolchainFile } from './build-ledger-core.mjs';
import { keepArtifactsRequested, scratchParent } from './qa/run-root.mjs';
import { checkLicences } from './ledger-native/licences.mjs';
import { referenceRuntime } from './ledger-native/reference-runtime.mjs';
import {
  LEDGER_BUILD_ARGS, LEDGER_HOOKS_BUILD_ARGS, LEDGER_HOOKS_VARIABLE, LEDGER_PROBE_VARIABLE, LEDGER_VARIABLE, LINUX_LINT_COMMANDS,
  ODB_PROBE_VARIABLE, PROBE_BUILD_ARGS, PROBE_VARIABLE, VERIFY_COMMANDS, WORKSPACE_DIR, cargoEnvironment, linuxLintPlan, treeFiles,
} from './ledger-native/workspace.mjs';

export { LEDGER_HOOKS_VARIABLE, LEDGER_PROBE_VARIABLE, LEDGER_VARIABLE, ODB_PROBE_VARIABLE, PROBE_VARIABLE };
/** The Node differential tests the verify runs against the probes and devryan-ledger, and the porting lint. */
export const DIFFERENTIAL_TESTS = Object.freeze([
  'scripts/ledger-native/atomic-differential.mjs',
  'scripts/ledger-native/odb-differential.mjs',
  'scripts/ledger-native/codec-differential.mjs',
  'scripts/ledger-native/ctx-differential.mjs',
  'scripts/ledger-native/jobs-differential.mjs',
  'scripts/ledger-native/fs-differential.mjs',
  'scripts/ledger-native/child-differential.mjs',
  'scripts/ledger-native/porting-lint.mjs',
  'scripts/ledger-native/proto-differential.mjs',
]);
/** The tests only the extended run adds, and the variable that gives the differential tests their full rounds. */
export const EXTENDED_TESTS = Object.freeze(['scripts/ledger-native/odb-real-ledgers.mjs']);
export const EXTENDED_VARIABLE = 'LEDGER_NATIVE_ODB_EXTENDED';
/** Variables that would narrow the extended run; it refuses to start with one set. */
export const EXTENDED_NARROWING = Object.freeze(['LEDGER_NATIVE_ODB_SCENARIOS']);

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Copies the workspace and the ledger-core crate to `<scratch>/native/` with their relative layout. */
function copySources(root, scratch) {
  const native = path.join(scratch, 'native');
  for (const [from, to] of [[WORKSPACE_DIR, 'ledger'], [CORE_DIR, 'ledger-core']]) {
    for (const file of treeFiles(path.join(root, from))) {
      mkdirSync(path.dirname(path.join(native, to, file)), { recursive: true });
      copyFileSync(path.join(root, from, file), path.join(native, to, file));
    }
  }
  const workspace = path.join(native, 'ledger');
  const outside = ancestorCargoConfigs(workspace);
  if (outside.length) throw new Error(`Cargo configuration above the build copy would change the build: ${outside.join(', ')}`);
  return workspace;
}

/** SHA-256 of the sources the build reads (both crate trees, paths and bytes), for `ready.build`. */
export function sourceDigest(root = repositoryRoot) {
  const hash = createHash('sha256');
  for (const [from, to] of [[WORKSPACE_DIR, 'ledger'], [CORE_DIR, 'ledger-core']]) {
    for (const file of treeFiles(path.join(root, from))) {
      hash.update(`${to}/${file}\0`);
      hash.update(readFileSync(path.join(root, from, file)));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function runChecked(command, args, options, label = `${path.basename(command)} ${args.join(' ')}`) {
  console.log(`\n$ ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}`);
}

/** A private scratch directory under the OS temp dir, removed on exit and interruption unless kept. */
function createScratch(keep) {
  const parent = scratchParent('ledger-native');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(parent, 'build-'));
  const remove = () => { if (!keep) rmSync(scratch, { recursive: true, force: true }); };
  const interrupted = (signal) => { remove(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  return {
    scratch,
    dispose(failed) {
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
      if (keep) console.error(`Kept build files in ${scratch}`);
      else {
        remove();
        if (failed) console.error('Removed the build files; rerun with --keep-artifacts to keep them.');
      }
    },
  };
}

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

/** The crates.io packages of a Cargo.lock: `{ name, version, checksum }`. */
export function lockedRegistryPackages(lockText) {
  const packages = [];
  for (const block of lockText.split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(block)?.[1];
    if (field('source') === CRATES_IO && field('checksum')) packages.push({ name: field('name'), version: field('version'), checksum: field('checksum') });
  }
  return packages;
}

/** Where cargo's sparse index keeps a crate's entry (`ab/cd/abcd…`, `3/a/abc`, `2/ab`, `1/a`). */
export function indexEntryPath(name) {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return path.join(String(lower.length), lower);
  if (lower.length === 3) return path.join('3', lower[0], lower);
  return path.join(lower.slice(0, 2), lower.slice(2, 4), lower);
}

/**
 * Copies every locked crates.io crate (its `.crate` file, checked against
 * Cargo.lock's checksum, and its sparse-index entry) from the developer's
 * cargo cache into the run's private CARGO_HOME. True only when one index
 * directory had all of them; nothing is copied otherwise.
 */
export function seedCargoHome({ lockText, cargoHome, sourceHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo') }) {
  const packages = lockedRegistryPackages(lockText);
  const cacheRoot = path.join(sourceHome, 'registry', 'cache');
  if (!packages.length || !existsSync(cacheRoot)) return false;
  for (const dir of readdirSync(cacheRoot).filter((name) => /^index\.crates\.io-[0-9a-f]+$/.test(name)).sort()) {
    const index = path.join(sourceHome, 'registry', 'index', dir);
    const files = [[path.join(index, 'config.json'), path.join(cargoHome, 'registry', 'index', dir, 'config.json')]];
    const complete = existsSync(files[0][0]) && packages.every(({ name, version, checksum }) => {
      const crate = path.join(cacheRoot, dir, `${name}-${version}.crate`);
      const entry = path.join(index, '.cache', indexEntryPath(name));
      if (!existsSync(crate) || !existsSync(entry)) return false;
      if (createHash('sha256').update(readFileSync(crate)).digest('hex') !== checksum) return false;
      files.push([crate, path.join(cargoHome, 'registry', 'cache', dir, `${name}-${version}.crate`)], [entry, path.join(cargoHome, 'registry', 'index', dir, '.cache', indexEntryPath(name))]);
      return true;
    });
    if (!complete) continue;
    for (const [from, to] of files) { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); }
    return true;
  }
  return false;
}

/**
 * `cargo fetch --locked`: offline from the seeded CARGO_HOME when the
 * developer's cache holds every crate, else (or when that fails) from the
 * network, as on a cold runner.
 */
function fetchDependencies(cargo, workspace, env) {
  const seeded = seedCargoHome({ lockText: readFileSync(path.join(workspace, 'Cargo.lock'), 'utf8'), cargoHome: env.CARGO_HOME });
  if (seeded) {
    console.log('\n$ cargo fetch --locked --offline (the locked crates copied from the local cargo cache)');
    const offline = spawnSync(cargo, ['fetch', '--locked', '--offline'], { cwd: workspace, env, stdio: 'inherit' });
    if (!offline.error && offline.status === 0) return;
    console.log('The offline fetch failed; fetching from the network instead.');
  }
  runChecked(cargo, ['fetch', '--locked'], { cwd: workspace, env });
}

/** Copies the sources, fetches the locked dependencies and builds the probe; returns the cargo context. */
function prepare({ root, scratch }) {
  const toolchain = readToolchainFile(root);
  const located = locateToolchain(toolchain);
  const workspace = copySources(root, scratch);
  const env = { ...cargoEnvironment({ located, toolchain, scratch }), DEVRYAN_LEDGER_SOURCE_DIGEST: sourceDigest(root) };
  const cargo = path.join(located.bin, 'cargo');
  fetchDependencies(cargo, workspace, env);
  const debug = path.join(scratch, 'target', 'debug');
  return { cargo, workspace, env, located, toolchain, scratch, probe: path.join(debug, 'atomic-probe'), odbProbe: path.join(debug, 'odb-probe') };
}

/**
 * devryan-ledger without features (the product's shape), then with
 * test-hooks, and the ledger probe; each copied out of the target directory
 * the next build overwrites. Returns their paths.
 */
function buildLedgerIn(context) {
  const out = path.join(context.scratch, 'bin');
  mkdirSync(out, { recursive: true });
  const built = (name) => path.join(context.scratch, 'target', 'debug', name);
  runChecked(context.cargo, LEDGER_BUILD_ARGS, { cwd: context.workspace, env: context.env });
  copyFileSync(built('devryan-ledger'), path.join(out, 'devryan-ledger'));
  runChecked(context.cargo, LEDGER_HOOKS_BUILD_ARGS, { cwd: context.workspace, env: context.env });
  copyFileSync(built('devryan-ledger'), path.join(out, 'devryan-ledger-test-hooks'));
  copyFileSync(built('ledger-native-probe'), path.join(out, 'ledger-native-probe'));
  for (const name of ['devryan-ledger', 'devryan-ledger-test-hooks', 'ledger-native-probe']) spawnSync('chmod', ['755', path.join(out, name)]);
  return { plain: path.join(out, 'devryan-ledger'), hooks: path.join(out, 'devryan-ledger-test-hooks'), probe: path.join(out, 'ledger-native-probe') };
}

/** The interim licence gate over `cargo metadata --locked`, and RustSec advisories when cargo-deny is installed. */
function checkDependencies(context) {
  console.log('\n$ cargo metadata --locked --offline --format-version 1');
  const metadata = spawnSync(context.cargo, ['metadata', '--locked', '--offline', '--format-version', '1'], { cwd: context.workspace, env: context.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (metadata.status !== 0) throw new Error(`cargo metadata failed: ${metadata.stderr}`);
  const { packages, refused } = checkLicences(JSON.parse(metadata.stdout), { ownRoots: [context.workspace, path.join(path.dirname(context.workspace), 'ledger-core')] });
  for (const entry of packages) console.log(`  ${entry.name} ${entry.version}: ${entry.licence ?? '(this repository)'}`);
  if (refused.length) throw new Error(`Licences outside scripts/ledger-native/licences.mjs: ${refused.map((entry) => `${entry.name} ${entry.version} (${entry.licence})`).join(', ')}`);
  const deny = spawnSync(context.cargo, ['deny', '--version'], { cwd: context.workspace, env: context.env, encoding: 'utf8' });
  if (deny.status === 0) runChecked(context.cargo, ['deny', 'check', 'advisories'], { cwd: context.workspace, env: context.env });
  else console.log('RustSec advisories not checked: cargo-deny is not on PATH (install it with: cargo install --locked cargo-deny).');
}

function buildProbeIn(context) {
  runChecked(context.cargo, PROBE_BUILD_ARGS, { cwd: context.workspace, env: context.env });
  for (const binary of [context.probe, context.odbProbe]) if (!existsSync(binary)) throw new Error(`cargo did not produce ${binary}`);
  return context.probe;
}

/**
 * Builds the test-only probes for a test that was started without them
 * (`LEDGER_NATIVE_PROBE` or `LEDGER_NATIVE_ODB_PROBE` unset). The caller
 * disposes of the build directory.
 */
export function buildProbe({ root = repositoryRoot, keep = keepArtifactsRequested() } = {}) {
  const { scratch, dispose } = createScratch(keep);
  try {
    const context = prepare({ root, scratch });
    buildProbeIn(context);
    return { probe: context.probe, odbProbe: context.odbProbe, dispose: () => dispose(false) };
  } catch (error) {
    dispose(true);
    throw error;
  }
}

/**
 * The sources copied and the dependencies fetched once, for a caller that
 * builds variants of them (the planted-bug runner): `{ cargo, workspace, env,
 * odbProbe, build(), dispose(failed) }`.
 */
export function workspaceCopy({ root = repositoryRoot, keep = keepArtifactsRequested() } = {}) {
  const { scratch, dispose } = createScratch(keep);
  try {
    const context = prepare({ root, scratch });
    return { ...context, build: () => buildProbeIn(context), dispose };
  } catch (error) {
    dispose(true);
    throw error;
  }
}

/**
 * Builds devryan-ledger (plain and test-hooks) and the ledger probe for a
 * test started without them. The caller disposes of the build directory.
 */
export function buildLedgerBinaries({ root = repositoryRoot, keep = keepArtifactsRequested() } = {}) {
  const { scratch, dispose } = createScratch(keep);
  try {
    return { binaries: buildLedgerIn(prepare({ root, scratch })), dispose: () => dispose(false) };
  } catch (error) {
    dispose(true);
    throw error;
  }
}

export function main(argv = process.argv.slice(2), root = repositoryRoot) {
  const unknown = argv.filter((arg) => !['--verify', '--extended', '--keep-artifacts'].includes(arg));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')} (use --verify, --extended or --keep-artifacts)`);
  const extended = argv.includes('--extended');
  const verify = extended || argv.includes('--verify');
  if (extended) {
    const narrowing = EXTENDED_NARROWING.filter((name) => process.env[name]);
    if (narrowing.length) throw new Error(`The extended run reads every scenario; unset ${narrowing.join(', ')}`);
  }
  const { scratch, dispose } = createScratch(keepArtifactsRequested({ argv }));
  let failed = true;
  try {
    const context = prepare({ root, scratch });
    if (verify) {
      for (const args of VERIFY_COMMANDS) runChecked(context.cargo, args, { cwd: context.workspace, env: context.env });
      const linux = linuxLintPlan({ toolchainHome: context.located.home, channel: context.toolchain.channel, exists: existsSync });
      console.log(`\n${linux.line}`);
      if (extended && linux.action === 'missing') throw new Error(`The extended run needs the Linux lint: ${linux.line}`);
      if (linux.action === 'lint') for (const args of LINUX_LINT_COMMANDS) runChecked(context.cargo, args, { cwd: context.workspace, env: context.env });
      checkDependencies(context);
    } else {
      runChecked(context.cargo, ['build', '--locked', '--offline', '--workspace'], { cwd: context.workspace, env: context.env });
    }
    const probe = buildProbeIn(context);
    const ledger = buildLedgerIn(context);
    if (verify) {
      const reference = referenceRuntime();
      console.log(`\nJavaScript reference runtime: ${reference.description}`);
      if (extended && !reference.electron) throw new Error(`The extended run needs Electron's Node as the JavaScript reference: ${reference.description}`);
      const tests = extended ? [...DIFFERENTIAL_TESTS, ...EXTENDED_TESTS] : DIFFERENTIAL_TESTS;
      const env = { ...process.env, [PROBE_VARIABLE]: probe, [ODB_PROBE_VARIABLE]: context.odbProbe,
        [LEDGER_VARIABLE]: ledger.plain, [LEDGER_HOOKS_VARIABLE]: ledger.hooks, [LEDGER_PROBE_VARIABLE]: ledger.probe };
      if (extended) env[EXTENDED_VARIABLE] = '1';
      else delete env[EXTENDED_VARIABLE];
      const started = Date.now();
      runChecked(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', ...tests], { cwd: root, env }, `node --test ${tests.join(' ')}`);
      console.log(`Differential tests took ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    }
    console.log(`\nThe native ledger workspace ${extended ? 'passed its extended run' : verify ? 'passed its checks' : 'builds'}.`);
    failed = false;
  } finally {
    dispose(failed);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
