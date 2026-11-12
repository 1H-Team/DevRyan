// The native ledger workspace's layout and cargo invocations, shared by its
// build script and its Rust-free contract test, which does not load the build
// script itself.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const WORKSPACE_DIR = 'packages/harness-runtime/native/ledger';
/** The variables that hand the differential tests the built probes (lock and atomic writes; object database). */
export const PROBE_VARIABLE = 'LEDGER_NATIVE_PROBE';
export const ODB_PROBE_VARIABLE = 'LEDGER_NATIVE_ODB_PROBE';
export const PROBE_BUILD_ARGS = Object.freeze(['build', '--locked', '--offline', '--package', 'ledger-io', '--features', 'probe', '--bin', 'atomic-probe', '--bin', 'odb-probe']);
export const VERIFY_COMMANDS = Object.freeze([
  Object.freeze(['fmt', '--all', '--check']),
  Object.freeze(['clippy', '--locked', '--offline', '--workspace', '--all-targets', '--all-features', '--', '-D', 'warnings']),
  Object.freeze(['test', '--locked', '--offline', '--workspace', '--all-features']),
]);
/**
 * The Linux target CI's Ubuntu step builds natively. Code under
 * `cfg(target_os = "linux")` is linted on macOS only when the pinned
 * toolchain has this target, so `--verify` runs these there whenever it does.
 */
export const LINUX_LINT_TARGET = 'x86_64-unknown-linux-gnu';
export const LINUX_LINT_COMMANDS = Object.freeze([
  Object.freeze(['check', '--locked', '--offline', '--workspace', '--all-targets', '--all-features', '--target', LINUX_LINT_TARGET]),
  Object.freeze(['clippy', '--locked', '--offline', '--workspace', '--all-targets', '--all-features', '--target', LINUX_LINT_TARGET, '--', '-D', 'warnings']),
]);

/**
 * What `--verify` does about the Linux target: `lint` (the commands above),
 * `native` (this host is that target, so the host clippy covers it) or
 * `missing` (the target is not installed), with the line it prints.
 */
export function linuxLintPlan({ toolchainHome, channel, platform = process.platform, arch = process.arch, exists }) {
  if (platform === 'linux' && arch === 'x64') return { action: 'native', line: `Linux lint: this host is ${LINUX_LINT_TARGET}; the clippy above covered its code.` };
  if (exists(path.join(toolchainHome, 'lib', 'rustlib', LINUX_LINT_TARGET, 'lib'))) return { action: 'lint', line: `Linux lint: cargo check and clippy for ${LINUX_LINT_TARGET}.` };
  return { action: 'missing', line: `Linux lint skipped: Rust ${channel} has no ${LINUX_LINT_TARGET} target here, so the Linux-only code waits for CI (install it with: rustup target add --toolchain ${channel} ${LINUX_LINT_TARGET}).` };
}

/** Files the workspace may hold: manifests, the lockfile, the ignore file and Rust sources. */
export const WORKSPACE_FILE_RULES = Object.freeze([/^Cargo\.(?:toml|lock)$/, /^\.gitignore$/, /^[a-z0-9-]+\/Cargo\.toml$/, /^[a-z0-9-]+\/src\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.rs$/]);

/** Every file of a crate or workspace directory (its `target/` excluded), as relative POSIX paths. */
export function treeFiles(directory) {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) { if (entry.name !== 'target') walk(file); } else files.push(file);
    }
  };
  walk('');
  return files.sort();
}

/** The private cargo environment: no inherited Cargo or rustc settings; home and target under `scratch`. */
export function cargoEnvironment({ located, toolchain, scratch, environment = process.env }) {
  const env = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/^(?:CARGO_|RUSTC|RUSTDOC|RUSTFLAGS|RUSTUP_TOOLCHAIN|RUSTUP_AUTO_INSTALL)/.test(key)) continue;
    env[key] = value;
  }
  return Object.assign(env, {
    PATH: `${located.bin}${path.delimiter}${environment.PATH ?? ''}`,
    RUSTC: path.join(located.bin, 'rustc'),
    RUSTDOC: path.join(located.bin, 'rustdoc'),
    RUSTUP_TOOLCHAIN: toolchain.channel,
    RUSTUP_AUTO_INSTALL: '0',
    CARGO_HOME: path.join(scratch, 'cargo-home'),
    CARGO_TARGET_DIR: path.join(scratch, 'target'),
    CARGO_INCREMENTAL: '0',
    CARGO_TERM_COLOR: process.stdout.isTTY ? 'auto' : 'never',
  });
}

