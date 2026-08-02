import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
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
});
