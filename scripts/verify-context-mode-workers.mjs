// Optional integration check against a disposable Context Mode installation.
// Run with Bun so the worker uses the same runtime as managed OpenCode.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { applyContextModeHotfix } from '../packages/web/server/lib/opencode/context-mode-hotfix.js';

const root = process.cwd();
const packageRoot = path.resolve(process.argv[2] || '.cache/context-mode-worker-check');
assert.ok(packageRoot.startsWith(path.join(root, '.cache') + path.sep), 'Use a disposable package inside .cache');
const hotfix = applyContextModeHotfix({ configDirectory: packageRoot });
assert.ok(hotfix.ok, hotfix.error);
const build = path.join(packageRoot, 'node_modules/context-mode/build');
const { ContextModeWorkerPool } = await import(pathToFileURL(path.join(build, 'devryan-context-mode-worker-pool.js')).href);
const runRoot = await fs.mkdtemp(path.join(root, '.cache/context-worker-integration-'));
const projects = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
  const project = path.join(runRoot, `project-${index}`);
  await fs.mkdir(project);
  return project;
}));
const env = { ...process.env, CONTEXT_MODE_PLATFORM: 'opencode', CONTEXT_MODE_DIR: path.join(runRoot, 'context-data'),
  OPENCODE_CONFIG_DIR: path.join(runRoot, 'config'), OPENCHAMBER_DATA_DIR: path.join(runRoot, 'runtime-data'),
  XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'), XDG_DATA_HOME: path.join(runRoot, 'xdg-data') };
const pool = new ContextModeWorkerPool({ workerURL: pathToFileURL(path.join(build, 'devryan-context-mode-worker.js')) });
const call = (index, name, args) => pool.execute({ name, args, env, projectDir: projects[index], sessionId: `ses_synthetic_${index}` });
const output = (result) => JSON.stringify(result);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    // Bun may retain a terminated worker's dead child as a zombie until the
    // runtime exits. A zombie cannot execute; report it separately below.
    return !execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return false; }
};
const deadline = setTimeout(async () => { console.error('Worker integration check timed out'); await pool.close(); process.exit(1); }, 45_000);
try {
  for (let index = 0; index < 6; index++) {
    console.log(`Indexing synthetic project ${index + 1}/6`);
    const indexed = await call(index, 'ctx_index', { content: `# Fixture\nworkerfixture This project owns isolated payload number ${index}.`, source: 'fixture' });
    assert.ok(!indexed.isError, output(indexed));
    assert.ok(pool.workers.size <= 4);
  }
  // Project zero was evicted: reopening must retain its existing database,
  // without returning another project's identically named source.
  const search = output(await call(0, 'ctx_search', { queries: ['workerfixture'], source: 'fixture' }));
  assert.ok(search.includes('isolated payload number 0'), search);
  assert.ok(!search.includes('isolated payload number 5'), search);
  const background = await call(0, 'ctx_execute', { language: 'javascript', code: 'console.log("owned-background");', timeout: 1000, background: true, cwd: projects[0] });
  assert.ok(output(background).includes('backgrounded'), output(background));
  const backgroundSlot = [...pool.workers].find((slot) => slot.processes.size > 0);
  assert.ok(backgroundSlot, 'Background child must be tracked');
  const pids = [...backgroundSlot.processes];
  for (let index = 1; index < 6; index++) {
    await call(index, 'ctx_search', { queries: ['workerfixture'], source: 'fixture' });
    assert.ok(pool.workers.has(backgroundSlot), 'An active background command must pin its worker');
  }
  // Simulate only this disposable worker crashing. The pool must clean up its
  // tracked background child; it must not rerun the original command.
  await backgroundSlot.worker.terminate();
  for (let index = 0; index < 40 && pids.some(alive); index++) await sleep(25);
  assert.ok(pids.every((pid) => !alive(pid)), 'Crashed worker left an owned child running');
  console.log(JSON.stringify({ ok: true, projects: 6, maxWorkers: 4, reopenedIndexAccurate: true,
    projectIsolation: true, backgroundPinsWorker: true, crashStopsBackground: true,
    caveat: 'Bun can defer reaping an already dead child until runtime exit after a hard worker crash.', runRoot }, null, 2));
} finally {
  clearTimeout(deadline);
  await pool.close();
}
