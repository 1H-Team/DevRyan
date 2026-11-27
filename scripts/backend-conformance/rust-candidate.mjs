#!/usr/bin/env node
// The Rust candidates of the route groups (BH6, BH7; packages/native/DOCUMENTATION.md,
// "devryan-route-magic-prompts", "devryan-route-session-folders"): where each binary is, whether it was built
// from the sources in the tree, and the command that builds them all.
//
//   node scripts/backend-conformance/rust-candidate.mjs [--plants]
//
// builds it (release, locked, with the toolchain packages/native pins) into
// packages/native/target/backend-conformance/<plain|plants>/, the workspace's
// own ignored build folder, and records a digest of every input beside the
// binary. It runs with the caller's environment, outside the test isolation
// guard: cargo reads its registry and rustup its toolchains from the caller's
// HOME. A run under the guard (the conformance command with --candidate=rust,
// the Rust plants) only reads the binary and refuses, naming this command,
// when it is missing or was built from other sources.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT } from './edge.mjs';
import { GROUPS } from './groups.mjs';
import { RunRefused } from './run-scratch.mjs';

export const NATIVE_DIR = path.join(REPOSITORY_ROOT, 'packages', 'native');
/** The groups that have a Rust candidate (groups.mjs `rust`), by name. */
export const RUST_GROUPS = Object.freeze(Object.keys(GROUPS).filter((name) => GROUPS[name].rust));
const rustOf = (group) => {
  const entry = GROUPS[group]?.rust;
  if (!entry) throw new RunRefused(`group ${group} has no Rust candidate (known: ${RUST_GROUPS.join(', ')})`);
  return entry;
};
/** The pilot's crate (kept for callers of the first group). */
export const CRATE = GROUPS['magic-prompts'].rust.crate;
export const crateDir = (group = 'magic-prompts') => path.join(NATIVE_DIR, 'crates', rustOf(group).dir);
const CRATE_DIR = crateDir('magic-prompts');
/**
 * The inputs every group's build shares: the workspace's files, the shared request path, the JavaScript-text crate,
 * and the ledger core's number layout, which that crate compiles in by path (packages/native/DOCUMENTATION.md, "One
 * JavaScript implementation").
 */
const SHARED_INPUTS = Object.freeze(['packages/native/Cargo.toml', 'packages/native/Cargo.lock', 'packages/native/rust-toolchain.toml', 'packages/native/crates/route-common', 'packages/native/crates/config-text/src', 'packages/native/crates/config-text/Cargo.toml', 'packages/harness-runtime/native/ledger-core/src/js/number.rs']);
/** Every input of one group's build, as repository-relative folders and files (their `target/` left out). */
export const buildInputs = (group = 'magic-prompts') => Object.freeze([...SHARED_INPUTS, `packages/native/crates/${rustOf(group).dir}`]);
export const BUILD_INPUTS = buildInputs('magic-prompts');
export const BUILD_DEADLINE_MS = 20 * 60_000;
/** One build at a time with two jobs (the machine's rule for heavy work). */
const BUILD_JOBS = '2';

export const buildCommand = ({ plants = false } = {}) => `node scripts/backend-conformance/rust-candidate.mjs${plants ? ' --plants' : ''}`;
const variant = (plants) => (plants ? 'plants' : 'plain');
export const targetDir = ({ plants = false } = {}) => path.join(NATIVE_DIR, 'target', 'backend-conformance', variant(plants));
export const binaryPath = ({ plants = false, group = 'magic-prompts' } = {}) => path.join(targetDir({ plants }), 'release', rustOf(group).crate);
const stampPath = (options = {}) => `${binaryPath(options)}.inputs.json`;

