// onceFinished: a caller that reads a child's output is told the child is
// finished only when its pipes have ended, with a bound when they never do.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { onceFinished } from './child-finish.mjs';

test('the callback waits for close, so output delivered after exit is not lost', () => {
  const child = new EventEmitter();
  let stderr = '';
  const seen = [];
  onceFinished(child, (code, signal) => seen.push({ code, signal, stderr }));
  child.emit('exit', 1, null);
  assert.deepEqual(seen, [], 'exit alone does not finish');
  stderr += 'the refusal';
  child.emit('close', 1, null);
  assert.deepEqual(seen, [{ code: 1, signal: null, stderr: 'the refusal' }]);
  child.emit('close', 1, null);
  assert.equal(seen.length, 1, 'once');
});

test('a pipe that never ends is bounded: the callback runs after the grace, once', async () => {
  const child = new EventEmitter();
  const seen = [];
  const finished = new Promise((resolve) => { onceFinished(child, (code, signal) => { seen.push({ code, signal }); resolve(); }, { graceMs: 20 }); });
  child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(seen, []);
  await finished;
  child.emit('close', null, 'SIGKILL');
  assert.deepEqual(seen, [{ code: null, signal: 'SIGKILL' }]);
});

test('close without a grace timer left behind: a finished child keeps nothing alive', () => {
  const child = new EventEmitter();
  let calls = 0;
  onceFinished(child, () => { calls += 1; }, { graceMs: 60_000 });
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(calls, 1);
  // The 60 s grace timer was cleared: were it not, this file would not end for a minute.
});

test('a real child: everything it wrote to stderr before exiting is there', async () => {
  const text = 'x'.repeat(200_000);
  const child = spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(text)}, () => process.exit(3))`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve) => { onceFinished(child, (code, signal) => resolve({ code, signal, length: stderr.length })); });
  assert.deepEqual(result, { code: 3, signal: null, length: text.length });
});
