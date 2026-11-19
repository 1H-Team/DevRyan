import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LEDGER_CORE_ABI_VERSION, LEDGER_CORE_FALLBACK_CAUSES, LEDGER_CORE_RETAINED_MEMORY_BYTES, LEDGER_CORE_SWITCH, createLedgerCore, ledgerCoreDiff } from './ledger-core.js';
import { HARNESS_BEHAVIOUR_SWITCHES } from './sanitizer.js';
import { MUTATION_DIFF_WORK_BUDGET } from './session-mutation-text.js';
import { VECTORS_FILE, parseVectors, referencePairs } from '../native/ledger-core/tests/generate-vectors.mjs';

const MODULE = new URL('./native/ledger-core.wasm', import.meta.url);
const PROVENANCE = new URL('./native/ledger-core.json', import.meta.url);
const ON = Object.freeze({ DEVRYAN_LEDGER_RUST: '1' });
const scratch = mkdtempSync(path.join(os.tmpdir(), 'ledger-core-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let written = 0;
/** A module file and a provenance file that matches it, unless `provenance` overrides. */
function moduleFiles(bytes, provenance = { schemaVersion: 1, sha256: sha256(bytes), bytes: bytes.length }) {
  written += 1;
  const moduleFile = path.join(scratch, `module-${written}.wasm`), provenanceFile = path.join(scratch, `module-${written}.json`);
  writeFileSync(moduleFile, bytes);
  writeFileSync(provenanceFile, typeof provenance === 'string' ? provenance : JSON.stringify(provenance));
  return { moduleUrl: pathToFileURL(moduleFile), provenanceUrl: pathToFileURL(provenanceFile) };
}

// A hand-assembled module with the ledger core's exports, to force each failure
// the real module never shows: a trap, an error status, a short script, a
// failed allocation, a foreign ABI version, an import that cannot be linked.
const uleb = (value) => { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return out; };
const sleb = (value) => { const out = []; for (;;) { const byte = value & 0x7f; value >>= 7; if ((value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40)) { out.push(byte); return out; } out.push(byte | 0x80); } };
const name = (text) => [...uleb(text.length), ...Buffer.from(text)];
const section = (id, items) => [id, ...uleb(items.flat().length + uleb(items.length).length), ...uleb(items.length), ...items.flat()];
const i32 = (value) => [0x41, ...sleb(value)];
const store = (address, value) => [...i32(address), ...i32(value), 0x36, 0x02, 0x00];
const body = (code) => [...uleb(code.length + 2), 0x00, ...code, 0x0b];
function fakeModule({ abi = LEDGER_CORE_ABI_VERSION, alloc = 1024, diff = 'trap', linkImport = false } = {}) {
  const diffCode = {
    trap: [0x00],
    status: [...store(64, 7), ...i32(64)],
    short: [...store(68, 1), ...store(76, 1), ...i32(64)],
  }[diff];
  const shift = linkImport ? 1 : 0;
  const functions = ['ledger_core_abi_version', 'ledger_core_alloc', 'ledger_core_free', 'ledger_core_diff', 'ledger_core_free_result'];
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [[0x60, 0x00, 0x01, 0x7f], [0x60, 0x01, 0x7f, 0x01, 0x7f], [0x60, 0x02, 0x7f, 0x7f, 0x00],
      [0x60, 0x05, 0x7f, 0x7f, 0x7f, 0x7f, 0x7c, 0x01, 0x7f], [0x60, 0x01, 0x7f, 0x00]]),
    ...(linkImport ? section(2, [[...name('env'), ...name('missing'), 0x00, 0x00]]) : []),
    ...section(3, [[0x00], [0x01], [0x02], [0x03], [0x04]]),
    ...section(5, [[0x00, 0x01]]),
    ...section(7, [[...name('memory'), 0x02, 0x00], ...functions.map((entry, index) => [...name(entry), 0x00, ...uleb(index + shift)])]),
    ...section(10, [body(i32(abi)), body(i32(alloc)), body([]), body(diffCode), body([])]),
  ];
  return Buffer.from(bytes);
}