/** The digest of one group's build inputs (file names and bytes, in order) and the feature set. */
export function inputsDigest({ plants = false, root = REPOSITORY_ROOT, group = 'magic-prompts' } = {}) {
  const hash = crypto.createHash('sha256');
  hash.update(`features=${plants ? 'plants' : ''}\0`);
  const files = [];
  const walk = (relative) => {
    const full = path.join(root, relative);
    const stat = fs.statSync(full);
    if (stat.isFile()) { files.push(relative); return; }
    for (const name of fs.readdirSync(full).sort()) if (name !== 'target') walk(path.posix.join(relative, name));
  };
  for (const input of buildInputs(group)) walk(input);
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * The candidate command of a group for the harness: `[binary]` (plus `--plant <id>` for a plant), or RunRefused
 * naming the build command when the binary is missing or its recorded inputs are not the tree's.
 */
export function rustCandidateCommand({ plants = false, plant = null, group = 'magic-prompts' } = {}) {
  const binary = binaryPath({ plants, group });
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(stampPath({ plants, group }), 'utf8')); } catch { stamp = null; }
  if (!fs.existsSync(binary) || !stamp) throw new RunRefused(`the Rust candidate of ${group}${plants ? ' with its plants' : ''} is not built; build it outside the guard with:\n  ${buildCommand({ plants })}`);
  if (stamp.digest !== inputsDigest({ plants, group })) throw new RunRefused(`the Rust candidate of ${group}${plants ? ' with its plants' : ''} was built from other sources than the tree's; rebuild it outside the guard with:\n  ${buildCommand({ plants })}`);
  return [binary, ...(plant ? ['--plant', plant] : [])];
}

/** Builds every group's binary (release, locked, one cargo call) with the pinned toolchain and records each one's inputs. */
export async function buildRustCandidate({ plants = false, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const { readNativeToolchain, locateNativeToolchain } = await import(pathToFileURL(path.join(REPOSITORY_ROOT, 'scripts', 'check-native.mjs')).href);
  const toolchain = readNativeToolchain(REPOSITORY_ROOT);
  const located = locateNativeToolchain(toolchain);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(?:RUSTC|RUSTDOC|RUSTFLAGS|RUSTUP_TOOLCHAIN|RUSTUP_AUTO_INSTALL|CARGO_BUILD_|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_DIR)/.test(key)) env[key] = value;
  Object.assign(env, { PATH: `${located.bin}${path.delimiter}${process.env.PATH ?? ''}`, RUSTUP_TOOLCHAIN: toolchain.channel, RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never', CARGO_BUILD_JOBS: BUILD_JOBS });
  const digests = Object.fromEntries(RUST_GROUPS.map((group) => [group, inputsDigest({ plants, group })]));
  const crates = RUST_GROUPS.map((group) => GROUPS[group].rust.crate);
  const steps = [
    ['fetch', '--locked'],
    ['build', '--release', '--locked', '--offline', ...crates.flatMap((name) => ['--package', name, '--bin', name]), '--target-dir', targetDir({ plants }), ...(plants ? ['--features', crates.map((name) => `${name}/plants`).join(',')] : [])],
  ];
  for (const step of steps) {
    log(`$ cargo ${step.join(' ')}`);
    const result = spawnSync(path.join(located.bin, 'cargo'), step, { cwd: NATIVE_DIR, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: BUILD_DEADLINE_MS, killSignal: 'SIGKILL' });
    if (result.error?.code === 'ETIMEDOUT') throw new Error(`cargo ${step[0]} of the Rust candidates passed its ${BUILD_DEADLINE_MS / 60_000}-minute deadline and was killed`);
    if (result.error || result.status !== 0) throw new Error(`cargo ${step.join(' ')} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}`);
  }
  for (const group of RUST_GROUPS) {
    if (digests[group] !== inputsDigest({ plants, group })) throw new Error('the sources changed while the candidates were built; build them again');
    fs.writeFileSync(stampPath({ plants, group }), `${JSON.stringify({ crate: GROUPS[group].rust.crate, plants, digest: digests[group], toolchain: toolchain.channel }, null, 2)}\n`);
    log(`built ${binaryPath({ plants, group })}`);
  }
  return RUST_GROUPS.map((group) => binaryPath({ plants, group }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((argument) => argument !== '--plants');
  if (unknown.length) { process.stderr.write(`rust-candidate: unknown option ${unknown.join(' ')}\nusage: ${buildCommand()} [--plants]\n`); process.exit(64); }
  try { await buildRustCandidate({ plants: argv.includes('--plants') }); } catch (failure) { process.stderr.write(`rust-candidate: ${failure.message}\n`); process.exit(1); }
}

export { CRATE_DIR };
