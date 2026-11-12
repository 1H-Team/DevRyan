#!/usr/bin/env node
// Builds, lints and tests the native ledger's Rust workspace
// (packages/harness-runtime/native/ledger, crate ledger-io), which nothing in
// the product calls yet. The toolchain is the ledger core's pin, selected
// through RUSTUP_TOOLCHAIN; every cargo command runs with --locked on a copy
// of the workspace and of the ledger-core crate it depends on, under the OS
// temp dir, with a private CARGO_HOME and target directory there (removed
// afterwards unless --keep-artifacts). The dependencies are fetched once per
// run with `cargo fetch --locked` (checksums from the tracked Cargo.lock);
// everything after that is --offline.
//
//   node scripts/build-ledger-native.mjs            build the library and the test-only probe
//   node scripts/build-ledger-native.mjs --verify   cargo fmt --check, clippy -D warnings, cargo test,
//                                                   cargo check and clippy for x86_64 Linux when that
//                                                   target is installed, then the Node differential
//                                                   tests against the probe (JavaScript on the Node
//                                                   inside Electron where its binary exists)
//
// packages/harness-runtime/DOCUMENTATION.md ("Native ledger I/O") describes
// the workspace; the Rust-free contract is this script's test.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CRATE_DIR as CORE_DIR, ancestorCargoConfigs, locateToolchain, readToolchainFile } from './build-ledger-core.mjs';
import { keepArtifactsRequested, scratchParent } from './qa/run-root.mjs';
import { referenceRuntime } from './ledger-native/reference-runtime.mjs';
import { LINUX_LINT_COMMANDS, PROBE_BUILD_ARGS, PROBE_VARIABLE, VERIFY_COMMANDS, WORKSPACE_DIR, cargoEnvironment, linuxLintPlan, treeFiles } from './ledger-native/workspace.mjs';

export { PROBE_VARIABLE };
/** The Node differential tests the verify runs against the probe. */
export const DIFFERENTIAL_TESTS = Object.freeze(['scripts/ledger-native/atomic-differential.mjs']);

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

/** Copies the sources, fetches the locked dependencies and builds the probe; returns the cargo context. */
function prepare({ root, scratch }) {
  const toolchain = readToolchainFile(root);
  const located = locateToolchain(toolchain);
  const workspace = copySources(root, scratch);
  const env = cargoEnvironment({ located, toolchain, scratch });
  const cargo = path.join(located.bin, 'cargo');
  runChecked(cargo, ['fetch', '--locked'], { cwd: workspace, env });
  return { cargo, workspace, env, located, toolchain, probe: path.join(scratch, 'target', 'debug', 'atomic-probe') };
}

function buildProbeIn(context) {
  runChecked(context.cargo, PROBE_BUILD_ARGS, { cwd: context.workspace, env: context.env });
  if (!existsSync(context.probe)) throw new Error(`cargo did not produce ${context.probe}`);
  return context.probe;
}

/**
 * Builds the test-only probe for a test that was started without one
 * (`LEDGER_NATIVE_PROBE` unset). The caller disposes of the build directory.
 */
export function buildProbe({ root = repositoryRoot, keep = keepArtifactsRequested() } = {}) {
  const { scratch, dispose } = createScratch(keep);
  try {
    return { probe: buildProbeIn(prepare({ root, scratch })), dispose: () => dispose(false) };
  } catch (error) {
    dispose(true);
    throw error;
  }
}

export function main(argv = process.argv.slice(2), root = repositoryRoot) {
  const unknown = argv.filter((arg) => !['--verify', '--keep-artifacts'].includes(arg));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')} (use --verify or --keep-artifacts)`);
  const { scratch, dispose } = createScratch(keepArtifactsRequested({ argv }));
  let failed = true;
  try {
    const context = prepare({ root, scratch });
    if (argv.includes('--verify')) {
      for (const args of VERIFY_COMMANDS) runChecked(context.cargo, args, { cwd: context.workspace, env: context.env });
      const linux = linuxLintPlan({ toolchainHome: context.located.home, channel: context.toolchain.channel, exists: existsSync });
      console.log(`\n${linux.line}`);
      if (linux.action === 'lint') for (const args of LINUX_LINT_COMMANDS) runChecked(context.cargo, args, { cwd: context.workspace, env: context.env });
    } else {
      runChecked(context.cargo, ['build', '--locked', '--offline', '--workspace'], { cwd: context.workspace, env: context.env });
    }
    const probe = buildProbeIn(context);
    if (argv.includes('--verify')) {
      console.log(`\nJavaScript reference runtime: ${referenceRuntime().description}`);
      runChecked(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', ...DIFFERENTIAL_TESTS],
        { cwd: root, env: { ...process.env, [PROBE_VARIABLE]: probe } }, `node --test ${DIFFERENTIAL_TESTS.join(' ')}`);
    }
    console.log(`\nThe native ledger workspace ${argv.includes('--verify') ? 'passed its checks' : 'builds'}.`);
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
