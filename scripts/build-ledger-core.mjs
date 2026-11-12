#!/usr/bin/env node
// Builds the Rust ledger core (packages/harness-runtime/native/ledger-core) to
// WebAssembly and writes the tracked module and its provenance file:
//   packages/harness-runtime/lib/native/ledger-core.wasm
//   packages/harness-runtime/lib/native/ledger-core.json
// The build uses the toolchain the crate's rust-toolchain.toml pins, with
// --locked and --offline, deterministic flags and a target directory under the
// OS temp dir (removed afterwards unless --keep-artifacts).
//
//   node scripts/build-ledger-core.mjs            build and write both files
//   node scripts/build-ledger-core.mjs --check    rebuild; fail unless the tracked files are byte-identical
//   node scripts/build-ledger-core.mjs --verify   cargo fmt --check, clippy (native and WebAssembly), cargo test, then --check
//
// Nothing here downloads a toolchain: a missing one fails with the command
// that installs it. packages/harness-runtime/DOCUMENTATION.md ("Rust ledger
// core") describes the provenance file; scripts/build-ledger-core.test.mjs is
// the contract that needs no Rust.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { keepArtifactsRequested, scratchParent } from './qa/run-root.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CRATE_DIR = 'packages/harness-runtime/native/ledger-core';
export const MODULE_PATH = 'packages/harness-runtime/lib/native/ledger-core.wasm';
export const PROVENANCE_PATH = 'packages/harness-runtime/lib/native/ledger-core.json';
export const PROVENANCE_SCHEMA_VERSION = 1;
export const WASM_TARGET = 'wasm32-unknown-unknown';
/** Crate files read before the sources under src/, in this order. */
export const CRATE_INPUTS = Object.freeze(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']);
/** Build inputs Cargo reads when they exist; hashed after CRATE_INPUTS, in this order, only when present. */
export const OPTIONAL_CRATE_INPUTS = Object.freeze(['build.rs', '.cargo/config.toml', '.cargo/config']);
/**
 * Crate files that cannot change the module: the test tree and the ignore
 * file. Every other file of the crate must be a digest input
 * (scripts/build-ledger-core.test.mjs fails otherwise).
 */
export const NON_BUILD_CRATE_FILES = Object.freeze([/^\.gitignore$/, /^tests\//]);
export const BUILD_ARGS = Object.freeze(['build', '--locked', '--offline', '--release', '--target', WASM_TARGET, '--lib']);
/**
 * RUSTFLAGS of the module build. `{crate}`, `{cargoHome}` and `{toolchain}`
 * stand for this checkout's crate directory, the build's private CARGO_HOME and
 * the toolchain directory, so no host path can reach the module; the module
 * embeds none even without them (research R0, determinism).
 */
export const RUSTFLAG_TEMPLATES = Object.freeze([
  '--remap-path-prefix={crate}=/ledger-core',
  '--remap-path-prefix={cargoHome}=/cargo',
  '--remap-path-prefix={toolchain}=/toolchain',
  '-Ctarget-cpu=generic',
]);
export const BUILD_ENVIRONMENT = Object.freeze({ SOURCE_DATE_EPOCH: '0' });
const ARTIFACT = 'ledger_core.wasm';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The pinned channel, components and targets of the crate's rust-toolchain.toml. */
export function readToolchainFile(root = repositoryRoot) {
  const text = readFileSync(path.join(root, CRATE_DIR, 'rust-toolchain.toml'), 'utf8');
  const value = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1];
  const list = (key) => [...(value(key) ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const channel = /^"(\d+\.\d+\.\d+)"$/.exec(value('channel') ?? '')?.[1];
  if (!channel) throw new Error(`${CRATE_DIR}/rust-toolchain.toml must pin channel = "<major>.<minor>.<patch>"`);
  return { channel, components: list('components'), targets: list('targets') };
}

/** The command that installs the pinned toolchain with what the build needs. */
export function installCommand({ channel, components, targets }) {
  return `rustup toolchain install ${channel} --profile minimal --component ${components.join(',')} --target ${targets.join(',')}`;
}

/** Files of the crate that determine the module, in digest order, each with its SHA-256. */
export function ledgerCoreSources(root = repositoryRoot, crate = path.join(root, CRATE_DIR)) {
  const sources = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(crate, relative), { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) sources.push(file);
      else throw new Error(`${CRATE_DIR}/${file} is not a regular file`);
    }
  };
  walk('src');
  const optional = OPTIONAL_CRATE_INPUTS.filter((file) => existsSync(path.join(crate, file)));
  return [...CRATE_INPUTS, ...optional, ...sources].map((file) => {
    const absolute = path.join(crate, file);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${CRATE_DIR}/${file} is a link`);
    return { path: file, sha256: sha256(readFileSync(absolute)) };
  });
}

/** Every file of the crate (the build directory `target/` excluded), as crate-relative POSIX paths. */
export function ledgerCoreCrateFiles(root = repositoryRoot) {
  const crate = path.join(root, CRATE_DIR);
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(crate, relative), { withFileTypes: true })) {
      const file = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) { if (file !== 'target') walk(file); } else files.push(file);
    }
  };
  walk('');
  return files.sort();
}

/**
 * Cargo configuration in a directory above `crate`, which would change the
 * build without changing the digest. Cargo reads `.cargo/config[.toml]` in the
 * crate directory and every ancestor (a developer's `~/.cargo/config.toml` is
 * one for a checkout under the home folder), so every cargo command runs on a
 * copy of the crate under the OS temp dir, and this must find nothing there.
 */
export function ancestorCargoConfigs(crate) {
  const found = [];
  for (let directory = path.dirname(crate); ; directory = path.dirname(directory)) {
    for (const name of ['config.toml', 'config']) if (existsSync(path.join(directory, '.cargo', name))) found.push(path.join(directory, '.cargo', name));
    if (path.dirname(directory) === directory) return found;
  }
}

/** Copies the crate (without `target/`) to `<scratch>/ledger-core` and returns that directory. */
function copyCrate(root, scratch) {
  const copy = path.join(scratch, 'ledger-core');
  for (const file of ledgerCoreCrateFiles(root)) {
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    copyFileSync(path.join(root, CRATE_DIR, file), path.join(copy, file));
  }
  const outside = ancestorCargoConfigs(copy);
  if (outside.length) throw new Error(`Cargo configuration above the build copy would change the build without changing its digest: ${outside.join(', ')}`);
  return copy;
}

/** SHA-256 over one `<path>\0<sha256>\n` line per source, in `ledgerCoreSources` order. */
export function ledgerCoreSourceDigest(sources) {
  return sha256(sources.map((source) => `${source.path}\0${source.sha256}\n`).join(''));
}

/** The provenance record of a module built from `sources`. */
export function provenanceRecord({ sources, moduleBytes, abiVersion, toolchain, rustc, cargo }) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    module: path.posix.basename(MODULE_PATH),
    sha256: sha256(moduleBytes),
    bytes: moduleBytes.length,
    abiVersion,
    target: WASM_TARGET,
    toolchain: { channel: toolchain.channel, rustc, cargo },
    build: { command: `cargo ${BUILD_ARGS.join(' ')}`, rustflags: [...RUSTFLAG_TEMPLATES], environment: { ...BUILD_ENVIRONMENT } },
    sources: { crate: CRATE_DIR, digest: ledgerCoreSourceDigest(sources), files: Object.fromEntries(sources.map((source) => [source.path, source.sha256])) },
  };
}

export const renderProvenance = (record) => `${JSON.stringify(record, null, 2)}\n`;

/** The ABI version a module reports (`ledger_core_abi_version`). */
export function moduleAbiVersion(bytes) {
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.ledger_core_abi_version();
}

/**
 * The pinned toolchain's binaries, found through rustup without ever
 * installing one. Throws with the install command when it is missing or lacks
 * a component or target.
 */
export function locateToolchain(toolchain, { env = process.env, run = spawnSync } = {}) {
  const install = installCommand(toolchain);
  const found = run('rustup', ['which', '--toolchain', toolchain.channel, 'rustc'], { encoding: 'utf8', env: { ...env, RUSTUP_AUTO_INSTALL: '0' } });
  if (found.error || found.status !== 0) {
    const why = found.error?.code === 'ENOENT' ? 'rustup is not installed (https://rustup.rs)' : `Rust ${toolchain.channel} is not installed`;
    throw new Error(`${why}. The ledger core needs the pinned toolchain; install it with:\n  ${install}`);
  }
  const bin = path.dirname(found.stdout.trim());
  const home = path.dirname(bin);
  const missing = [
    ...['cargo', 'rustc', 'rustdoc', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver'].filter((name) => !existsSync(path.join(bin, name))),
    ...toolchain.targets.filter((target) => !existsSync(path.join(home, 'lib', 'rustlib', target, 'lib'))).map((target) => `the ${target} target`),
  ];
  if (missing.length) throw new Error(`Rust ${toolchain.channel} lacks ${missing.join(', ')}. Install what the ledger core needs with:\n  ${install}`);
  return { bin, home };
}

/** A private build environment: no inherited Cargo or rustc settings, flags or wrappers. */
function cargoEnvironment({ located, toolchain, scratch, crate, rustflags }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:CARGO_|RUSTC|RUSTDOC|RUSTFLAGS|RUSTUP_TOOLCHAIN|RUSTUP_AUTO_INSTALL)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    PATH: `${located.bin}${path.delimiter}${process.env.PATH ?? ''}`,
    RUSTC: path.join(located.bin, 'rustc'),
    RUSTDOC: path.join(located.bin, 'rustdoc'),
    RUSTUP_TOOLCHAIN: toolchain.channel,
    RUSTUP_AUTO_INSTALL: '0',
    CARGO_HOME: path.join(scratch, 'cargo-home'),
    CARGO_TARGET_DIR: path.join(scratch, 'target'),
    CARGO_INCREMENTAL: '0',
    CARGO_TERM_COLOR: process.stdout.isTTY ? 'auto' : 'never',
    ...BUILD_ENVIRONMENT,
  });
  if (rustflags) {
    const values = { crate, cargoHome: env.CARGO_HOME, toolchain: located.home };
    env.RUSTFLAGS = RUSTFLAG_TEMPLATES.map((flag) => flag.replace(/\{(\w+)\}/g, (_, name) => values[name])).join(' ');
  }
  return env;
}

function runChecked(command, args, options, label = `${path.basename(command)} ${args.join(' ')}`) {
  console.log(`\n$ ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}`);
}

function version(located, binary, env) {
  const result = spawnSync(path.join(located.bin, binary), ['--version'], { encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${binary} --version failed`);
  return result.stdout.trim();
}

/** A private scratch directory under the OS temp dir, removed on exit and interruption unless kept. */
function createScratch(keep) {
  const parent = scratchParent('ledger-core');
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

/** Builds the module in `scratch` and returns its bytes and provenance. */
export function buildModule({ root = repositoryRoot, scratch, toolchain = readToolchainFile(root), located = locateToolchain(toolchain), crate = copyCrate(root, scratch) }) {
  const env = cargoEnvironment({ located, toolchain, scratch, crate, rustflags: true });
  const rustc = version(located, 'rustc', env);
  const cargo = version(located, 'cargo', env);
  if (!rustc.startsWith(`rustc ${toolchain.channel} `)) throw new Error(`${path.join(located.bin, 'rustc')} reports "${rustc}", not ${toolchain.channel}`);
  const sources = ledgerCoreSources(root);
  // The copy that is built must be the crate the provenance describes.
  if (ledgerCoreSourceDigest(ledgerCoreSources(root, crate)) !== ledgerCoreSourceDigest(sources)) throw new Error(`${CRATE_DIR} changed while it was copied for the build`);
  runChecked(path.join(located.bin, 'cargo'), BUILD_ARGS, { cwd: crate, env }, `cargo ${BUILD_ARGS.join(' ')}`);
  const moduleBytes = readFileSync(path.join(scratch, 'target', WASM_TARGET, 'release', ARTIFACT));
  // The sources must not have changed while the build ran.
  if (ledgerCoreSourceDigest(ledgerCoreSources(root)) !== ledgerCoreSourceDigest(sources)) throw new Error(`${CRATE_DIR} changed during the build`);
  return { moduleBytes, provenance: provenanceRecord({ sources, moduleBytes, abiVersion: moduleAbiVersion(moduleBytes), toolchain, rustc, cargo }) };
}

/** Differences between a fresh build and the tracked files; empty when they are byte-identical. */
export function compareWithTracked({ moduleBytes, provenance }, root = repositoryRoot) {
  const problems = [];
  const tracked = (file) => { try { return readFileSync(path.join(root, file)); } catch { return null; } };
  const module = tracked(MODULE_PATH);
  if (!module) problems.push(`${MODULE_PATH} is missing`);
  else if (!module.equals(moduleBytes)) problems.push(`${MODULE_PATH} (sha256 ${sha256(module)}, ${module.length} bytes) differs from the rebuilt module (sha256 ${provenance.sha256}, ${provenance.bytes} bytes)`);
  const record = tracked(PROVENANCE_PATH);
  if (!record) problems.push(`${PROVENANCE_PATH} is missing`);
  else if (record.toString('utf8') !== renderProvenance(provenance)) problems.push(`${PROVENANCE_PATH} differs from the rebuilt provenance:\n${renderProvenance(provenance)}`);
  return problems;
}

function verify({ scratch, toolchain, located, crate }) {
  const env = cargoEnvironment({ located, toolchain, scratch, crate, rustflags: false });
  const cargo = path.join(located.bin, 'cargo');
  runChecked(cargo, ['fmt', '--check'], { cwd: crate, env });
  // `--test corpus`: that target is `test = false` (it needs a corpus), so `--all-targets` alone skips it.
  runChecked(cargo, ['clippy', '--locked', '--offline', '--all-targets', '--test', 'corpus', '--', '-D', 'warnings'], { cwd: crate, env });
  runChecked(cargo, ['clippy', '--locked', '--offline', '--all-targets', '--test', 'corpus', '--target', WASM_TARGET, '--', '-D', 'warnings'], { cwd: crate, env });
  runChecked(cargo, ['test', '--locked', '--offline'], { cwd: crate, env });
}

export function main(argv = process.argv.slice(2), root = repositoryRoot) {
  const unknown = argv.filter((arg) => !['--check', '--verify', '--keep-artifacts'].includes(arg));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')} (use --check, --verify or --keep-artifacts)`);
  const mode = argv.includes('--verify') ? 'verify' : argv.includes('--check') ? 'check' : 'write';
  const toolchain = readToolchainFile(root);
  const located = locateToolchain(toolchain);
  const { scratch, dispose } = createScratch(keepArtifactsRequested({ argv }));
  let failed = true;
  try {
    const crate = copyCrate(root, scratch);
    if (mode === 'verify') verify({ scratch, toolchain, located, crate });
    const built = buildModule({ root, scratch, toolchain, located, crate });
    if (mode === 'write') {
      mkdirSync(path.dirname(path.join(root, MODULE_PATH)), { recursive: true });
      writeFileSync(path.join(root, MODULE_PATH), built.moduleBytes);
      writeFileSync(path.join(root, PROVENANCE_PATH), renderProvenance(built.provenance));
      console.log(`\nWrote ${MODULE_PATH} (${built.provenance.bytes} bytes, sha256 ${built.provenance.sha256}) and ${PROVENANCE_PATH}.`);
    } else {
      const problems = compareWithTracked(built, root);
      if (problems.length) throw new Error(`The tracked ledger core is not what its sources build:\n${problems.join('\n')}\nRebuild with: node scripts/build-ledger-core.mjs`);
      console.log(`\nThe tracked module matches a rebuild (${built.provenance.bytes} bytes, sha256 ${built.provenance.sha256}).`);
    }
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
