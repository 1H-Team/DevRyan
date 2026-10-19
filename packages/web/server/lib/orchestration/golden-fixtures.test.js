import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createAtomicManagedOrchestrationLedger } from './atomic-ledger.js';
import { createWebManagedOrchestrationRuntime } from './runtime.js';

// The orchestration-runtime golden fixtures, read through the web host's
// persistence and HTTP projection. Bytes must match exactly.
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../orchestration-runtime/fixtures');
const fixture = name => fs.readFile(path.join(fixtures, name), 'utf8');
const NOW = 1_760_000_100_000;
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

const roundTripPosix = async (bytes) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-golden-ledger-'));
  temporaryDirectories.push(dataDirectory);
  const filePath = path.join(dataDirectory, 'ledger.json');
  await fs.writeFile(filePath, bytes);
  const ledger = createAtomicManagedOrchestrationLedger({ dataDirectory, filePath, heartbeatIntervalMs: 0, process: new EventEmitter() });
  await ledger.acquireOwnership();
  try {
    const loaded = await ledger.load();
    expect(ledger.getDiagnostics().quarantinedPath).toBeNull();
    await ledger.save(loaded);
    return await fs.readFile(filePath, 'utf8');
  } finally { await ledger.releaseOwnership(); }
};

const roundTripWindows = async (bytes) => {
  const records = new Map([['/fixture/private/orchestration/ledger.json', { identity: { fileId: '0' }, bytes: Buffer.from(bytes) }]]);
  let quarantined = 0;
  const files = { maxBytes: 64 * 1024 * 1024, ensureDirectory: async () => {},
    read: async file => { const value = records.get(file); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value; },
    write: async (file, next) => { records.set(file, { identity: { fileId: String(records.size + 1) }, bytes: Buffer.from(next) }); },
    quarantine: async (file) => { quarantined += 1; records.delete(file); return `${file}.native-backup`; } };
  const keeper = { signal: new AbortController().signal, assert: () => {}, close: async () => {} };
  const ledger = createAtomicManagedOrchestrationLedger({ platform: 'win32', dataDirectory: '/fixture/private',
    windowsLedgerOwner: files, windowsLauncher: 'constructor-only', createWindowsKeeper: async () => keeper, logger: { warn: () => {} },
    fs: new Proxy({}, { get: () => () => { throw new Error('Node filesystem fallback'); } }) });
  await ledger.acquireOwnership();
  try {
    const [filePath] = records.keys();
    expect(ledger.filePath).toBe(filePath);
    await ledger.save(await ledger.load());
    expect(quarantined).toBe(0);
    return records.get(filePath).bytes.toString('utf8');
  } finally { await ledger.releaseOwnership(); }
};

describe('golden ledgers through the atomic ledger', () => {
  it.each([['POSIX', roundTripPosix], ['Windows', roundTripWindows]])('%s: a current ledger saves byte-identical', async (_name, roundTrip) => {
    const current = await fixture('ledger-current.json');
    expect(await roundTrip(current)).toBe(current);
  });

  it.each([['POSIX', roundTripPosix], ['Windows', roundTripWindows]])('%s: a legacy ledger gains its defaults in the pinned key order', async (_name, roundTrip) => {
    const saved = await fixture('ledger-legacy.atomic-saved.json');
    expect(await roundTrip(await fixture('ledger-legacy.json'))).toBe(saved);
    expect(await roundTrip(saved)).toBe(saved);
  });
});

it('the HTTP snapshot of the golden ledger is byte-identical', async () => {
  const current = await fixture('ledger-current.json');
  const runtime = createWebManagedOrchestrationRuntime({
    now: () => NOW,
    persistence: { load: async () => JSON.parse(current), save: async () => {} },
    executor: { start: async () => { throw new Error('golden fixtures never launch'); } },
    readAgentCatalog: async () => [{ name: 'explorer', mode: 'all' }],
    validateAgentExecution: async () => true,
  });
  try {
    await runtime.initialize();
    expect(`${JSON.stringify(await runtime.getSnapshot({ rootSessionId: 'ses_golden_root' }))}\n`).toBe(await fixture('snapshot.json'));
  } finally { await runtime.shutdown(); }
});
