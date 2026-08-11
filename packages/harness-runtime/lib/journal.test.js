import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { createDiagnosticJournal } from './journal.js';
import { createDiagnosticSanitizer } from './sanitizer.js';

const temporaryDirectories = [];

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-journal-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createJournal = (directory, options = {}) => createDiagnosticJournal({
  directory,
  sanitizer: createDiagnosticSanitizer({ homeDir: '/Users/tester' }),
  runtime: 'test',
  ...options,
});

const partEvent = (sessionID, text, extra = {}) => ({
  type: 'open_code_event',
  at: extra.at ?? 1,
  payload: {
    type: 'message.part.updated',
    properties: {
      sessionID,
      messageID: 'msg_1',
      part: { id: 'part_1', text, ...extra.part },
    },
  },
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('session-partitioned diagnostic journal', () => {
  test('partitions sanitized records by resolved session and stamps the session id', async () => {
    const directory = await temporaryDirectory();
    const journal = createDiagnosticJournal({
      directory,
      sanitizer: createDiagnosticSanitizer({
        homeDir: '/Users/tester',
        knownSecrets: ['known-super-secret'],
      }),
      runtime: 'test',
    });
    journal.enqueue({
      type: 'open_code_event',
      at: 1,
      directory: '/Users/tester/repo',
      payload: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_1', title: 'Session title', directory: '/Users/tester/repo' },
          text: 'known-super-secret',
        },
      },
    });
    await journal.flush();

    const paths = await journal.listSegmentPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(path.join('sessions', 'ses_1'));
    expect(paths[0]).toEndWith('.ndjson.open');
    const records = await journal.readRecords();
    expect(records).toMatchObject([{ sessionID: 'ses_1' }]);
    expect(records[0].directory).toStartWith('<WORKTREE_');
    expect(JSON.stringify(records)).not.toContain('known-super-secret');
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'sessions/ses_1/manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      version: 1,
      sessionID: 'ses_1',
      title: 'Session title',
      firstAt: 1,
      lastAt: 1,
      eventCounts: { 'session.created': 1 },
      rebuilt: false,
    });
    expect((await journal.getStatus()).sessionCount).toBe(1);
    await journal.close();
  });

  test('routes unattributed records to the runtime bucket', async () => {
    const directory = await temporaryDirectory();
    const journal = createJournal(directory);
    journal.enqueue({ type: 'log', at: 1, message: 'runtime only' });
    await journal.flush();
    expect(await journal.listSegmentPaths()).toEqual([
      path.join(directory, 'runtime/000001.ndjson.open'),
    ]);
    expect((await journal.getStatus()).sessionCount).toBe(0);
    await journal.close();
  });

  test('drops streaming deltas and coalesces part updates last-write-wins', async () => {
    const directory = await temporaryDirectory();
    const journal = createJournal(directory);
    journal.enqueue({
      type: 'open_code_event',
      at: 1,
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_trim' } },
    });
    journal.enqueue(partEvent('ses_trim', 'first'));
    journal.enqueue(partEvent('ses_trim', 'last', { part: { completed: true } }));
    await journal.flush();

    const records = await journal.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionID: 'ses_trim',
      coalesced: 2,
      payload: { properties: { part: { text: 'last' } } },
    });
    expect(records.some((record) => record.payload?.type === 'message.part.delta')).toBe(false);
    const [manifest] = await journal.listSessionManifests();
    expect(manifest).toMatchObject({ trimmedDeltas: 1, coalescedParts: 1 });
    await journal.close();
  });

  test('keeps a representative streaming trace at least ten times smaller than raw input', async () => {
    const directory = await temporaryDirectory();
    const journal = createJournal(directory);
    let rawBytes = 0;
    for (let index = 0; index < 300; index += 1) {
      const delta = {
        type: 'open_code_event',
        at: index + 1,
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_ratio',
            messageID: 'msg_ratio',
            partID: 'part_ratio',
            delta: 'x'.repeat(1_024),
          },
        },
      };
      rawBytes += Buffer.byteLength(`${JSON.stringify(delta)}\n`);
      journal.enqueue(delta);
    }
    journal.enqueue(partEvent('ses_ratio', 'final', { at: 301, part: { completed: true } }));
    await journal.close();

    const storedBytes = (await journal.getStatus()).diskBytes;
    expect(rawBytes / storedBytes).toBeGreaterThan(10);
  });

  test('rotates chunks to gzip while keeping the active chunk plain and reads both', async () => {
    const directory = await temporaryDirectory();
    const journal = createJournal(directory, { maxSegmentBytes: 180, trim: false });
    for (let index = 0; index < 5; index += 1) {
      journal.enqueue({
        type: 'prompt',
        at: index + 1,
        sessionID: 'ses_chunks',
        payload: { text: `record-${index}-${'x'.repeat(80)}` },
      });
    }
    await journal.flush();
    const paths = await journal.listSegmentPaths();
    expect(paths.some((entry) => entry.endsWith('.ndjson.gz'))).toBe(true);
    expect(paths.some((entry) => entry.endsWith('.ndjson.open'))).toBe(true);
    expect(await journal.readRecords()).toHaveLength(5);
    await journal.close();
    expect((await journal.listSegmentPaths()).every((entry) => entry.endsWith('.gz'))).toBe(true);
  });

  test('recovers a partial active chunk by truncating and gzip-closing it', async () => {
    const directory = await temporaryDirectory();
    const bucket = path.join(directory, 'sessions/ses_crash');
    await fs.mkdir(bucket, { recursive: true });
    await fs.writeFile(
      path.join(bucket, '000001.ndjson.open'),
      '{"type":"prompt","at":1,"runtime":"test","sessionID":"ses_crash","payload":{}}\n{"partial"',
    );
    const journal = createJournal(directory, { now: () => 1 });
    await journal.initialize();
    expect(await journal.listSegmentPaths()).toEqual([
      path.join(bucket, '000001.ndjson.gz'),
    ]);
    expect(await journal.readRecords()).toMatchObject([{ sessionID: 'ses_crash' }]);
    const manifest = JSON.parse(await fs.readFile(path.join(bucket, 'manifest.json'), 'utf8'));
    expect(manifest.rebuilt).toBe(true);
    await journal.close();
  });

  test('prunes the oldest whole session directory by manifest lastAt', async () => {
    const directory = await temporaryDirectory();
    let current = 1_000;
    const first = createJournal(directory, { now: () => current, maxAgeMs: 100 });
    first.enqueue({ type: 'prompt', at: current, sessionID: 'ses_old', payload: {} });
    await first.close();

    current = 1_200;
    const second = createJournal(directory, { now: () => current, maxAgeMs: 100 });
    await second.initialize();
    expect(await fs.stat(path.join(directory, 'sessions/ses_old')).catch(() => null)).toBeNull();
    second.enqueue({ type: 'prompt', at: current, sessionID: 'ses_new', payload: {} });
    await second.close();
    expect(await fs.stat(path.join(directory, 'sessions/ses_new'))).not.toBeNull();
  });

  test('prunes an inactive LRU-evicted session even when its plain chunk can be reopened', async () => {
    const directory = await temporaryDirectory();
    let current = 1_000;
    const journal = createJournal(directory, {
      now: () => current,
      maxAgeMs: 100,
      maxOpenWriters: 1,
      trim: false,
    });
    journal.enqueue({ type: 'prompt', at: current, sessionID: 'ses_old', payload: {} });
    await journal.flush();

    current = 1_200;
    journal.enqueue({ type: 'prompt', at: current, sessionID: 'ses_live', payload: {} });
    await journal.flush();
    await journal.prune();

    expect(await fs.stat(path.join(directory, 'sessions/ses_old')).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(directory, 'sessions/ses_live'))).not.toBeNull();
    await journal.close();
  });

  test('counts, reads, prunes first, and clears legacy segments', async () => {
    const directory = await temporaryDirectory();
    const legacyName = `${Date.now()}-000001.ndjson`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, legacyName), '{"type":"log","at":1,"runtime":"test","message":"legacy"}\n');
    const journal = createJournal(directory);
    expect((await journal.getStatus()).segmentCount).toBe(1);
    expect(await journal.readRecords()).toMatchObject([{ message: 'legacy' }]);
    await journal.clear();
    expect(await fs.stat(path.join(directory, legacyName)).catch(() => null)).toBeNull();
    await journal.close();
  });

  test('reads gzip bucket blobs and legacy plain blobs with strict paths', async () => {
    const directory = await temporaryDirectory();
    const digest = 'a'.repeat(64);
    await fs.mkdir(path.join(directory, 'sessions/ses_blob/blobs'), { recursive: true });
    await fs.writeFile(
      path.join(directory, `sessions/ses_blob/blobs/${digest}.txt.gz`),
      gzipSync('new blob'),
    );
    await fs.mkdir(path.join(directory, '1-000001.blobs'), { recursive: true });
    await fs.writeFile(path.join(directory, `1-000001.blobs/${digest}.txt`), 'legacy blob');
    const journal = createJournal(directory);
    expect(await journal.readBlob(`sessions/ses_blob/blobs/${digest}.txt.gz`)).toBe('new blob');
    expect(await journal.readBlob(`1-000001.blobs/${digest}.txt`)).toBe('legacy blob');
    await expect(journal.readBlob('../escape.txt')).rejects.toThrow('invalid');
    await journal.close();
  });

  test('clear wipes every bucket, keeps discovery files, and remains writable', async () => {
    const directory = await temporaryDirectory();
    const journal = createJournal(directory);
    journal.enqueue({ type: 'prompt', at: 1, sessionID: 'ses_old', payload: {} });
    journal.enqueue({ type: 'log', at: 1, message: 'runtime' });
    await journal.flush();
    const cleared = await journal.clear();
    expect(cleared).toMatchObject({ sessionCount: 0, segmentCount: 0, writtenRecords: 0 });
    expect(await fs.readFile(path.join(directory, 'README.md'), 'utf8')).toContain('session');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')).sessions).toEqual([]);
    expect(await journal.readRecords()).toEqual([]);

    journal.enqueue({ type: 'prompt', at: 2, sessionID: 'ses_new', payload: {} });
    await journal.close();
    expect(await journal.readRecords()).toMatchObject([{ sessionID: 'ses_new' }]);
  });

  test('range clear removes recent records while preserving older records and blobs', async () => {
    const directory = await temporaryDirectory();
    const journal = createJournal(directory, {
      now: () => 400,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      blobThresholdBytes: 16,
      trim: false,
    });
    journal.enqueue({
      type: 'prompt',
      at: 100,
      sessionID: 'ses_old',
      payload: { text: 'older diagnostic payload that uses a blob' },
    });
    journal.enqueue({
      type: 'prompt',
      at: 300,
      sessionID: 'ses_recent',
      payload: { text: 'recent diagnostic payload' },
    });
    await journal.flush();

    const cleared = await journal.clear({ since: 200 });
    expect(cleared).toMatchObject({ sessionCount: 1 });
    const records = await journal.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ at: 100, sessionID: 'ses_old' });
    expect(await journal.readBlob(records[0].payload.text.path)).toBe(
      'older diagnostic payload that uses a blob',
    );
    expect(await fs.stat(path.join(directory, 'sessions/ses_recent')).catch(() => null)).toBeNull();

    journal.enqueue({ type: 'log', at: 500, message: 'written after range clear' });
    await journal.close();
    expect(await journal.readRecords()).toHaveLength(2);
  });
});
