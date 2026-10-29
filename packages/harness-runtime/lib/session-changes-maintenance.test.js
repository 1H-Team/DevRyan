import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionChangeRuntime } from './session-changes.js';
import { finishFixtureMutation } from '../test/session-change-fixture.js';
import { changeKey } from './session-changes-store.js';

const test = (name, run) => bunTest(name, run, 60_000);
let base, directory, storage, runtime, count;
const input = () => ({ directory, sessionID: 'root', messageID: 'message', userMessageID: 'user', callID: `call_${++count}` });
const stats = () => Object.fromEntries(execFileSync('git', ['--git-dir', path.join(storage, changeKey(directory), 'git'), 'count-objects', '-v'], { encoding: 'utf8' })
  .trim().split('\n').map((line) => line.split(': ')).map(([name, value]) => [name, Number(value)]));
const capture = async (index) => {
  const op = input(); await runtime.begin(op);
  await fs.writeFile(path.join(directory, `f${index % 4}.txt`), `edit ${index}\n`);
  await finishFixtureMutation(runtime, op, storage);
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-changes-maintenance-')));
  directory = path.join(base, 'repo'); storage = path.join(base, 'storage'); await fs.mkdir(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  for (let index = 0; index < 4; index++) await fs.writeFile(path.join(directory, `f${index}.txt`), 'base\n');
  count = 0;
});
afterEach(async () => { await runtime?.drain(); await fs.rm(base, { recursive: true, force: true }); }, 30_000);

test('loose objects trigger collection between the every-N runs', async () => {
  // Control: only the operation count triggers, so loose objects accumulate.
  runtime = createSessionChangeRuntime({ directory: storage, maintenanceEvery: 1_000_000, maintenanceLooseObjects: Number.POSITIVE_INFINITY });
  for (let index = 0; index < 6; index++) await capture(index);
  const unbounded = stats();
  expect(unbounded.packs).toBe(0);
  expect(unbounded.count).toBeGreaterThan(20);
  await runtime.drain(); await fs.rm(storage, { recursive: true, force: true });
  for (let index = 0; index < 4; index++) await fs.writeFile(path.join(directory, `f${index}.txt`), 'base\n');

  runtime = createSessionChangeRuntime({ directory: storage, maintenanceEvery: 1_000_000, maintenanceLooseObjects: 20 });
  const counts = [];
  for (let index = 0; index < 6; index++) { await capture(index); counts.push(stats().count); }
  expect(stats().packs).toBeGreaterThanOrEqual(1);
  // Collection packs and prunes once the trigger is reached: the count stays below it.
  expect(Math.max(...counts)).toBeLessThan(20);
  const summary = await runtime.summarize({ directory, rootSessionID: 'root' });
  expect(summary).toMatchObject({ coverage: 'complete', fileCount: 4 });
  await runtime.restore({ directory, rootSessionID: 'root', revision: summary.revision });
  for (let index = 0; index < 4; index++) expect(await fs.readFile(path.join(directory, `f${index}.txt`), 'utf8')).toBe('base\n');
});
