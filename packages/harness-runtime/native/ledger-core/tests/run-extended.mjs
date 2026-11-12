#!/usr/bin/env node
// The extended run of the JavaScript-semantics tests: much larger seeded
// vector sets than the tracked ones, plus the record corpus, generated under
// this Node into a scratch directory under the OS temp dir, then
// `cargo test --release` with LEDGER_CORE_EXTENDED_DIR pointing at it. The
// scratch is removed on success, failure and interruption unless
// --keep-artifacts (or DEVRYAN_KEEP_ARTIFACTS=1).
//
//   node packages/harness-runtime/native/ledger-core/tests/run-extended.mjs [--scale S] [--corpus <dir>]... [--keep-artifacts]
//
// --scale multiplies the default counts (json 500,000; numbers 1,000,000;
// collate 200,000 strings; base64 200,000; strings 50,000; sort 20,000).
// --corpus adds every record under a directory (json-corpus.mjs --dir). The
// aged-profile fixture's records are always included; they are written by
// a child process under the test isolation preload, because the fixture runs
// the real ledger. Needs the crate's pinned Rust toolchain
// (scripts/build-ledger-core.mjs finds it).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CRATE_DIR, locateToolchain, readToolchainFile, repositoryRoot } from '../../../../../scripts/build-ledger-core.mjs';
import { keepArtifactsRequested, scratchParent } from '../../../../../scripts/qa/run-root.mjs';
import { renderBase64 } from './generate-base64.mjs';
import { renderCollate } from './generate-collate.mjs';
import { knownDiscrepanciesSeen, renderJson } from './generate-json.mjs';
import { renderNumbers } from './generate-numbers.mjs';
import { renderSort } from './generate-sort.mjs';
import { renderStrings } from './generate-strings.mjs';

export const EXTENDED_COUNTS = Object.freeze({ 'json.tsv': [renderJson, 500_000], 'numbers.tsv': [renderNumbers, 1_000_000], 'collate.tsv': [renderCollate, 200_000],
  'base64.tsv': [renderBase64, 200_000], 'strings.tsv': [renderStrings, 50_000], 'sort.tsv': [renderSort, 20_000] });

function main(argv) {
  const at = argv.indexOf('--scale');
  const scale = at < 0 ? 1 : Number(argv[at + 1]);
  if (!(scale > 0)) throw new Error(`--scale must be positive, not ${argv[at + 1]}`);
  const corpora = argv.flatMap((arg, index) => (arg === '--corpus' ? [argv[index + 1]] : []));
  const toolchain = readToolchainFile();
  const located = locateToolchain(toolchain);
  const parent = scratchParent('ledger-core');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(parent, 'extended-'));
  const keep = keepArtifactsRequested({ argv });
  let failed = true;
  const cleanup = () => { if (!keep) rmSync(scratch, { recursive: true, force: true }); else console.error(`Kept ${scratch}`); };
  const interrupted = () => { cleanup(); process.exit(130); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const vectors = path.join(scratch, 'vectors');
    mkdirSync(vectors);
    console.log(`Node ${process.version}, V8 ${process.versions.v8}, ICU ${process.versions.icu}; scratch ${scratch}`);
    for (const [file, [render, count]] of Object.entries(EXTENDED_COUNTS)) {
      const started = Date.now();
      const text = render(Math.round(count * scale));
      writeFileSync(path.join(vectors, file), text);
      console.log(`${file}: ${Math.round(count * scale)} generated cases, ${Buffer.byteLength(text)} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s`);
      if (file === 'json.tsv') {
        for (const known of knownDiscrepanciesSeen) console.log(`known engine discrepancy ${known.id} at ${known.row} on ${known.engine}: still observed; the Rust is checked against the specification's answer`);
      }
    }
    const corpus = spawnSync(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', path.join(CRATE_DIR, 'tests', 'json-corpus.mjs'),
      '--out', path.join(vectors, 'json-corpus.tsv'), '--aged-profile', '--min', '300', ...corpora.flatMap((directory) => ['--dir', path.resolve(directory)])], { cwd: repositoryRoot, stdio: 'inherit' });
    if (corpus.error || corpus.status !== 0) throw new Error('json-corpus.mjs failed');
    const env = { ...process.env, LEDGER_CORE_EXTENDED_DIR: vectors, LEDGER_CORE_CORPUS: path.join(vectors, 'json-corpus.tsv'), RUSTUP_TOOLCHAIN: toolchain.channel, RUSTUP_AUTO_INSTALL: '0',
      PATH: `${located.bin}${path.delimiter}${process.env.PATH ?? ''}`, CARGO_TARGET_DIR: path.join(scratch, 'target') };
    const started = Date.now();
    const result = spawnSync(path.join(located.bin, 'cargo'), ['test', '--locked', '--offline', '--release', '--no-fail-fast', '--test', 'json', '--test', 'numbers', '--test', 'collate',
      '--test', 'base64', '--test', 'strings', '--test', 'sort', '--test', 'corpus', '--', '--nocapture'], { cwd: path.join(repositoryRoot, CRATE_DIR), env, stdio: 'inherit' });
    console.log(`cargo test: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (result.error || result.status !== 0) throw new Error(`cargo test failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
    failed = false;
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    if (failed && !keep) console.error('Removing the scratch; rerun with --keep-artifacts to keep it.');
    cleanup();
  }
}

try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
