#!/usr/bin/env node
// Checks the product's Cargo workspace (packages/native, see its
// DOCUMENTATION.md): cargo fmt --check, cargo clippy with warnings denied, and
// cargo test, all with the toolchain packages/native/rust-toolchain.toml pins
// and the locked dependency graph.
//
//   node scripts/check-native.mjs           fetch (locked), licences, fmt, clippy, test
//   node scripts/check-native.mjs --deny    also cargo deny check licenses advisories sources (offline:
//                                           the advisory database already on this machine)
//   node scripts/check-native.mjs --advisories
//                                           only cargo deny check licenses advisories sources, with a
//                                           fresh RustSec database (what CI runs). With CARGO_DENY_ROOT
//                                           set, cargo-deny is <root>/bin/cargo-deny, installed there at
//                                           the pinned version when missing; otherwise it must be on PATH.
//                                           Advisories ignored on purpose are listed in deny.toml, each
//                                           with its reason.
//
// The licence step needs no tool beyond cargo (scripts/check-native-licenses.mjs,
// against the allow list in packages/native/deny.toml), so it always runs.
//
// Nothing here installs a toolchain: a missing one fails with the command that
// installs it. Dependencies are fetched once (`cargo fetch --locked`); every
// later step runs --offline. Builds go to packages/native/target (ignored by git).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { main as checkLicenses } from './check-native-licenses.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_DIR = 'packages/native';

/** The pinned channel and components of packages/native/rust-toolchain.toml. */
export function readNativeToolchain(root = repositoryRoot) {
  const text = readFileSync(path.join(root, NATIVE_DIR, 'rust-toolchain.toml'), 'utf8');
  const value = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1];
  const list = (key) => [...(value(key) ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const channel = /^"(\d+\.\d+\.\d+)"$/.exec(value('channel') ?? '')?.[1];
  if (!channel) throw new Error(`${NATIVE_DIR}/rust-toolchain.toml must pin channel = "<major>.<minor>.<patch>"`);
  return { channel, components: list('components'), targets: list('targets') };
}

/** The command that installs the pinned toolchain with what the checks need. */
export function nativeInstallCommand({ channel, components, targets }) {
  return `rustup toolchain install ${channel} --profile minimal --component ${components.join(',')}${targets.length ? ` --target ${targets.join(',')}` : ''}`;
}

/** The pinned toolchain's bin directory; throws with the install command when it is missing. */
export function locateNativeToolchain(toolchain, { env = process.env, run = spawnSync } = {}) {
  const install = nativeInstallCommand(toolchain);
  const found = run('rustup', ['which', '--toolchain', toolchain.channel, 'cargo'], { encoding: 'utf8', env: { ...env, RUSTUP_AUTO_INSTALL: '0' } });
  if (found.error || found.status !== 0) {
    const why = found.error?.code === 'ENOENT' ? 'rustup is not installed (https://rustup.rs)' : `Rust ${toolchain.channel} is not installed`;
    throw new Error(`${why}. packages/native needs the pinned toolchain; install it with:\n  ${install}`);
  }
  const bin = path.dirname(found.stdout.trim());
  const missing = ['cargo', 'rustc', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver'].filter((name) => !existsSync(path.join(bin, name)));
  if (missing.length) throw new Error(`Rust ${toolchain.channel} lacks ${missing.join(', ')}. Install what packages/native needs with:\n  ${install}`);
  return { bin };
}

/** The cargo-deny release the advisory check uses, locally and in CI (its cache key names it). */
export const CARGO_DENY_VERSION = '0.20.2';

/** The command that installs that cargo-deny into `root`. */
export function cargoDenyInstallCommand(root) {
  return ['install', 'cargo-deny', '--version', CARGO_DENY_VERSION, '--locked', '--root', root];
}

/** The advisory check CI runs: a locked fetch, then cargo deny with an updated advisory database. */
export function advisorySteps() {
  return [['fetch', '--locked'], ['deny', '--locked', 'check', 'licenses', 'advisories', 'sources']];
}

/** The licence step, run in-process after the fetch (scripts/check-native-licenses.mjs). */
export const LICENCE_STEP = 'licences';

/** The steps, in order: cargo invocations and the licence step. */
export function nativeSteps({ deny = false } = {}) {
  return [
    ['fetch', '--locked'],
    [LICENCE_STEP],
    ['fmt', '--all', '--check'],
    ['clippy', '--locked', '--offline', '--workspace', '--all-targets', '--', '-D', 'warnings'],
    ['test', '--locked', '--offline', '--workspace'],
    ...(deny ? [['deny', '--locked', '--offline', 'check', 'licenses', 'advisories', 'sources']] : []),
  ];
}

function cargoEnvironment(located, toolchain) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:RUSTC|RUSTDOC|RUSTFLAGS|RUSTUP_TOOLCHAIN|RUSTUP_AUTO_INSTALL|CARGO_BUILD_|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_DIR)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, PATH: `${located.bin}${path.delimiter}${process.env.PATH ?? ''}`, RUSTUP_TOOLCHAIN: toolchain.channel, RUSTUP_AUTO_INSTALL: '0',
    CARGO_TERM_COLOR: process.stdout.isTTY ? 'auto' : 'never' };
}

