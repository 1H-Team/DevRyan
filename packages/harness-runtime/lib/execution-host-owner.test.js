import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createExecutionHostOwner, executionOwnerFactory } from './execution-host-owner.js';

for (const scenario of ['wrong-handshake', 'timeout', 'never-reaped']) {
  test(`failed keeper ${scenario} is reaped or explicitly blocks replacement`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-owner-'));
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    const signals = []; let closed = false;
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL' && scenario !== 'never-reaped') setTimeout(() => { closed = true; child.emit('close'); }, 5);
      return true;
    };
    try {
      const result = createExecutionHostOwner({ directory, launcher: 'fixture', startupTimeoutMs: 10, terminationTimeoutMs: 15,
        spawnImpl: () => { if (scenario !== 'timeout') queueMicrotask(() => child.stdout.write('wrong\n')); return child; } });
      await expect(result).rejects.toMatchObject({ code: scenario === 'never-reaped' ? 'execution_owner_termination_unconfirmed' : 'execution_owner_unavailable' });
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']); expect(closed).toBe(scenario !== 'never-reaped');
    } finally { child.stdin.destroy(); child.stdout.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  });
}

test('keeper factory preserves single flight, retries reaped failures, and caches unconfirmed failures', async () => {
  for (const code of ['execution_owner_unavailable', 'execution_owner_termination_unconfirmed']) {
    let calls = 0;
    const get = executionOwnerFactory(async () => { calls++; if (calls === 1) throw Object.assign(new Error(code), { code }); return { id: 'new' }; });
    const first = get(); expect(get()).toBe(first);
    await first.catch(() => {});
    const next = get();
    if (code === 'execution_owner_unavailable') { expect(await next).toEqual({ id: 'new' }); expect(calls).toBe(2); }
    else { expect(next).toBe(first); await next.catch(() => {}); expect(calls).toBe(1); }
  }
});

test('a lost keeper is replaced once it is reaped; an unconfirmed reap keeps failing closed', async () => {
  const owner = (id) => { const controller = new AbortController(); return { id, controller, signal: controller.signal, closes: 0 }; };
  let created = 0;
  const retired = [];
  const get = executionOwnerFactory(async () => ({ owner: owner(`owner-${++created}`) }), {
    retire: async (value) => { retired.push(value.owner.id); value.owner.closes++; },
  });
  const first = await get();
  expect(await get()).toBe(first);
  first.owner.controller.abort(new Error('keeper exited'));
  const replacement = get();
  expect(get()).toBe(replacement); // Concurrent callers share one replacement.
  expect((await replacement).owner.id).toBe('owner-2');
  expect(retired).toEqual(['owner-1']);
  expect(await get()).toBe(await replacement);

  const blocked = executionOwnerFactory(async () => ({ owner: owner('blocked') }), {
    retire: async () => { throw Object.assign(new Error('unreaped'), { code: 'execution_owner_termination_unconfirmed' }); },
  });
  const lost = await blocked();
  lost.owner.controller.abort(new Error('keeper exited'));
  const failed = blocked();
  await expect(failed).rejects.toMatchObject({ code: 'execution_owner_termination_unconfirmed' });
  expect(blocked()).toBe(failed);
});
