import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { executionPhase, quietExecutionPhase, withExecutionAdmission, withExecutionPreparation, withoutExecutionDeadline, executionProgress, executionProgressMeter, waitForExecutionQueue } from './execution-admission.js';

test('an expired active operation retains ownership until it actually settles', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const work = withExecutionAdmission({ sessionID: 's' }, () => executionPhase('lease_preparation', () => held), { timeoutMs: 10 });
  const result = work.catch((cause) => { settled = true; return cause; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  release();
  expect((await result).code).toBe('local_execution_timeout');
});

test('local HTTP and lock deadlines do not masquerade as provider timeouts', async () => {
  for (const cause of [new DOMException('expired', 'TimeoutError'), Object.assign(new Error('lock'), { code: 'LOCK_TIMEOUT' })]) {
    const error = await withExecutionAdmission({ sessionID: 's' }, async () => { throw cause; }).catch((value) => value);
    expect(error.code).toBe('local_execution_timeout');
    expect(error.cause).toBe(cause);
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('shared preparation reports real progress across copied contexts while joiners keep their own deadlines', async () => {
  let meter;
  const producer = withExecutionPreparation({}, () => {
    meter = executionProgressMeter();
    return withoutExecutionDeadline(async () => {
      for (let i = 0; i < 20; i++) { await delay(10); executionProgress(); }
      return 'ready';
    });
  }, { stallMs: 80 });
  const join = (options = {}) => withExecutionPreparation({}, () => waitForExecutionQueue(producer, meter), { stallMs: 80, ...options });
  const controller = new AbortController();
  const cancelled = join({ signal: controller.signal }).catch((cause) => cause.message);
  const expired = join({ timeoutMs: 40 }).catch((cause) => cause.code);
  const healthy = join();
  controller.abort(new Error('cancelled'));
  expect(await cancelled).toBe('cancelled');
  expect(await expired).toBe('local_execution_timeout');
  expect(await healthy).toBe('ready');
  expect(await producer).toBe('ready');
});
test('following a hung shared preparation does not disable the stall watchdog', async () => {
  const never = new Promise(() => {});
  const meter = { progress: Date.now(), waiters: 0 };
  await expect(withExecutionPreparation({}, () => waitForExecutionQueue(never, meter), { stallMs: 20 }))
    .rejects.toMatchObject({ code: 'execution_preparation_stalled' });
});

test('quiet phases journal only failures and slow completions', async () => {
  const records = [];
  await withExecutionAdmission({ sessionID: 'ses_quiet' }, async () => {
    await quietExecutionPhase('ledger_open', async () => 'fast');
    await quietExecutionPhase('ledger_commit', () => new Promise((resolve) => setTimeout(resolve, 30)), 20);
    await expect(quietExecutionPhase('ledger_transaction', async () => { throw Object.assign(new Error('busy'), { code: 'LOCK_TIMEOUT' }); }))
      .rejects.toMatchObject({ code: 'local_execution_timeout' });
  }, { onDiagnostic: (record) => records.push(record) }).catch(() => {});
  const quiet = records.filter((record) => record.phase !== 'admission');
  expect(quiet.map((record) => `${record.phase}:${record.state}`)).toEqual(['ledger_commit:completed', 'ledger_transaction:failed']);
  expect(quiet[0]).toMatchObject({ slow: true, sessionID: 'ses_quiet' });
});

test('idle admission survives progressing work, expires idle work, and keeps an absolute cap', async () => {
  const { executionProgress } = await import('./execution-admission.js');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await expect(withExecutionAdmission({ sessionID: 'progressing' }, async () => {
    for (let i = 0; i < 8; i++) { await sleep(30); executionProgress(); }
    return 'done';
  }, { timeoutMs: 2_000, idleMs: 100 })).resolves.toBe('done');
  const idleStarted = Date.now();
  await expect(withExecutionAdmission({ sessionID: 'idle' }, () => executionPhase('work', () => sleep(400)),
    { timeoutMs: 2_000, idleMs: 100 })).rejects.toMatchObject({ code: 'local_execution_timeout' });
  expect(Date.now() - idleStarted).toBeGreaterThanOrEqual(390); // Ownership retained until settled.
  await expect(withExecutionAdmission({ sessionID: 'capped' }, async () => {
    for (let i = 0; i < 20; i++) { await sleep(30); executionProgress(); }
    return 'late';
  }, { timeoutMs: 200, idleMs: 100 })).rejects.toMatchObject({ code: 'local_execution_timeout' });
});

test('a caller leaving a long queue is credited with progress before its own work', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const holder = { progress: Date.now(), waiters: 0 };
  const queueMeter = { progress: Date.now(), waiters: 0, following: holder };
  let release; const previous = new Promise((resolve) => { release = resolve; });
  const ticker = setInterval(() => { holder.progress = Date.now(); }, 20);
  setTimeout(() => { clearInterval(ticker); queueMeter.following = undefined; queueMeter.progress = Date.now(); release(); }, 1_200);
  await expect(withExecutionAdmission({ sessionID: 'queued' }, async () => {
    await waitForExecutionQueue(previous, queueMeter);
    // Deterministic: the credit is visible immediately, not only if an idle
    // tick happens to land before the work finishes.
    expect(Date.now() - executionProgressMeter().progress).toBeLessThan(100);
    await sleep(150);
    return 'completed';
  }, { timeoutMs: 10_000, idleMs: 400 })).resolves.toBe('completed');
});

test('a summarized admission journals one record with per-phase steps, and nothing when fast', async () => {
  const run = async (summary) => {
    const records = [];
    await withExecutionAdmission({ sessionID: 's', callID: 'c' }, async () => {
      await executionPhase('identity_lookup', async () => {});
      await executionPhase('lease_lookup', async () => {});
      await executionPhase('lease_lookup', async () => {});
      await quietExecutionPhase('ledger_transaction', async () => {});
    }, { onDiagnostic: (record) => records.push(record), summary });
    return records;
  };
  expect(await run({ minMs: 60_000 })).toEqual([]);
  const [record, ...rest] = await run({ minMs: 0 });
  expect(rest).toEqual([]);
  expect(record).toMatchObject({ event: 'session_execution', sessionID: 's', callID: 'c', phase: 'admission', state: 'completed' });
  expect(record.steps).toMatch(/^identity_lookup:1\/\d+,lease_lookup:2\/\d+,ledger_transaction:1\/\d+$/);
});

test('a summarized admission still journals failed and slow phases as they happen', async () => {
  const records = [];
  const failure = Object.assign(new Error('boom'), { code: 'workspace_changing' });
  await withExecutionAdmission({ sessionID: 's' }, async () => {
    await executionPhase('reconciliation', () => new Promise((resolve) => setTimeout(resolve, 80)));
    await executionPhase('execution_claim', async () => { throw failure; });
  }, { onDiagnostic: (record) => records.push(record), summary: { minMs: 60_000, slowMs: 40 } }).catch(() => {});
  expect(records.map((record) => `${record.phase}:${record.state}`)).toEqual([
    'admission:started', 'reconciliation:started', 'reconciliation:completed', 'execution_claim:failed', 'admission:failed',
  ]);
  expect(records[1].slow).toBe(true);
  expect(records[3].code).toBe('workspace_changing');
  expect(records[4].steps).toMatch(/^reconciliation:1\/\d+,execution_claim:1\/\d+$/);
});


test('tool execution diagnostics whitelist origin, tier and fallback without tool input', async () => {
  const { withExecutionAdmission, withExecutionPreparation } = await import('./execution-admission.js');
  const records = [];
  const input = { sessionID: 'ses_fixture', toolOrigin: 'custom', kind: 'process', fallbackReason: 'custom_tool', args: { secret: 'never-log' } };
  await withExecutionPreparation(input, async () => {}, { onDiagnostic: record => records.push(record) });
  assert.ok(records.some(record => record.phase === 'preparation' && record.state === 'completed'
    && record.toolOrigin === 'custom' && record.executionTier === 'process' && record.fallbackReason === 'custom_tool'
    && Number.isFinite(record.elapsedMs)));
  assert.ok(!JSON.stringify(records).includes('never-log'));
  const unknown = [];
  await withExecutionAdmission({ toolOrigin: 'private-origin', kind: 'private-kind', fallbackReason: 'private-reason' }, async () => {}, { onDiagnostic: record => unknown.push(record) });
  assert.ok(unknown.every(record => !('toolOrigin' in record) && !('executionTier' in record) && !('fallbackReason' in record)));
});
