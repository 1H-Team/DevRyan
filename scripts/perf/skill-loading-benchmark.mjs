#!/usr/bin/env node
// Real companion + deterministic loopback model. Both arms use private homes,
// ledgers and copies of the same committed tree; no installed-app state is read.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reservePort, startOwnedProcess } from '../qa/process.mjs';
import { startRevertModelFixture } from '../qa/revert-model-fixture.mjs';
import { createSessionExecutionHost } from '../../packages/web/server/lib/opencode/session-execution-host.js';
import { createManagedOrchestrationPrivateHost } from '../../packages/web/server/lib/orchestration/private-host.js';
import { resolveCursorRipgrepPath } from '../../packages/cursor-sdk-runtime/ripgrep-path.js';
import { pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '../..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--baseline', '--candidate', '--launcher', '--out'].includes(key) || !process.argv[i + 1]) throw new Error('Expected --baseline, --candidate, --launcher and --out paths');
  options[key.slice(2)] = path.resolve(process.argv[i + 1]);
}
for (const key of ['baseline', 'candidate', 'launcher', 'out']) assert(options[key], `Missing --${key}`);
const run = promisify(execFile);
const hashFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const cache = path.join(repository, '.cache/perf/skill-loading');
await fs.mkdir(cache, { recursive: true });
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

async function measure(size, arm) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(cache, `${size}-${arm}-`)));
  const directory = path.join(root, 'project');
  const origin = `http://127.0.0.1:${await reservePort()}`;
  const actions = [], receipts = [];
  const host = createSessionExecutionHost({ dataDirectory: path.join(root, 'app-data'), getLauncher: () => options.launcher,
    buildOpenCodeUrl: route => origin + route, recordReceipt: receipt => receipts.push(receipt) });
  const bridge = createManagedOrchestrationPrivateHost({ handleRpc: async ({ method, params }) => {
    assert.equal(method, 'session_execution');
    actions.push({ callID: params.callID, action: params.action });
    return host.plugin(params);
  } });
  let model, upstream;
  const request = async (route, body) => {
    const url = new URL(route, origin); url.searchParams.set('directory', directory);
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(300_000) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  try {
    if (size === 'repository') await run('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(repository).href, directory]);
    else { await fs.mkdir(directory); await run('git', ['init', '--quiet', directory]); }
    // This local fixture skill takes precedence over skills in the cloned tree.
    const skillDir = path.join(root, 'fixture-skills', 'latency');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Latency Fixture\ndescription: deterministic skill load\n---\nRead reference.txt. Loading this skill never runs scripts.\n');
    await fs.writeFile(path.join(skillDir, 'reference.txt'), 'Fixture reference.\n');
    model = await startRevertModelFixture();
    const home = path.join(root, 'home'); await fs.mkdir(home);
    const configDirectory = path.join(root, 'config-only'); await fs.mkdir(configDirectory);
    const env = {
      PATH: [path.dirname(resolveCursorRipgrepPath().path), process.env.PATH].filter(Boolean).join(path.delimiter),
      HOME: home, TMPDIR: home, OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture',
        provider: { fixture: model.config }, plugin: [], mcp: {}, snapshot: false, permission: 'allow',
        skills: { paths: [path.dirname(skillDir)], urls: [] } }),
      ...await bridge.start(), DEVRYAN_EXECUTION_BOUNDARY: '1', DEVRYAN_EXECUTION_TRACE: '1',
    };
    upstream = startOwnedProcess(options[arm], ['serve', '--hostname', '127.0.0.1', '--port', new URL(origin).port,
      '--print-logs', '--log-level', 'ERROR'], { cwd: directory, env });
    const deadline = Date.now() + 60_000;
    while (true) {
      upstream.check();
      if (await fetch(origin + '/global/health', { signal: AbortSignal.timeout(1000) }).then(async r => { await r.text(); return r.ok; }, () => false)) break;
      assert(Date.now() < deadline, 'Companion startup timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const session = await request('/session', { title: 'Skill latency fixture' });
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      const result = await request(`/session/${session.id}/message`, { model: { providerID: 'fixture', modelID: 'fixture' },
        agent: 'build', parts: [{ type: 'text', text: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name: 'skill', args: { name: 'Latency Fixture' } })}` }] });
      const totalMs = performance.now() - started;
      const messages = await request(`/session/${session.id}/message`);
      const call = messages.filter(row => row.info.parentID === result.info.parentID).flatMap(row => row.parts)
        .find(part => part.type === 'tool' && part.tool === 'skill');
      assert.equal(call?.state.status, 'completed', JSON.stringify(call));
      assert(call.state.output.includes('Loading this skill never runs scripts.'));
      assert(call.state.output.includes(path.join(skillDir, 'reference.txt')));
      const flow = actions.filter(row => row.callID === call.callID).map(row => row.action);
      if (arm === 'candidate') assert.deepEqual(flow, ['direct-admit', 'direct-finish']);
      else assert(flow.includes('begin') && flow.includes('claim') && flow.includes('finish'));
      assert(receipts.some(receipt => receipt.callID === call.callID && receipt.files.length === 0));
      samples.push({ cold: i === 0, toolMs: call.state.time.end - call.state.time.start, totalMs: Math.round(totalMs), actions: flow });
      console.error(`${size}/${arm} ${i === 0 ? 'cold' : 'warm'} skill: ${samples.at(-1).toolMs} ms`);
    }
    const log = upstream.getLog();
    if (arm === 'candidate') assert(!/^worker [a-z]+ \d+ms$/m.test(log), 'Candidate unexpectedly booted a worker');
    return { size, arm, samples, warmMedianMs: median(samples.slice(1).map(row => row.toolMs)),
      workerObserved: /^worker [a-z]+ \d+ms$/m.test(log) };
  } catch (error) {
    if (upstream) console.error(upstream.getLog());
    throw error;
  } finally {
    await upstream?.stop(); await model?.stop(); await bridge.stop(); await host.drain();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const rows = [];
for (const size of ['small', 'repository']) {
  // Reverse arm order on the larger fixture to reduce systematic ordering bias.
  for (const arm of size === 'small' ? ['baseline', 'candidate'] : ['candidate', 'baseline']) rows.push(await measure(size, arm));
}
const comparisons = ['small', 'repository'].map(size => {
  const baseline = rows.find(row => row.size === size && row.arm === 'baseline').warmMedianMs;
  const candidate = rows.find(row => row.size === size && row.arm === 'candidate').warmMedianMs;
  return { size, baselineMs: baseline, candidateMs: candidate, reduction: 1 - candidate / baseline };
});
const report = { version: 1, at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
  baselineSha256: await hashFile(options.baseline), candidateSha256: await hashFile(options.candidate),
  scope: 'Isolated real companions with a loopback model; warm medians exclude each arm’s first call. No live-provider latency claim.', rows, comparisons };
await fs.mkdir(path.dirname(options.out), { recursive: true });
await fs.writeFile(options.out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(comparisons, null, 2));
assert(comparisons.every(row => row.reduction >= 0.8), 'Warm skill loading must improve by at least 80%');
