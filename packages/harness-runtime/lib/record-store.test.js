import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRecordStore } from './record-store.js';

const temporaryDirectories = [];

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-harness-store-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('versioned record store', () => {
  test('serializes writes to the same record in invocation order', async () => {
    const directory = await temporaryDirectory();
    const store = createRecordStore({ directory });

    await Promise.all([
      store.writeRecord('same', { value: 1 }),
      store.writeRecord('same', { value: 2 }),
      store.writeRecord('same', { value: 3 }),
    ]);

    expect(await store.readRecord('same')).toEqual({ value: 3 });
  });

  test('quarantines corrupt records while reconciling valid peers', async () => {
    const directory = await temporaryDirectory();
    const store = createRecordStore({ directory, logger: { warn() {} } });
    await store.writeRecord('valid', { count: 1 });
    await fs.writeFile(path.join(directory, 'corrupt.json'), '{bad');

    const result = await store.reconcile((record) => ({ ...record, count: record.count + 1 }));

    expect(result).toEqual([{ key: 'valid', action: 'updated', record: { count: 2 } }]);
    expect(await store.readRecord('valid')).toEqual({ count: 2 });
    expect((await fs.readdir(path.join(directory, 'quarantine'))).length).toBe(1);
  });
});
