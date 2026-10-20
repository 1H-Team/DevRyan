import path from 'node:path';
import { expect, test } from 'vitest';
import { readDaemonRestartOptions } from './devryan-routes.js';

test('update restart reads canonical daemon record before the historical one', async () => {
  const root = path.join(path.sep, 'fixture', 'data');
  const canonical = path.join(root, 'run', 'devryan-3000.json');
  const legacy = path.join(root, 'run', 'openchamber-3000.json');
  const reads = [];
  const files = new Map([[canonical, JSON.stringify({ port: 3000, host: 'current' })],
    [legacy, JSON.stringify({ port: 3000, host: 'historical' })]]);
  const fs = { promises: { readFile: async file => { reads.push(file); if (!files.has(file)) throw Error('missing'); return files.get(file); } } };
  expect(await readDaemonRestartOptions({ fs, dataDirectory: root, port: 3000 })).toMatchObject({ host: 'current' });
  expect(reads).toEqual([canonical]);
  files.delete(canonical);
  reads.length = 0;
  expect(await readDaemonRestartOptions({ fs, dataDirectory: root, port: 3000 })).toMatchObject({ host: 'historical' });
  expect(reads).toEqual([canonical, legacy]);
  files.set(canonical, JSON.stringify({ port: 3001, host: 'wrong instance' }));
  expect(await readDaemonRestartOptions({ fs, dataDirectory: root, port: 3000 })).toMatchObject({ host: 'historical' });
});
