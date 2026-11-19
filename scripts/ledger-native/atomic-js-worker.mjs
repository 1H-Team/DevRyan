#!/usr/bin/env node
// The JavaScript twin of the Rust probe's process modes, for the contention,
// kill and system-call tests: the same arguments, the same JSON lines.
//   counter <lock> <file> <iterations> <timeoutMs>
//   hold <lock>
//   wait <lock> <timeoutMs>
//   write-atomic <file> <text> | lock-once <lock> | sync-file <path> | copyfile <src> <dst> <mode>
import fs from 'node:fs/promises';
import process from 'node:process';
import { withCrossProcessFileLock, writeFileAtomic } from '../../packages/harness-runtime/lib/atomic-file.js';
import { failureOf } from './atomic-js-arm.mjs';

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (error) => { emit({ ok: false, error: error?.code ?? 'UNCODED', failure: failureOf(error) }); process.exit(1); };
const [mode, ...args] = process.argv.slice(2);

try {
  if (mode === 'counter') {
    const [lock, file, iterations, timeoutMs] = args;
    for (let index = 0; index < Number(iterations); index += 1) {
      await withCrossProcessFileLock(lock, async () => {
        let current = 0;
        try { current = Number.parseInt((await fs.readFile(file, 'utf8')).trim(), 10) || 0; } catch { current = 0; }
        await fs.writeFile(file, String(current + 1));
      }, { timeoutMs: Number(timeoutMs) });
    }
    emit({ ok: true, done: Number(iterations) });
  } else if (mode === 'hold') {
    await withCrossProcessFileLock(args[0], async () => {
      process.stdout.write(`held ${process.pid}\n`);
      await new Promise(() => setInterval(() => {}, 3_600_000));
    }, { timeoutMs: 60_000 });
  } else if (mode === 'wait') {
    const started = Date.now();
    try {
      await withCrossProcessFileLock(args[0], () => undefined, { timeoutMs: Number(args[1]) });
      emit({ ok: true, elapsed: Date.now() - started });
    } catch (error) {
      emit({ ok: false, error: error?.code ?? 'UNCODED', elapsed: Date.now() - started });
    }
  } else if (mode === 'write-atomic') {
    await writeFileAtomic(args[0], args[1]);
    emit({ ok: true });
  } else if (mode === 'lock-once') {
    await withCrossProcessFileLock(args[0], () => undefined);
    emit({ ok: true });
  } else if (mode === 'sync-file') {
    const handle = await fs.open(args[0], 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    emit({ ok: true });
  } else if (mode === 'copyfile') {
    await fs.copyFile(args[0], args[1], Number(args[2]));
    emit({ ok: true });
  } else {
    throw Object.assign(new Error(`unknown mode ${mode}`), { code: 'USAGE' });
  }
} catch (error) {
  fail(error);
}