/** Puts the pinned cargo-deny first on `env.PATH`, installing it into CARGO_DENY_ROOT when that is set and it is missing. */
function provideCargoDeny(located, env) {
  const denyRoot = process.env.CARGO_DENY_ROOT;
  if (denyRoot) {
    const binary = path.join(denyRoot, 'bin', 'cargo-deny');
    if (!existsSync(binary)) {
      const command = cargoDenyInstallCommand(denyRoot);
      console.log(`\n$ cargo ${command.join(' ')}`);
      const installed = spawnSync(path.join(located.bin, 'cargo'), command, { cwd: denyRoot, env, stdio: 'inherit' });
      if (installed.error || installed.status !== 0) throw new Error(`cargo ${command.join(' ')} failed${installed.error ? `: ${installed.error.message}` : ` (exit ${installed.status ?? installed.signal})`}`);
    }
    env.PATH = `${path.dirname(binary)}${path.delimiter}${env.PATH}`;
  }
  const version = spawnSync('cargo-deny', ['--version'], { env, encoding: 'utf8' });
  const found = /^cargo-deny (\S+)/.exec(version.stdout ?? '')?.[1];
  if (found !== CARGO_DENY_VERSION) {
    throw new Error(`cargo-deny ${CARGO_DENY_VERSION} is needed, found ${found ?? 'none'}. Install it with:\n  cargo ${cargoDenyInstallCommand('<dir>').join(' ')}\nand put <dir>/bin on PATH, or set CARGO_DENY_ROOT=<dir>.`);
  }
}

export function main(argv = process.argv.slice(2), root = repositoryRoot) {
  const unknown = argv.filter((arg) => arg !== '--deny' && arg !== '--advisories');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')} (use --deny or --advisories)`);
  if (argv.includes('--deny') && argv.includes('--advisories')) throw new Error('--deny and --advisories are alternatives');
  const advisories = argv.includes('--advisories');
  const toolchain = readNativeToolchain(root);
  const located = locateNativeToolchain(toolchain);
  const env = cargoEnvironment(located, toolchain);
  if (advisories) {
    if (process.env.CARGO_DENY_ROOT) mkdirSync(process.env.CARGO_DENY_ROOT, { recursive: true });
    provideCargoDeny(located, env);
  }
  for (const step of advisories ? advisorySteps() : nativeSteps({ deny: argv.includes('--deny') })) {
    if (step[0] === LICENCE_STEP) {
      console.log('\n$ node scripts/check-native-licenses.mjs');
      checkLicenses(['--cargo', path.join(located.bin, 'cargo')], root);
      continue;
    }
    const label = `cargo ${step.join(' ')}`;
    console.log(`\n$ ${label}`);
    const result = spawnSync(path.join(located.bin, 'cargo'), step, { cwd: path.join(root, NATIVE_DIR), env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}`);
  }
  console.log(advisories ? `\npackages/native: no RustSec advisory beyond those deny.toml ignores (cargo-deny ${CARGO_DENY_VERSION}).`
    : '\npackages/native: licences, fmt, clippy and tests pass.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
