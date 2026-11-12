#!/usr/bin/env node
// The files whose change reruns the native ledger's verify: fast validate's
// `ledger-native` command and CI's two "Rust native ledger I/O" steps (whose
// pull-request filter prints this list). They are the Rust workspace and the
// ledger core it builds on, the JavaScript it must stay equal to, and every
// local module the build script and the differential tests load, the
// isolation preload the verify starts them with included. The build script's
// contract test follows those imports and fails when one is missing here.
// A product module the tests load is listed itself; its own imports are the
// product's and are gated by its package's tests, and the product modules the
// isolation guard imports for its canary (which the verify never runs) are not
// inputs. The extended run (the build script's --extended) is not the gate:
// what only it loads, such as the aged-profile corpus and the dual-run
// scenarios, is not listed, and the contract test fails on a listed file the
// verify does not load.
//
//   node scripts/ledger-native/inputs.mjs   prints the list, space-separated, as git pathspecs
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Inputs: a path ending in `/` is a directory prefix; any other is one file. */
export const LEDGER_NATIVE_INPUTS = Object.freeze([
  'packages/harness-runtime/native/ledger/',
  'packages/harness-runtime/native/ledger-core/',
  'packages/harness-runtime/lib/atomic-file.js',
  'packages/harness-runtime/lib/session-changes-git.js',
  'packages/harness-runtime/lib/session-changes-store.js',
  'packages/harness-runtime/lib/session-changes-trees.js',
  'scripts/build-ledger-native.mjs',
  'scripts/ledger-native/',
  'scripts/build-ledger-core.mjs',
  'scripts/ledger-dual-run/dual-run-arm.mjs',
  'scripts/ledger-dual-run/dual-run-codec.mjs',
  'scripts/ledger-dual-run/dual-run-compare.mjs',
  'scripts/ledger-dual-run/dual-run-identity.mjs',
  'scripts/ledger-dual-run/dual-run-runner.mjs',
  'scripts/ledger-dual-run/dual-run-snapshot.mjs',
  'scripts/ledger-dual-run/ledger-preload.cjs',
  'scripts/ledger-dual-run/ledger-process.mjs',
  'scripts/qa/run-root.mjs',
  'scripts/test-isolation-check.mjs',
  'scripts/test-isolation-guard.mjs',
  'scripts/test-isolation-preload.mjs',
]);

/** Whether a repository-relative POSIX path is an input of the native ledger's verify. */
export const isLedgerNativeInput = (file) => LEDGER_NATIVE_INPUTS.some((input) => (input.endsWith('/') ? file.startsWith(input) : file === input));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${LEDGER_NATIVE_INPUTS.join(' ')}\n`);
}
