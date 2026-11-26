// Self-test of the comparer tools' bounded children (package O0d fix round 1,
// S5): one child's deadline stops that child and what it started, never a
// sibling's processes, and a deadline is inconclusive, not a difference.
// Nothing here depends on how long anything takes: the sibling cannot finish
// before the test has seen the other child's deadline (it waits for a file
// the test writes then), and the sweep's own run is judged by what it may
// print in every order (a deadline or a reproduction, never a failure).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bunJson, runBounded } from './bounded.mjs';
import { createScratch } from './record.mjs';
import { scenarioOutcome } from './sweep.mjs';
import { EXIT } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = createScratch('scheduler-conformance-bounded-test');
let passed = 0;
after(() => { scratch.finish(passed === 3 ? 'passed' : 'failed'); });

/** Polls (bounded) until `pid` is gone or a zombie: a process that was killed, asked about only after it had time to go. */
async function gone(pid, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    const { spawnSync } = await import('node:child_process');
    const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    if (stat === '' || stat.startsWith('Z')) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

test('a child\'s deadline stops that child and what it started, and leaves its sibling running', async () => {
  const release = path.join(scratch.dir, 'release');
  const grandchild = path.join(scratch.dir, 'grandchild.pid');
  // The child that hangs starts a grandchild that hangs too, and has no handler of its own for SIGTERM.
  const hanging = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); writeFileSync(process.env.GRANDCHILD, String(g.pid)); setInterval(() => {}, 1000);`;
  // The sibling finishes only once the release file exists, which the test writes after the hanging child's deadline.
  const sibling = 'const { existsSync } = require(\'node:fs\'); const t = setInterval(() => { if (existsSync(process.env.RELEASE)) { clearInterval(t); console.log(JSON.stringify({ sibling: \'finished\' })); } }, 20);';
  const siblingDone = bunJson(['-e', sibling], { deadlineMs: 120_000, label: 'the sibling', env: { RELEASE: release } });
  const hung = await bunJson(['-e', hanging], { deadlineMs: 1_500, label: 'the hanging child', env: { GRANDCHILD: grandchild } });
  assert.equal(hung.deadline, true, JSON.stringify(hung));
  assert.match(hung.error, /the hanging child was still running after 1500 ms \(deadline\)/);
  writeFileSync(release, '');
  assert.deepEqual(await siblingDone, { sibling: 'finished' });
  // Its grandchild was stopped with it (listed before the child was signalled).
  assert.ok(await gone(Number(readFileSync(grandchild, 'utf8'))), 'the hanging child\'s grandchild is still running');
  passed += 1;
});

test('what a sweep scenario\'s child left: a deadline is inconclusive naming the scenario, a missing result a failure', () => {
  const expired = scenarioOutcome('F4-failures-and-submits', { expired: true }, null, { deadlineMs: 3_700 });
  assert.deepEqual(expired.problems.map((problem) => [problem.kind, problem.check]), [['inconclusive', 'deadline']]);
  assert.match(expired.problems[0].detail, /scenario F4-failures-and-submits was still running after 3700 ms/);
  const crashed = scenarioOutcome('F4-failures-and-submits', { expired: false, code: 1, stderr: 'boom' }, null, { deadlineMs: 3_700 });
  assert.deepEqual(crashed.problems.map((problem) => [problem.kind, problem.check]), [['fail', 'scenario-process']]);
  const inner = scenarioOutcome('F4-failures-and-submits', { expired: false, code: 0 }, { replay: null, problems: [{ kind: 'inconclusive', check: 'deadline', detail: 'the recording of scenario F4-failures-and-submits was still running' }] }, { deadlineMs: 3_700 });
  assert.deepEqual(inner.problems.map((problem) => problem.kind), ['inconclusive']);
  passed += 1;
});

test('the review\'s reproduction: a sweep where one scenario passes its deadline exits inconclusive or passes, never with a difference', async () => {
  // The review ran exactly this and got exit 1: the deadline of F4 stopped wait-then-shutdown's replay as well.
  const done = await runBounded(process.execPath, [path.join(HERE, 'sweep.mjs'), '--scenarios=F4-failures-and-submits,wait-then-shutdown', '--workers=2', '--deadline-ms=3700'], { deadlineMs: 300_000 });
  assert.equal(done.expired, false, 'the sweep itself finished');
  assert.ok([EXIT.pass, EXIT.inconclusive].includes(done.code), `exit ${done.code}: ${done.stdout.slice(-1500)}`);
  assert.doesNotMatch(done.stdout, /FAILED|DIFFERENT|replay-process/);
  // Each scenario either reproduced every case or is named inconclusive by its own deadline.
  for (const name of ['F4-failures-and-submits', 'wait-then-shutdown']) {
    const line = done.stdout.split('\n').find((text) => text.startsWith(`${name}: `)) ?? '';
    assert.match(line, /(?<cases>\d+) cases (?:replayed, \k<cases> reproduced|inconclusive \(deadline\))$/, line);
  }
  if (done.code === EXIT.inconclusive) assert.match(done.stdout, /^inconclusive \(deadline\): .*scenario (F4-failures-and-submits|wait-then-shutdown)/m);
  passed += 1;
});
