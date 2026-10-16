import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSessionChangeRuntime } from '../../packages/harness-runtime/lib/session-changes.js';
import { createCursorExecutionReceipts } from '../../packages/web/server/lib/opencode/cursor-execution-receipts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = path.join(repository, '.cache/perf');
const hash = value => createHash('sha256').update(value).digest('hex');
const count = 24;

async function measure(side, warm, parent) {
  const base = await fs.mkdtemp(path.join(parent, `${side}-${warm ? 'warm' : 'cold'}-`));
  const directory = path.join(base, 'project'), storage = path.join(base, 'ledger');
  await fs.mkdir(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  let notifications = 0, writes = 0, batches = 0, aliases = 0;
  const runtime = createSessionChangeRuntime({ directory: storage, onChange: () => notifications++ });
  const inputs = [0, 1].map(child => {
    const scope = { sessionID: `child_${child}`, messageID: `assistant_${child}` };
    const receipt = { ...scope, directory, callID: `cursor_${child}`, source: 'confined-execution', complete: true, files: [] };
    const parts = Array.from({ length: count }, (_, index) => ({ type: 'tool', callID: `call_${child}_${index}`, tool: index % 6 === 0 ? 'edit' : 'read' }));
    return { receipt, parts, lease: { directory, token: `fixture_${child}`, scope } };
  });
  try {
    if (warm) await runtime.recordReceipt({ ...inputs[0].receipt, callID: 'warmup' });
    notifications = 0;
    const save = createCursorExecutionReceipts({ runtime: {
      aliasCalls: async input => { aliases += input.calls.length; },
      executionReceipt: async input => inputs.find(row => row.lease.token === input.token).receipt,
    }, recordReceipts: async receipts => { writes += receipts.length; batches++; await runtime.recordReceipts(receipts); } });
    let peakRssBytes = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
    const cpu = process.cpuUsage(), start = performance.now();
    try {
      await Promise.all(inputs.map(async row => {
        if (side === 'candidate') {
          await save(row.lease, { parts: row.parts });
          await save(row.lease, { parts: row.parts });
        } else {
          aliases += row.parts.length;
          for (const input of [row.receipt, ...row.parts.map(part => ({ ...row.receipt, callID: part.callID, tool: part.tool }))]) {
            writes++; batches++; await runtime.recordReceipt(input);
          }
        }
      }));
      await runtime.drain();
    } finally { clearInterval(sampler); }
    const latencyMs = performance.now() - start, used = process.cpuUsage(cpu);
    assert.equal(aliases, count * 2);
    assert.equal(writes, side === 'candidate' ? 10 : 50);
    assert.equal(batches, side === 'candidate' ? 2 : 50);
    for (const row of inputs) {
      for (const callID of [row.receipt.callID, ...row.parts.filter(part => side === 'baseline' || part.tool === 'edit').map(part => part.callID)]) {
        assert.ok(await runtime.findCall({ directory, sessionID: row.receipt.sessionID, callID }), 'Committed receipt missing');
      }
    }
    return { side, warm, passed: true, latencyMs, cpuMs: (used.user + used.system) / 1000,
      peakRssBytes, idleRssBytes: process.memoryUsage().rss, receipts: writes, transactions: batches, aliases, notifications };
  } finally { await runtime.drain(); await fs.rm(base, { recursive: true, force: true }); }
}

export async function runCursorReceiptBenchmark() {
  await fs.mkdir(root, { recursive: true });
  assert.equal(await fs.realpath(root), root, 'Benchmark cache must be canonical');
  const evidence = await fs.mkdtemp(path.join(root, 'cursor-receipts-'));
  const samples = [];
  for (let pair = 1; pair <= 5; pair++) for (const warm of [false, true]) {
    for (const side of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      samples.push({ pair, ...await measure(side, warm, evidence) });
    }
  }
  const sourceFiles = ['packages/web/server/lib/opencode/cursor-execution-receipts.js', 'packages/harness-runtime/lib/session-changes.js'];
  const result = { schemaVersion: 1, passed: samples.every(row => row.passed),
    scope: 'real disposable Git receipt ledger; simulated settled Cursor lease and alias callback; no provider or native publication qualification',
    baseline: 'previous scalar receipt submission pattern', samples,
    sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await fs.readFile(path.join(repository, file)))]))),
    limitations: ['same-process RSS includes prior samples', 'subprocess CPU and native lease settlement are not measured', 'transaction counts describe receipt owner submissions'],
  };
  const output = path.join(evidence, 'result.json');
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  return { output, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Receipt benchmark takes no arguments');
  const { output, result } = await runCursorReceiptBenchmark();
  console.log(JSON.stringify({ passed: result.passed, output, samples: result.samples.length }));
}
