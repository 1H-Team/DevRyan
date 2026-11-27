#!/usr/bin/env node
// Records the product families of the port map (product/product-port-map.json) from
// the product's own tests and judges the recording (design file 29 §2, §4.4;
// package C0c). Writes only into scratch, never into the repository.
//
//   node scripts/client-conformance/product.mjs [--runs=2] [--families=a,b] [--json=<file>] [--out=<new or empty dir>] [--keep-artifacts] [<test file or directory, relative to packages/ui>...]
//
// It is the family command (family-run.mjs, which the self-test runs on the
// toys) set up for the product: without targets it records every test file
// under packages/ui/src/sync and every other test file of packages/ui/src that
// loads a family module (found by a discover run of those files), less the
// census file's excluded files (product/product-census.json). A
// passed-through caller under packages/ui/src that is no test code by the
// naming rule and that no web entry point reaches (the graph of
// scripts/check-unreached-files.mjs, imported) makes the run inconclusive.
// Exit codes and the rest: family-run.mjs and docs/TESTING.md.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkBrowserGraph } from '../check-browser-graph.mjs';
import { UNREACHED_ENTRIES } from '../check-unreached-files.mjs';
import { familyCommand } from './family-run.mjs';
import { HARNESS_DIR, RECORDING_TEST_TIMEOUT_MS, REPOSITORY_ROOT } from './record.mjs';

export const PRODUCT_DIR = path.join(HARNESS_DIR, 'product');
export const PRODUCT_PORT_MAP = path.join(PRODUCT_DIR, 'product-port-map.json');
export const PRODUCT_CENSUS = path.join(PRODUCT_DIR, 'product-census.json');
export const UI_DIR = path.join(REPOSITORY_ROOT, 'packages/ui');

/** The files the product's own entry points reach (the browser graph of the unreached-files check), repository-relative. */
export function productReachable(root = REPOSITORY_ROOT) {
  return walkBrowserGraph({ root, entries: UNREACHED_ENTRIES.filter((file) => existsSync(path.join(root, file))) }).visited;
}

export const PRODUCT_SETUP = Object.freeze({
  portMapFile: PRODUCT_PORT_MAP, censusFile: PRODUCT_CENSUS, cwd: UI_DIR, root: REPOSITORY_ROOT,
  always: ['src/sync'], search: ['src'], scope: 'packages/ui/src/', reachable: () => productReachable(),
  // Every run, plain and recorded, with the same explicit per-test time limit (record.mjs RECORDING_TEST_TIMEOUT_MS).
  timeoutMs: RECORDING_TEST_TIMEOUT_MS,
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await familyCommand(process.argv.slice(2), PRODUCT_SETUP, { name: 'product.mjs' });
}