/** A loader that is on, with its journal. */
function loader(files) {
  const diagnostics = [];
  const core = createLedgerCore({ ...files, environment: ON });
  return { core, diagnostics, diff: (before, after, budget = MUTATION_DIFF_WORK_BUDGET) => core.diff(before, after, budget, { onDiagnostic: (record) => diagnostics.push(record) }) };
}
const journaled = (cause) => [{ phase: 'ledger_core', state: 'fallback', code: `ledger_core_${cause}` }];

describe('ledger core loader', () => {
  test('reproduces every JavaScript vector, and the vectors are still what JavaScript produces', () => {
    const vectors = parseVectors(readFileSync(VECTORS_FILE, 'utf8'));
    expect(vectors.length).toBeGreaterThan(1000);
    const { diff, diagnostics } = loader();
    const mismatches = [];
    for (const vector of vectors) {
      const reference = referencePairs(vector);
      if (reference.join() !== vector.pairs.join()) mismatches.push(`${vector.name}: stale vector (regenerate)`);
      const pairs = diff(vector.before, vector.after, vector.budget);
      if (!pairs || [...pairs].join() !== vector.pairs.join()) mismatches.push(`${vector.name}: ${pairs ? [...pairs].join() : 'null'} != ${vector.pairs.join()}`);
    }
    expect(mismatches).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('is off unless DEVRYAN_LEDGER_RUST is exactly 1, read on every call, and journals nothing when off', () => {
    const environment = {};
    const diagnostics = [];
    const core = createLedgerCore({ environment });
    const call = () => core.diff('abc', 'abd', 10, { onDiagnostic: (record) => diagnostics.push(record) });
    expect(call()).toBeNull();
    for (const value of ['0', 'true', 'yes', 'on', ' 1', '1 ', '']) {
      environment.DEVRYAN_LEDGER_RUST = value;
      expect(call()).toBeNull();
    }
    expect(core.inspect().loaded).toBe(false);
    environment.DEVRYAN_LEDGER_RUST = '1';
    expect([...call()]).toEqual([0, 2, 1, 1, 2, 1]);
    environment.DEVRYAN_LEDGER_RUST = '0';
    expect(call()).toBeNull();
    environment.DEVRYAN_LEDGER_RUST = '1';
    expect([...call()]).toEqual([0, 2, 1, 1, 2, 1]);
    expect(diagnostics).toEqual([]);
    // Run fingerprints record the switch.
    expect(HARNESS_BEHAVIOUR_SWITCHES).toContain(LEDGER_CORE_SWITCH);
    // The process loader reads process.env; the guard leaves the switch unset.
    if (process.env.DEVRYAN_LEDGER_RUST !== '1') expect(ledgerCoreDiff('abc', 'abd', 10)).toBeNull();
  });

  test('every fallback cause answers "use JavaScript" and is journaled once', () => {
    const real = readFileSync(MODULE);
    const corrupt = Buffer.from(real);
    corrupt[corrupt.length >> 1] ^= 0xff;
    const unparsable = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05]);
    const cases = {
      missing: { moduleUrl: pathToFileURL(path.join(scratch, 'absent.wasm')), provenanceUrl: PROVENANCE },
      provenance: moduleFiles(real, '{ not json'),
      hash: moduleFiles(corrupt, readFileSync(PROVENANCE, 'utf8')),
      compile: moduleFiles(unparsable),
      abi: moduleFiles(fakeModule({ abi: LEDGER_CORE_ABI_VERSION + 1 })),
      instantiate: moduleFiles(fakeModule({ linkImport: true })),
      memory: moduleFiles(fakeModule({ alloc: 0 })),
      trap: moduleFiles(fakeModule({ diff: 'trap' })),
      status: moduleFiles(fakeModule({ diff: 'status' })),
      result: moduleFiles(fakeModule({ diff: 'short' })),
    };
    const covered = new Set();
    for (const [cause, files] of Object.entries(cases)) {
      const { diff, diagnostics } = loader(files);
      expect(diff('abc', 'abd')).toBeNull();
      expect(diff('abcdef', 'abcxyz')).toBeNull();
      expect(diagnostics).toEqual(journaled(cause));
      covered.add(cause);
    }
    // The real module, with input it must not be given.
    const { core, diff, diagnostics } = loader();
    for (const budget of [1.5, Number.NaN, Infinity, 2 ** 53, '10', undefined]) {
      expect(core.diff('abc', 'abd', budget, { onDiagnostic: (record) => diagnostics.push(record) })).toBeNull();
    }
    expect(diff('abĀ', 'ab')).toBeNull();
    expect(diff('ab', '\u{1f600}')).toBeNull();
    expect(diff(Buffer.from('ab'), 'ab')).toBeNull();
    expect(diagnostics).toEqual([...journaled('budget'), ...journaled('input')]);
    expect([...diff('abc', 'abd', 10)]).toEqual([0, 2, 1, 1, 2, 1]);
    covered.add('budget').add('input');
    expect([...covered].sort()).toEqual([...LEDGER_CORE_FALLBACK_CAUSES].sort());
  });

  test('a trap drops the instance; the next call gets a new one from the same compiled module', () => {
    const { core, diff } = loader(moduleFiles(fakeModule({ diff: 'trap' })));
    expect(diff('a', 'b')).toBeNull();
    expect(core.inspect()).toMatchObject({ loaded: true, failed: null, instances: 1, memoryBytes: 0 });
    expect(diff('a', 'b')).toBeNull();
    expect(core.inspect()).toMatchObject({ loaded: true, instances: 2, memoryBytes: 0 });
  });

  test('an observer that throws does not reach the caller', () => {
    const core = createLedgerCore({ moduleUrl: pathToFileURL(path.join(scratch, 'absent.wasm')), environment: ON });
    expect(core.diff('a', 'b', 10, { onDiagnostic: () => { throw new Error('observer'); } })).toBeNull();
  });

  test('keeps one instance for small calls and drops one whose memory passed the cap, reusing the compiled module', () => {
    const { core, diff } = loader();
    const line = 'const value = ledger.run(text);\n';
    const edited = (text) => `${text.slice(0, 1000)}X${text.slice(1001, text.length - 1000)}Y${text.slice(text.length - 999)}`;
    // Below the cap: 32 KiB and 256 KiB edits and tiny diffs all run on the first instance.
    for (const size of [0, 32 * 1024, 256 * 1024]) {
      const before = size ? line.repeat(size / line.length) : 'abc';
      const after = size ? edited(before) : 'abd';
      expect([...diff(before, after)]).toEqual(referencePairs({ before, after, budget: MUTATION_DIFF_WORK_BUDGET }));
      const state = core.inspect();
      expect(state).toMatchObject({ loaded: true, failed: null, instances: 1 });
      expect(state.memoryBytes).toBeGreaterThan(0);
      expect(state.memoryBytes).toBeLessThanOrEqual(LEDGER_CORE_RETAINED_MEMORY_BYTES);
    }
    // Above it: a 2 MiB edit grows the memory past 8 MiB, so no instance holds it afterwards.
    const before = line.repeat((2 * 1024 * 1024) / line.length);
    const after = edited(before);
    expect([...diff(before, after)]).toEqual(referencePairs({ before, after, budget: MUTATION_DIFF_WORK_BUDGET }));
    expect(core.inspect()).toMatchObject({ loaded: true, failed: null, memoryBytes: 0, instances: 1 });
    // The next call instantiates the same compiled module again.
    expect([...diff('abc', 'abd', 10)]).toEqual([0, 2, 1, 1, 2, 1]);
    expect(core.inspect()).toMatchObject({ loaded: true, instances: 2 });
    expect(core.inspect().memoryBytes).toBeGreaterThan(0);
  });

  test('accepts any options value and never throws for it', () => {
    const { core } = loader();
    const hostile = Object.defineProperty({}, 'onDiagnostic', { get() { throw new Error('getter'); } });
    for (const options of [null, undefined, 0, 'x', true, [], () => {}, { onDiagnostic: 'not a function' }, { onDiagnostic: null }, hostile]) {
      expect([...core.diff('abc', 'abd', 10, options)]).toEqual([0, 2, 1, 1, 2, 1]);
      expect(core.diff('abc', 'abd', 1.5, options)).toBeNull();
    }
  });

  test('a copy laid out like the packaged app loads its own module from a worker thread', () => {
    // Resources/app.asar.unpacked/node_modules/@devryan/harness-runtime, without packaging.
    // The packaged proof itself is the release dry run.
    const unpacked = path.join(scratch, 'Resources', 'app.asar.unpacked', 'node_modules', '@devryan', 'harness-runtime');
    mkdirSync(path.join(unpacked, 'lib'), { recursive: true });
    writeFileSync(path.join(unpacked, 'package.json'), JSON.stringify({ name: '@devryan/harness-runtime', type: 'module' }));
    cpSync(fileURLToPath(new URL('./ledger-core.js', import.meta.url)), path.join(unpacked, 'lib', 'ledger-core.js'));
    cpSync(fileURLToPath(new URL('./native', import.meta.url)), path.join(unpacked, 'lib', 'native'), { recursive: true });
    // A worker beside the loader, as the ledger worker (lib/session-mutation-worker.js) sits.
    writeFileSync(path.join(unpacked, 'lib', 'ledger-core-probe.worker.js'), `import { parentPort } from 'node:worker_threads';
import { ledgerCoreDiff } from './ledger-core.js';
const seen = [];
const pairs = ledgerCoreDiff('abc\\nxyz\\n', 'abc\\nXyz\\n', 4000000, { onDiagnostic: (record) => seen.push(record.code) });
parentPort.postMessage({ pairs: pairs ? [...pairs] : null, seen });
`);
    const host = path.join(scratch, 'Resources', 'ledger-host.mjs');
    writeFileSync(host, `import { Worker } from 'node:worker_threads';
const worker = new Worker(new URL(process.argv[2]), { env: { ...process.env, DEVRYAN_LEDGER_RUST: '1' } });
const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
await worker.terminate();
console.log(JSON.stringify(result));
`);
    const loaderUrl = pathToFileURL(path.join(unpacked, 'lib', 'ledger-core-probe.worker.js')).href;
    const expected = referencePairs({ before: 'abc\nxyz\n', after: 'abc\nXyz\n', budget: MUTATION_DIFF_WORK_BUDGET });
    const run = (executable) => {
      const result = spawnSync(executable, [host, loaderUrl], { encoding: 'utf8', timeout: 20_000 });
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    };
    for (const executable of ['node', process.execPath]) expect(run(executable)).toEqual({ pairs: expected, seen: [] });
    // It read the copy's module, not the source tree's: without it, the call falls back.
    rmSync(path.join(unpacked, 'lib', 'native', 'ledger-core.wasm'));
    for (const executable of ['node', process.execPath]) expect(run(executable)).toEqual({ pairs: null, seen: ['ledger_core_missing'] });
  }, 40_000);

  test('runs on the main thread and in a worker thread, under Node and under Bun', () => {
    const probe = path.join(scratch, 'probe.mjs');
    writeFileSync(probe, `import { Worker, isMainThread, parentPort } from 'node:worker_threads';
const { createLedgerCore } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./ledger-core.js', import.meta.url))).href)});
const run = () => { const pairs = createLedgerCore({ environment: { DEVRYAN_LEDGER_RUST: '1' } }).diff('abc\\nxyz\\n', 'abc\\nXyz\\n', 4000000); return pairs ? [...pairs] : null; };
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const inWorker = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  await worker.terminate();
  console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', main: run(), worker: inWorker }));
} else parentPort.postMessage(run());
`);
    const expected = referencePairs({ before: 'abc\nxyz\n', after: 'abc\nXyz\n', budget: MUTATION_DIFF_WORK_BUDGET });
    for (const [runtime, executable] of [['node', 'node'], [process.versions.bun ? 'bun' : 'node', process.execPath]]) {
      const result = spawnSync(executable, [probe], { encoding: 'utf8', timeout: 20_000 });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ runtime, main: expected, worker: expected });
    }
  }, 30_000);
});
