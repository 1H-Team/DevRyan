import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  collectGapPaths,
  collectJournalPaths,
  formatJournalRows,
  listJournalRows,
  parseShowFilters,
  readRecordsFromPaths,
  recordMatches,
  resolveJournalDirectory,
} from './journal.mjs';

const temporaryDirectories = [];

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-journal-cli-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});
describe('journal CLI helpers', () => {
  test('resolves the configured data root and explicit journal override', () => {
    assert.equal(
      resolveJournalDirectory({ argv: [], env: { OPENCHAMBER_DATA_DIR: '/data' }, homeDir: '/home' }),
      path.join('/data', 'harness', 'journal'),
    );
    assert.equal(
      resolveJournalDirectory({ argv: ['list', '--dir', '/journal'], env: {}, homeDir: '/home' }),
      '/journal',
    );
  });

  test('lists session, runtime, and legacy rows from manifests', async () => {
    const directory = await temporaryDirectory();
    await fs.mkdir(path.join(directory, 'sessions/ses_1'), { recursive: true });
    await fs.writeFile(path.join(directory, 'sessions/ses_1/manifest.json'), JSON.stringify({
      sessionID: 'ses_1',
      title: 'Example',
      lastAt: 10,
      bytes: 1024,
      gapCount: 2,
      recordCounts: { prompt: 3 },
    }));
    await fs.mkdir(path.join(directory, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(directory, 'runtime/manifest.json'), JSON.stringify({
      lastAt: 9,
      bytes: 10,
      recordCounts: { log: 1 },
    }));
    await fs.writeFile(path.join(directory, '8-000001.ndjson'), '{}\n');

    const rows = await listJournalRows(directory);
    assert.deepEqual(rows.map((row) => row.id), ['ses_1', 'runtime', 'legacy']);
    assert.match(formatJournalRows(rows), /Example/);
  });

  test('reads mixed gzip and open chunks and applies show filters', async () => {
    const directory = await temporaryDirectory();
    const bucket = path.join(directory, 'sessions/ses_1');
    await fs.mkdir(bucket, { recursive: true });
    await fs.writeFile(
      path.join(bucket, '000001.ndjson.gz'),
      gzipSync('{"type":"prompt","at":1,"sessionID":"ses_1"}\n'),
    );
    await fs.writeFile(
      path.join(bucket, '000002.ndjson.open'),
      '{"type":"open_code_event","at":2,"sessionID":"ses_1","payload":{"type":"session.updated"}}\n',
    );
    const paths = await collectJournalPaths(directory);
    const records = [];
    for await (const record of readRecordsFromPaths(paths)) records.push(record);
    assert.equal(records.length, 2);
    const filters = parseShowFilters(['--event', 'session.updated', '--since', '2', '--tail', '1']);
    assert.equal(recordMatches(records[0], filters), false);
    assert.equal(recordMatches(records[1], filters), true);
  });

  test('uses manifests to skip verified zero-gap buckets unless verification is requested', async () => {
    const directory = await temporaryDirectory();
    const zeroGapBucket = path.join(directory, 'sessions/zero');
    const positiveGapBucket = path.join(directory, 'sessions/positive');
    const unknownBucket = path.join(directory, 'sessions/unknown');
    const runtimeBucket = path.join(directory, 'runtime');
    await Promise.all([
      fs.mkdir(zeroGapBucket, { recursive: true }),
      fs.mkdir(positiveGapBucket, { recursive: true }),
      fs.mkdir(unknownBucket, { recursive: true }),
      fs.mkdir(runtimeBucket, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(zeroGapBucket, 'manifest.json'), JSON.stringify({ gapCount: 0 })),
      fs.writeFile(path.join(positiveGapBucket, 'manifest.json'), JSON.stringify({ gapCount: 1 })),
      fs.writeFile(path.join(runtimeBucket, 'manifest.json'), JSON.stringify({ gapCount: 0 })),
      fs.writeFile(path.join(zeroGapBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(positiveGapBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(unknownBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(runtimeBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(directory, '1-000001.ndjson'), '{"type":"gap"}\n'),
    ]);

    const fastPaths = (await collectGapPaths(directory)).map((filePath) => path.relative(directory, filePath));
    assert.deepEqual(fastPaths, [
      '1-000001.ndjson',
      path.join('sessions', 'positive', '000001.ndjson.open'),
      path.join('sessions', 'unknown', '000001.ndjson.open'),
    ]);

    const verifiedPaths = (await collectGapPaths(directory, { verify: true }))
      .map((filePath) => path.relative(directory, filePath));
    assert.deepEqual(verifiedPaths, [
      '1-000001.ndjson',
      path.join('sessions', 'positive', '000001.ndjson.open'),
      path.join('sessions', 'unknown', '000001.ndjson.open'),
      path.join('sessions', 'zero', '000001.ndjson.open'),
      path.join('runtime', '000001.ndjson.open'),
    ]);
  });
});
