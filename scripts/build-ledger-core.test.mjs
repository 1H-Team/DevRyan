// The ledger core's tracked WebAssembly module against its sources, with no
// Rust toolchain: the provenance file must describe the crate as it is, the
// module must be the one it names, and the module's ABI must be the loader's.
// A crate edit without `node scripts/build-ledger-core.mjs` fails here on every
// lane; `--check` (CI and fast validate, with Rust) proves the bytes rebuild.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { LEDGER_CORE_ABI_VERSION } from '../packages/harness-runtime/lib/ledger-core.js';
import { VECTORS_FILE, renderVectors } from '../packages/harness-runtime/native/ledger-core/tests/generate-vectors.mjs';
import {
  BUILD_ARGS, BUILD_ENVIRONMENT, CRATE_DIR, CRATE_INPUTS, MODULE_PATH, NON_BUILD_CRATE_FILES, PROVENANCE_PATH, PROVENANCE_SCHEMA_VERSION,
  RUSTFLAG_TEMPLATES, WASM_TARGET, ancestorCargoConfigs, installCommand, ledgerCoreCrateFiles, ledgerCoreSourceDigest, ledgerCoreSources,
  locateToolchain, main, moduleAbiVersion, provenanceRecord, readToolchainFile, renderProvenance, repositoryRoot,
} from './build-ledger-core.mjs';

const read = (file) => readFileSync(path.join(repositoryRoot, file));
const provenanceText = read(PROVENANCE_PATH).toString('utf8');
const provenance = JSON.parse(provenanceText);
const moduleBytes = read(MODULE_PATH);
const toolchain = readToolchainFile();
const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });

