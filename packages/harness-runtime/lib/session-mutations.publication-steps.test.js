import { afterEach, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupRoots, fixture, test } from '../test/session-mutations-fixture.js';
import { withExecutionTiming } from './execution-admission.js';

afterEach(cleanupRoots);

const TRANSACTION_STEPS = ['finish_lookup', 'finish_reconcile', 'finish_publish', 'finish_receipt', 'finish_materialize'];

test('a publication attributes its transaction to exclusive steps within the summary limit', async () => {
  const f = await fixture();
  await f.write('a.txt', 'one\ntwo\n'); await f.write('b.txt', 'three\n');
  const lease = await f.begin('s', 'p1', 'c1');
  await fs.writeFile(path.join(lease.viewDirectory, 'a.txt'), 'one\nTWO\n');
  await fs.rm(path.join(lease.viewDirectory, 'b.txt'));
  const records = [];
  await withExecutionTiming({ sessionID: 's', callID: 'c1' }, () => f.finish(lease), { phase: 'finish', minMs: 0, onDiagnostic: (record) => records.push(record) });
  const summary = records.find((record) => record.phase === 'finish' && record.state === 'completed');
  const steps = new Map(summary.steps.split(',').map((entry) => {
    const [name, value] = entry.split(':'), [count, elapsedMs] = value.split('/').map(Number);
    return [name, { count, elapsedMs }];
  }));
  for (const name of [...TRANSACTION_STEPS, 'ledger_transaction', 'lock_hold']) expect(steps.get(name)?.count).toBe(1);
  // Sequential and disjoint inside the transaction: together never more than it.
  expect(TRANSACTION_STEPS.reduce((sum, name) => sum + steps.get(name).elapsedMs, 0)).toBeLessThanOrEqual(steps.get('ledger_transaction').elapsedMs);
  // A summary keeps at most 32 step names and drops later ones silently.
  expect(steps.size).toBeLessThan(32);
});
