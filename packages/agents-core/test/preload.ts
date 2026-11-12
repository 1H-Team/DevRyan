// DevRyan test preload: upstream algorithm tests exercise Slim's original code
// against real filesystem and network owners, the same seams the native host
// lends in production (src/devryan/owners.ts).
import { afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installReviewedSlimTestOwners } from '../src/devryan/owners';
import { saveReviewedWebfetchBinary } from '../src/tools/smartfetch/binary';
import { createReviewedWebfetchCache } from '../src/tools/smartfetch/cache';

// bun test shares one process: keep every test off the real user directories
// (upstream test-isolation.ts). HOME is already the private home of the test
// isolation guard, whose preload runs first and refuses otherwise (Bun reads
// HOME only at startup, so it cannot be moved here); each process still gets
// its own XDG folders, inside the guard's private root.
const isolationRoot = mkdtempSync(path.join(process.env.DEVRYAN_TEST_ISOLATION_ROOT ?? tmpdir(), `devryan-agents-core-test-${process.pid}-`));
process.env.XDG_DATA_HOME = path.join(isolationRoot, 'data');
process.env.XDG_CONFIG_HOME = path.join(isolationRoot, 'config');
process.env.XDG_CACHE_HOME = path.join(isolationRoot, 'cache');
process.env.OPENCODE_LOG_DIR = path.join(isolationRoot, 'log');
delete process.env.OPENCODE_CONFIG_DIR;
afterAll(() => rmSync(isolationRoot, { recursive: true, force: true }));

const reviewedJsdom = path.resolve(
  import.meta.dir,
  '../../web/runtime/reviewed-inputs/jsdom-30.1.1/node_modules/jsdom/lib/api.js',
);

beforeEach(() => {
  installReviewedSlimTestOwners({
    path: {
      stat: (file) => fs.stat(file),
      realpath: (file) => fs.realpath(file),
      readText: (file) => fs.readFile(file, 'utf8'),
    },
    webfetch: {
      sessionID: 'test-session',
      signal: new AbortController().signal,
      cache: createReviewedWebfetchCache(),
      fetch: (url, init) => globalThis.fetch(url, init),
      loadJSDOM: () => import(pathToFileURL(reviewedJsdom).href),
      saveBinary: ({ directory, data, contentType, filename }) =>
        saveReviewedWebfetchBinary(directory, data, contentType, filename),
      secondary: async () => {
        throw new Error('secondary model is host-owned in DevRyan');
      },
    },
  });
});