describe('ledger core contract', () => {
  test('the provenance names the crate sources as they are (rebuild after any crate edit)', () => {
    const sources = ledgerCoreSources();
    assert.deepEqual(sources.slice(0, CRATE_INPUTS.length).map((source) => source.path), [...CRATE_INPUTS]);
    assert.ok(sources.some((source) => source.path === 'src/lib.rs') && sources.some((source) => source.path === 'src/diff.rs'));
    const stale = sources.filter((source) => provenance.sources.files[source.path] !== source.sha256).map((source) => source.path);
    const gone = Object.keys(provenance.sources.files).filter((file) => !sources.some((source) => source.path === file));
    assert.deepEqual({ stale, gone }, { stale: [], gone: [] },
      `${PROVENANCE_PATH} does not describe ${CRATE_DIR}: rebuild with node scripts/build-ledger-core.mjs`);
    assert.equal(provenance.sources.digest, ledgerCoreSourceDigest(sources));
    assert.equal(provenance.sources.crate, CRATE_DIR);
  });

  test('every crate file is a digest input or one that cannot change the module', () => {
    const inputs = new Set(ledgerCoreSources().map((source) => source.path));
    const uncovered = ledgerCoreCrateFiles().filter((file) => !inputs.has(file) && !NON_BUILD_CRATE_FILES.some((pattern) => pattern.test(file)));
    assert.deepEqual(uncovered, [], `${CRATE_DIR} holds files the provenance digest does not cover: add them to the digest in scripts/build-ledger-core.mjs`);
  });

  test('the tracked module is the one the provenance names', () => {
    assert.equal(provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(provenance.module, path.posix.basename(MODULE_PATH));
    assert.equal(provenance.bytes, moduleBytes.length);
    assert.equal(provenance.sha256, createHash('sha256').update(moduleBytes).digest('hex'), `${MODULE_PATH} is not the module ${PROVENANCE_PATH} names`);
  });

  test('the module speaks the ABI the loader expects', () => {
    assert.equal(moduleAbiVersion(moduleBytes), LEDGER_CORE_ABI_VERSION);
    assert.equal(provenance.abiVersion, LEDGER_CORE_ABI_VERSION);
  });

  test('the provenance records the pinned toolchain and the build script\'s flags', () => {
    assert.equal(provenance.toolchain.channel, toolchain.channel);
    assert.match(provenance.toolchain.rustc, new RegExp(`^rustc ${toolchain.channel.replace(/\./g, '\\.')} \\(`));
    assert.match(provenance.toolchain.cargo, new RegExp(`^cargo ${toolchain.channel.replace(/\./g, '\\.')} \\(`));
    assert.deepEqual([provenance.target, provenance.build], [WASM_TARGET,
      { command: `cargo ${BUILD_ARGS.join(' ')}`, rustflags: [...RUSTFLAG_TEMPLATES], environment: { ...BUILD_ENVIRONMENT } }]);
    // Field for field and byte for byte what the build script writes.
    assert.equal(provenanceText, renderProvenance(provenanceRecord({ sources: ledgerCoreSources(), moduleBytes, abiVersion: LEDGER_CORE_ABI_VERSION,
      toolchain, rustc: provenance.toolchain.rustc, cargo: provenance.toolchain.cargo })));
  });

  test('the crate has no dependencies of any kind', () => {
    const manifest = read(`${CRATE_DIR}/Cargo.toml`).toString('utf8');
    const sections = [...manifest.matchAll(/^\[([^\]]+)\]\s*$/gm)].map((match) => match[1]);
    assert.ok(sections.includes('dependencies'));
    for (const section of sections.filter((name) => /(?:^|[.])(?:dev-|build-)?dependencies(?:\.|$)/.test(name) || name.startsWith('target.') || name === 'patch' || name.startsWith('patch.') || name === 'replace')) {
      const body = manifest.split(`[${section}]`)[1].split(/^\[/m)[0];
      assert.equal(body.replace(/#.*$/gm, '').trim(), '', `[${section}] must stay empty`);
    }
    const lock = read(`${CRATE_DIR}/Cargo.lock`).toString('utf8');
    assert.deepEqual([...lock.matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1]), ['ledger-core'], 'Cargo.lock holds only the crate itself');
  });

  test('the committed vectors are what the generator writes', () => {
    assert.equal(readFileSync(VECTORS_FILE, 'utf8'), renderVectors(),
      `${path.relative(repositoryRoot, VECTORS_FILE)} is stale: node ${CRATE_DIR}/tests/generate-vectors.mjs`);
  });
});

describe('ledger core build script', () => {
  test('a missing toolchain, component or target fails with the command that installs it', () => {
    const install = installCommand(toolchain);
    assert.equal(install, `rustup toolchain install ${toolchain.channel} --profile minimal --component rustfmt,clippy --target wasm32-unknown-unknown`);
    const calls = [];
    const missing = (args, options) => { calls.push({ args, auto: options.env.RUSTUP_AUTO_INSTALL }); return { status: 1, stdout: '', stderr: 'not installed' }; };
    assert.throws(() => locateToolchain(toolchain, { run: (command, args, options) => missing(args, options) }),
      (error) => error.message.includes(`Rust ${toolchain.channel} is not installed`) && error.message.includes(install));
    assert.deepEqual(calls, [{ args: ['which', '--toolchain', toolchain.channel, 'rustc'], auto: '0' }]);
    assert.throws(() => locateToolchain(toolchain, { run: () => ({ error: Object.assign(new Error('spawn rustup ENOENT'), { code: 'ENOENT' }) }) }),
      (error) => error.message.includes('rustup is not installed') && error.message.includes(install));
    // A toolchain directory without clippy and without the WebAssembly target.
    const home = mkdtempSync(path.join(os.tmpdir(), 'ledger-core-toolchain-'));
    scratch.push(home);
    mkdirSync(path.join(home, 'bin'));
    for (const name of ['cargo', 'rustc', 'rustdoc', 'rustfmt', 'cargo-fmt']) writeFileSync(path.join(home, 'bin', name), '');
    assert.throws(() => locateToolchain(toolchain, { run: () => ({ status: 0, stdout: `${path.join(home, 'bin', 'rustc')}\n` }) }),
      (error) => error.message.includes('cargo-clippy, clippy-driver, the wasm32-unknown-unknown target') && error.message.includes(install));
    for (const name of ['cargo-clippy', 'clippy-driver']) writeFileSync(path.join(home, 'bin', name), '');
    mkdirSync(path.join(home, 'lib', 'rustlib', 'wasm32-unknown-unknown', 'lib'), { recursive: true });
    assert.deepEqual(locateToolchain(toolchain, { run: () => ({ status: 0, stdout: `${path.join(home, 'bin', 'rustc')}\n` }) }), { bin: path.join(home, 'bin'), home });
  });

  test('the digest takes build.rs and crate Cargo configuration when they exist, and refuses Cargo configuration above the build', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ledger-core-crate-'));
    scratch.push(root);
    const crate = path.join(root, CRATE_DIR);
    for (const file of [...CRATE_INPUTS, 'src/lib.rs', 'tests/vectors.rs', '.gitignore']) {
      mkdirSync(path.dirname(path.join(crate, file)), { recursive: true });
      writeFileSync(path.join(crate, file), file);
    }
    const base = ledgerCoreSources(root);
    assert.deepEqual(base.map((source) => source.path), [...CRATE_INPUTS, 'src/lib.rs']);
    mkdirSync(path.join(crate, '.cargo'));
    writeFileSync(path.join(crate, 'build.rs'), 'fn main() {}\n');
    writeFileSync(path.join(crate, '.cargo', 'config.toml'), '[build]\n');
    const extended = ledgerCoreSources(root);
    assert.deepEqual(extended.map((source) => source.path), [...CRATE_INPUTS, 'build.rs', '.cargo/config.toml', 'src/lib.rs']);
    assert.notEqual(ledgerCoreSourceDigest(extended), ledgerCoreSourceDigest(base));
    // A file that is neither an input nor a test is uncovered.
    writeFileSync(path.join(crate, 'notes.toml'), '');
    const inputs = new Set(extended.map((source) => source.path));
    assert.deepEqual(ledgerCoreCrateFiles(root).filter((file) => !inputs.has(file) && !NON_BUILD_CRATE_FILES.some((pattern) => pattern.test(file))), ['notes.toml']);
    assert.deepEqual(ancestorCargoConfigs(crate), []);
    mkdirSync(path.join(root, 'packages', '.cargo'));
    writeFileSync(path.join(root, 'packages', '.cargo', 'config.toml'), '[build]\n');
    assert.deepEqual(ancestorCargoConfigs(crate), [path.join(root, 'packages', '.cargo', 'config.toml')]);
  });

  test('the toolchain file pins an exact release with what the build uses', () => {
    assert.match(toolchain.channel, /^\d+\.\d+\.\d+$/);
    assert.deepEqual([...toolchain.components].sort(), ['clippy', 'rustfmt']);
    assert.deepEqual(toolchain.targets, [WASM_TARGET]);
  });

  test('refuses an unknown argument before building anything', () => {
    assert.throws(() => main(['--chek']), /Unknown argument: --chek/);
  });
});
