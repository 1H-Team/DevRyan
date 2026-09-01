// Isolated OpenCode + provisioned Context Mode benchmark. Never points at a
// user's runtime, configuration, indexes, credentials, or repository contents.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyContextModeHotfix } from '../packages/web/server/lib/opencode/context-mode-hotfix.js';

const root = process.cwd();
const packageRoot = path.resolve(process.argv[2] || '.cache/context-mode-worker-check');
if (!packageRoot.startsWith(path.join(root, '.cache') + path.sep)) throw new Error('Use an isolated package under the repository .cache directory');
const hotfix = applyContextModeHotfix({ configDirectory: packageRoot });
if (!hotfix.ok) throw new Error(hotfix.error);
const reusedProfile = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (reusedProfile && !reusedProfile.startsWith(path.join(root, '.cache/session-create-benchmark-'))) throw new Error('Only a synthetic benchmark profile can be reused');
const runRoot = reusedProfile ?? await fs.mkdtemp(path.join(root, '.cache/session-create-benchmark-'));
const project = path.join(runRoot, 'project');
const files = path.join(project, 'source');
await fs.mkdir(files, { recursive: true });
for (let index = 0; index < 200; index++) {
  const paragraphs = Array.from({ length: 30 }, (_, n) => `## Section ${n}\nSynthetic documentation for module ${index}, section ${n}. workerneedle${index} supports indexed search and session creation benchmarking.\n`);
  await fs.writeFile(path.join(files, `module-${index}.md`), `# Module ${index}\n${paragraphs.join('\n')}`);
}
const config = path.join(runRoot, 'config');
await fs.mkdir(config, { recursive: true });
const plugin = path.join(runRoot, 'benchmark-plugin.mjs');
const commandFile = path.join(runRoot, 'command.json');
const resultFile = path.join(runRoot, 'result.json');
await fs.writeFile(plugin, `import fs from 'node:fs/promises';
import { ContextModePlugin } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'node_modules/context-mode/build/adapters/opencode/plugin.js')).href)};
export default { id: 'devryan-isolated-creation-benchmark', server: async (ctx) => {
  const hooks = await ContextModePlugin(ctx);
  let active = false;
  const timer = setInterval(async () => {
    if (active) return;
    let command;
    try { command = JSON.parse(await fs.readFile(${JSON.stringify(commandFile)}, 'utf8')); await fs.unlink(${JSON.stringify(commandFile)}); } catch { return; }
    active = true;
    await fs.writeFile(${JSON.stringify(path.join(runRoot, 'started'))}, '1');
    try {
      const result = await hooks.tool[command.name].execute(command.args, { directory: ctx.directory, sessionID: command.sessionId, metadata() {} });
      await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true, result }));
    } catch (error) { await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: String(error) })); }
    finally { active = false; }
  }, 10);
  timer.unref();
  return hooks;
}};
`);
await fs.writeFile(path.join(config, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [pathToFileURL(plugin).href], permission: { '*': 'allow' } }));
const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const log = await fs.open(path.join(runRoot, 'runtime.log'), 'a');
const startRuntime = () => spawn(process.env.DEVRYAN_BENCH_OPENCODE || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: project, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: path.join(config, 'opencode.json'),
    XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'), XDG_DATA_HOME: path.join(runRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(runRoot, 'xdg-state'), XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache'),
    OPENCODE_SERVER_PASSWORD: '', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCHAMBER_DATA_DIR: path.join(runRoot, 'runtime-data'),
    CONTEXT_MODE_PLATFORM: 'opencode', CONTEXT_MODE_DIR: path.join(runRoot, 'context-data'),
  },
});
let child = startRuntime();
const stopRuntime = async () => {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  // This is exclusively the synthetic child spawned above. OpenCode/plugin
  // signal handlers can retain its listener; never leave verification servers
  // behind or apply this escalation to a user's managed runtime.
  const escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
  await exited;
  clearTimeout(escalation);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (pathname, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Isolated runtime HTTP ${response.status}`);
  return response.json();
};
const waitFile = async (file) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { try { return await fs.readFile(file, 'utf8'); } catch { await sleep(20); } }
  throw new Error('Isolated workload did not finish within 120 seconds');
};
const samples = async (count = 30) => {
  const values = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    await request('/session', { title: 'Synthetic creation benchmark' });
    // Explicit controlled ownership latency, reported separately from OpenCode.
    await sleep(10);
    values.push(performance.now() - start);
  }
  return values;
};
const summarize = (values) => ({ count: values.length, p50: values.toSorted((a, b) => a - b)[Math.floor(values.length * .5)],
  p95: values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1], max: Math.max(...values) });
const waitReady = async () => {
  const readinessDeadline = Date.now() + 90_000;
  for (;;) {
    try { await request('/global/health'); break; } catch { if (Date.now() > readinessDeadline || child.exitCode !== null) throw new Error(`Isolated runtime failed startup; see ${runRoot}/runtime.log`); await sleep(100); }
  }
};
try {
  await waitReady();
  if (reusedProfile) {
    const values = [];
    for (let index = 0; index < 30; index++) {
      values.push(...await samples(1));
      if ((index + 1) % 5 === 0) console.log(`Quiet cold benchmark: ${index + 1}/30 samples`);
      if (index < 29) { await stopRuntime(); child = startRuntime(); await waitReady(); }
    }
    const result = { runRoot, controlledOwnershipMs: 10, cold: summarize(values) };
    await fs.writeFile(path.join(runRoot, 'cold-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.cold.p95 >= 1000) process.exitCode = 1;
  } else {
  const cold = await samples(1);
  const baseline = await samples();
  const sessions = await Promise.all(Array.from({ length: 4 }, (_, index) => request('/session', { title: `Synthetic workload ${index}` })));
  const phases = {};
  for (const phase of ['fresh', 'populated']) {
    await fs.rm(resultFile, { force: true });
    await fs.rm(path.join(runRoot, 'started'), { force: true });
    await fs.writeFile(commandFile, JSON.stringify({ name: 'ctx_index', sessionId: sessions[0].id, args: { path: files, source: 'benchmark-source', maxFiles: 200 } }));
    await waitFile(path.join(runRoot, 'started'));
    const values = await samples();
    const result = JSON.parse(await waitFile(resultFile));
    if (!result.ok) throw new Error(result.error);
    phases[phase] = { ...summarize(values), result: result.result.output.slice(0, 250) };
  }
  await fs.rm(resultFile, { force: true });
  await fs.writeFile(commandFile, JSON.stringify({ name: 'ctx_search', sessionId: sessions[1].id, args: { queries: ['workerneedle42'], source: 'benchmark-source' } }));
  const search = JSON.parse(await waitFile(resultFile));
  if (!search.ok || !search.result.output.includes('workerneedle42')) throw new Error('Index/search accuracy check failed');
  const restarts = [];
  for (let index = 0; index < 30; index++) {
    await stopRuntime();
    child = startRuntime();
    await waitReady();
    restarts.push(...await samples(1));
    if ((index + 1) % 5 === 0) console.log(`Measured ${index + 1}/30 cold-process creates using the already provisioned isolated profile`);
  }
  const result = { runtime: 'isolated OpenCode with native Context Mode tools', samplesPerPhase: 30, files: 200,
    controlledOwnershipMs: 10, initialBootstrap: summarize(cold), cold: summarize(restarts), baseline: summarize(baseline), ...phases,
    indexingOverheadP95: Math.max(phases.fresh.p95, phases.populated.p95) - summarize(baseline).p95,
    searchAccuracy: true, caveat: 'Ownership latency is controlled; this is not a hosted Supabase latency measurement. Four sessions are created; indexing runs with an initiating session identity.' };
  await fs.writeFile(path.join(runRoot, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ runRoot, ...result }, null, 2));
  if (result.cold.p95 >= 1000 || result.baseline.p95 >= 1000 || result.indexingOverheadP95 > 250) process.exitCode = 1;
  }
} finally {
  await stopRuntime();
  await log.close();
}
