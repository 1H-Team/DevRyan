#!/usr/bin/env node
// Writes the method list of the native ledger's `ready` message
// (packages/harness-runtime/native/ledger/ledger-native/src/methods.rs) from
// the product itself: every function key of the runtime the ledger worker
// builds, in the worker's order. Constructing the runtime touches no file.
//
//   node scripts/ledger-native/generate-methods.mjs           rewrite the file
//   node scripts/ledger-native/generate-methods.mjs --check   fail when it is stale
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createSessionMutationRuntime } from '../../packages/harness-runtime/lib/session-mutations.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const METHODS_FILE = 'packages/harness-runtime/native/ledger/ledger-native/src/methods.rs';

/** The runtime's methods as the worker's `ready` lists them. */
export function productMethods() {
  // An absolute storage root is all the factory checks; nothing is created.
  const runtime = createSessionMutationRuntime({ directory: path.join(os.tmpdir(), 'devryan-ledger-methods-unused'), synchronousWalks: true });
  return Object.keys(runtime).filter((name) => typeof runtime[name] === 'function');
}

/** The generated Rust source for a method list. */
export function methodsSource(methods = productMethods()) {
  const rows = methods.map((name) => `    ${JSON.stringify(name)},`).join('\n');
  return `//! Every method of the product's ledger runtime, in the order the worker's
//! \`ready\` lists them. Generated from the product by
//! \`node scripts/ledger-native/generate-methods.mjs\`; the build script's
//! contract test fails when it is stale. Do not edit.
#![forbid(unsafe_code)]

pub const METHODS: &[&str] = &[
${rows}
];
`;
}

/** The tracked file's text, or null when it is missing. */
export function trackedSource(root = repositoryRoot) {
  try { return readFileSync(path.join(root, METHODS_FILE), 'utf8'); } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = methodsSource();
  if (process.argv.includes('--check')) {
    if (trackedSource() !== expected) {
      console.error(`${METHODS_FILE} is stale; regenerate it with: node scripts/ledger-native/generate-methods.mjs`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(path.join(repositoryRoot, METHODS_FILE), expected);
    console.log(`Wrote ${METHODS_FILE}.`);
  }
}
