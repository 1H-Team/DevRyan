import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { assertPerfCleanupComplete, capturePerfJournal, observePerfBrowserErrors } from './electron-run-evidence.mjs';

test('cleanup failure preserves the original workload error in the final rejection', () => {
  const original = new Error('History anchor moved');
  assert.doesNotThrow(() => assertPerfCleanupComplete({ complete: true, errors: [] }, original));
  assert.throws(() => assertPerfCleanupComplete({ complete: false, errors: ['Owned app did not exit'] }, original), error => {
    assert.equal(error.errors[0], original);
    assert.equal(error.errors[1].message, 'Owned app did not exit');
    return true;
  });
});

test('browser diagnostics retain startup/runtime errors, redact credentials, bound evidence and unsubscribe', () => {
  const listeners = new Map();
  const cdp = { on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); } };
  const observation = observePerfBrowserErrors(cdp, { runDirectory: '/repository/.cache/run', repositoryRoot: '/repository' });
  listeners.get('Runtime.consoleAPICalled')({ type: 'log', args: [{ value: 'normal message' }] });
  listeners.get('Runtime.exceptionThrown')({ timestamp: 1, exceptionDetails: { exception: { description: 'Error at /repository/.cache/run/file.js' } } });
  listeners.get('Runtime.consoleAPICalled')({ type: 'error', timestamp: 2, args: [{ value: 'authorization=abcdefghijklmnop' }] });
  listeners.get('Log.entryAdded')({ entry: { level: 'error', source: 'network', text: 'Expected fixture rejection: 503' } });
  assert.equal(observation.evidence.seen, 3);
  assert.match(observation.evidence.entries[0].message, /<PERF_RUN>/);
  assert.doesNotMatch(JSON.stringify(observation.evidence), /abcdefghijklmnop/);
  assert.equal(observation.evidence.entries[2].kind, 'log.network');
  for (let index = 0; index < 200; index++) listeners.get('Runtime.consoleAPICalled')({ type: 'error', args: [{ value: 'x'.repeat(10_000) }] });
  assert.ok(observation.evidence.dropped > 0);
  assert.ok(observation.evidence.textTruncated > 0);
  assert.ok(observation.evidence.bytes <= observation.evidence.maximumBytes);
  assert.ok(observation.evidence.entries.length <= observation.evidence.maximumEntries);
  assert.equal(observation.complete().review, 'required');
  assert.equal(listeners.size, 0);
});

test('post-shutdown journal verification counts both compressed errors and malformed active records as evidence', async () => {
  const root = fileURLToPath(new URL('../../.cache/perf/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'run-evidence-test-'));
  try {
    await mkdir(path.join(directory, 'runtime'));
    await writeFile(path.join(directory, 'runtime/000001.ndjson.gz'), gzipSync(JSON.stringify({ type: 'log', level: 'error', at: 1, message: 'Fixture runtime error' }) + '\n'));
    await writeFile(path.join(directory, 'runtime/000002.ndjson.open'), JSON.stringify({ type: 'lifecycle', at: 2 }) + '\ninvalid JSON\n');
    const journal = await capturePerfJournal(directory);
    assert.equal(journal.complete, true);
    assert.equal(journal.records, 3);
    assert.equal(journal.gapRecords, 1);
    assert.equal(journal.gaps[0].reason, 'segment_parse_failed');
    assert.equal(journal.errorRecords, 1);
    assert.equal(journal.errors[0].message, 'Fixture runtime error');
    await assert.rejects(capturePerfJournal(path.join(directory, 'missing')), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('journal capture observes cancellation before reads and closes its iterator on cancellation during records', async t => {
  const root = fileURLToPath(new URL('../../.cache/perf/', import.meta.url)); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'journal-abort-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const reason = Object.assign(Error('fixture scan cancelled'), { code: 'ABORT_ERR' });
  const stopped = new AbortController(); stopped.abort(reason);
  await assert.rejects(capturePerfJournal(path.join(directory, 'missing'), { signal: stopped.signal }), error => error === reason);
  await mkdir(path.join(directory, 'runtime'));
  await writeFile(path.join(directory, 'runtime/000001.ndjson.open'), Array.from({ length: 3 }, () => JSON.stringify({ type: 'lifecycle' })).join('\n') + '\n');
  const controller = new AbortController(), original = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  controller.signal.throwIfAborted = () => { if (++checks === 6) controller.abort(reason); original(); };
  await assert.rejects(capturePerfJournal(directory, { signal: controller.signal }), error => error === reason);
  assert.equal(checks, 6, 'Cancellation must be checked during streamed records, not only before startup');
  assert.equal((await capturePerfJournal(directory)).records, 3, 'Optional cancellation must not alter ordinary callers');
});

test('native observation gap events also make journal coverage incomplete evidence', async t => {
  const root = fileURLToPath(new URL('../../.cache/perf/', import.meta.url)); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'journal-native-gap-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'runtime'));
  await writeFile(path.join(directory, 'runtime/000001.ndjson.open'), JSON.stringify({ type: 'lifecycle', event: 'native_observation_gap', at: 1 }) + '\n');
  const journal = await capturePerfJournal(directory);
  assert.equal(journal.records, 1); assert.equal(journal.gapRecords, 1);
  assert.equal(journal.gaps[0].reason, 'native_observation_gap');
});
