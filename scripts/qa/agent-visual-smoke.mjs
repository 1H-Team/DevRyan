#!/usr/bin/env node
// Sends one fixed prompt per agent to an already-running, isolated DevRyan
// loopback host and records, per agent: the model that actually answered,
// latency, tokens, tool errors, and the host process tree's RSS/CPU. It is
// the repeatable half of the visual smoke test (screenshots are taken in a
// browser against the same host). It never starts a host, reads credentials,
// or touches a user's installed app.
//
//   node scripts/qa/agent-visual-smoke.mjs --origin http://127.0.0.1:<port> --directory <workspace>
//     --expect <profile-evidence.json> --out <dir> [--host-pid <pid>] [--runtime-root <dir>]
//     [--cases orchestrator,builder,...] [--timeout-ms 900000] [--idle-seconds 30]
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { abortSessionTree, createEvaluationClient, fetchSessionTree } from '../agent-evals/client.mjs';

const execute = promisify(execFile);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const ACTIVE_SESSION_STATUSES = new Set(['busy', 'retry']);

// Unlike the strict evaluation client, a smoke turn does not abort on the
// first child error: provider recovery may still finish the work, and the
// outcome (not an early abort) is what the smoke test grades. It waits until
// no session in the tree is active, the root has a completed reply to this
// prompt, and every managed task is terminal, for three stable polls.
export function isSmokeTurnSettled({ tree, statuses, tasks, rootSessionId }) {
  if (tree.some(entry => ACTIVE_SESSION_STATUSES.has(String(statuses?.[entry.sessionId]?.type ?? '').toLowerCase()))) return false;
  if (tasks.some(task => !TERMINAL_TASK_STATUSES.has(String(task?.status ?? '').toLowerCase()))) return false;
  const root = tree.find(entry => entry.sessionId === rootSessionId);
  const replies = (root?.messages ?? []).filter(message => message?.info?.role === 'assistant');
  return replies.length > 0 && Number.isFinite(replies.at(-1)?.info?.time?.completed);
}

async function runSmokeTurn({ client, directory, selection, prompt, title, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let rootSessionId = null, tree = [], tasks = [], timedOut = false, stable = 0, signature = '';
  try {
    rootSessionId = (await client.createSession(directory, title, signal)).id;
    await client.promptSession(rootSessionId, directory, selection, prompt, signal);
    while (stable < 3) {
      await sleep(1_000);
      const [statuses, snapshot] = await Promise.all([client.getStatuses(directory, signal),
        client.getManagedSnapshot(rootSessionId, signal).catch(() => null)]);
      tasks = (Array.isArray(snapshot?.tasks) ? snapshot.tasks : []).filter(task => !task?.rootSessionId || task.rootSessionId === rootSessionId);
      tree = await fetchSessionTree(client, rootSessionId, directory, { signal,
        additionalSessionIds: tasks.map(task => task?.childSessionId).filter(id => typeof id === 'string' && id) });
      const next = JSON.stringify([tree.map(entry => [entry.sessionId, entry.messages.length]), tasks.map(task => [task?.taskId, task?.status])]);
      stable = isSmokeTurnSettled({ tree, statuses, tasks, rootSessionId }) ? (next === signature ? stable + 1 : 1) : 0;
      signature = next;
    }
  } catch (cause) {
    if (!signal.aborted) throw cause;
    timedOut = true;
  } finally { clearTimeout(timer); }
  if (timedOut && rootSessionId) await abortSessionTree(client, rootSessionId, directory, { timeoutMs: 30_000 }).catch(() => {});
  return { rootSessionId, sessionTree: tree, tasks, timedOut };
}

// Prompts are fixed so every phase measures the same work. Delegated cases
// name the specialist explicitly; the grader checks who actually ran.
export const SMOKE_CASES = Object.freeze([
  { id: 'orchestrator', rootAgent: 'orchestrator', expectAgent: 'orchestrator', prompt:
    'Without delegating and without editing any file, read README.md and src/price.js, then reply with exactly three short bullet points describing what src/price.js does. Do not use devryan_task.' },
  { id: 'builder', rootAgent: 'builder', expectAgent: 'builder', prompt:
    'Fix the bug in src/price.js: applyDiscount receives a percentage from 0 to 100 but treats it as a fraction. Add a test to test/price.test.mjs for a 10% discount, run `node --test`, and report the result in one line.' },
  { id: 'fixer', rootAgent: 'orchestrator', expectAgent: 'fixer', managed: true, prompt:
    'Delegate this to the fixer with devryan_task and do not do it yourself: in src/format.js add an exported function formatPercent(value) that formats 0.125 as "12.5%" using Intl.NumberFormat, add test/format.test.mjs covering it, and run `node --test`. Then report the result in one line.' },
  { id: 'designer', rootAgent: 'orchestrator', expectAgent: 'designer', managed: true, prompt:
    'Delegate this visual change to the designer with devryan_task: restyle the "Pay now" button in public/styles.css with an accessible high-contrast primary color, a visible hover and focus state, and rounded corners. Change only public/styles.css. Then report in one line.' },
  { id: 'explorer', rootAgent: 'orchestrator', expectAgent: 'explorer', managed: true, prompt:
    'Use devryan_task to ask the explorer where TAX_RATE is defined and which functions use it, with file:line references. Do not read files yourself. Report its answer.' },
  { id: 'librarian', rootAgent: 'orchestrator', expectAgent: 'librarian', managed: true, prompt:
    'Use devryan_task to ask the librarian to look up, in the official Node.js documentation, which files `node --test` runs when given no arguments. Report a two-line summary with the documentation URL.' },
  { id: 'oracle', rootAgent: 'orchestrator', expectAgent: 'oracle', managed: true, prompt:
    'Use devryan_task to ask the oracle for a focused, read-only review of src/price.js covering discount handling and rounding. Report its findings in at most four lines.' },
  { id: 'council', rootAgent: 'orchestrator', expectAgent: 'council', prompt:
    'Use the council to answer: should invoice totals be rounded per line item or only on the final total? Report the council\'s conclusion in three lines.' },
]);

export function parseSmokeArgs(argv) {
  const options = { origin: null, directory: null, expect: null, out: null, hostPid: null, runtimeRoot: null,
    cases: SMOKE_CASES.map(entry => entry.id), timeoutMs: 900_000, idleSeconds: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    if (flag === '--origin') options.origin = value();
    else if (flag === '--directory') options.directory = path.resolve(value());
    else if (flag === '--expect') options.expect = path.resolve(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--host-pid') options.hostPid = Number(value());
    else if (flag === '--runtime-root') options.runtimeRoot = path.resolve(value());
    else if (flag === '--cases') options.cases = value().split(',').map(entry => entry.trim()).filter(Boolean);
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value());
    else if (flag === '--idle-seconds') options.idleSeconds = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  const url = options.origin ? new URL(options.origin) : null;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('--origin must be a credential-free loopback URL');
  }
  if (!options.directory || !options.expect || !options.out) throw new Error('--directory, --expect and --out are required');
  if (options.hostPid !== null && (!Number.isSafeInteger(options.hostPid) || options.hostPid < 2)) throw new Error('--host-pid must be a process id');
  const known = new Set(SMOKE_CASES.map(entry => entry.id));
  if (!options.cases.length || options.cases.some(id => !known.has(id))) throw new Error(`--cases must be drawn from ${[...known].join(',')}`);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10_000) throw new Error('--timeout-ms must be at least 10000');
  if (!Number.isSafeInteger(options.idleSeconds) || options.idleSeconds < 0 || options.idleSeconds > 600) throw new Error('--idle-seconds must be 0-600');
  return options;
}

const PROCESS_CLASSES = [
  ['companion-worker', /devryan-tool/],
  ['execution-launcher', /DevRyan-execution-/],
  ['opencode-serve', /(DevRyan-opencode-[\w-]+|\bopencode)\s+serve\b/],
  ['lsp', /typescript-language-server|tsserver|(^|\/)(gopls|rust-analyzer|pyright|basedpyright|clangd)(\s|$)|vscode-[\w-]+-language-server|language-server/],
  ['claude-cli', /claude-code|@anthropic-ai\/claude|\/claude(\s|$)/],
  ['cursor', /cursor/i],
];
export const classifySmokeProcess = (command, isRoot) => isRoot ? 'host'
  : PROCESS_CLASSES.find(([, pattern]) => pattern.test(command))?.[0] ?? 'other';

export function parseProcessTable(output) {
  const rows = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rssKiB: Number(match[4]), command: match[5] });
  }
  return rows;
}

const QA_OBSERVER = /(?:^|[\s/])scripts\/(?:perf\/multi-session-sampler|qa\/agent-visual-smoke)\.mjs(?:\s|$)/;

export function summarizeProcessTree(rows, rootPid, runtimeRoot = null) {
  const children = new Map();
  for (const row of rows) { const list = children.get(row.ppid) ?? []; list.push(row); children.set(row.ppid, list); }
  const root = rows.find(row => row.pid === rootPid);
  const classes = {};
  let rssKiB = 0, cpu = 0, count = 0;
  const add = (row, isRoot) => {
    const name = classifySmokeProcess(row.command, isRoot);
    const entry = classes[name] ??= { count: 0, rssKiB: 0, cpu: 0 };
    entry.count += 1; entry.rssKiB += row.rssKiB; entry.cpu += row.cpu;
    rssKiB += row.rssKiB; cpu += row.cpu; count += 1;
  };
  if (root) {
    const queue = [root], seen = new Set();
    while (queue.length) {
      const row = queue.shift();
      if (seen.has(row.pid)) continue;
      seen.add(row.pid); add(row, row.pid === rootPid);
      queue.push(...(children.get(row.pid) ?? []));
    }
  }
  // Reparented leftovers that still reference this profile are orphans. QA
  // observers pointed at the profile (a detached sampler) are not.
  const orphans = runtimeRoot ? rows.filter(row => row.ppid === 1 && row.command.includes(runtimeRoot)
    && !QA_OBSERVER.test(row.command)).map(row => ({
    pid: row.pid, class: classifySmokeProcess(row.command, false) })) : [];
  return { rootPresent: Boolean(root), count, rssMiB: Math.round(rssKiB / 1024), cpu: Math.round(cpu * 10) / 10,
    classes: Object.fromEntries(Object.entries(classes).map(([name, entry]) => [name, { ...entry, rssMiB: Math.round(entry.rssKiB / 1024) }])), orphans };
}

async function sampleProcesses(hostPid, runtimeRoot) {
  const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pcpu=,rss=,command='], { maxBuffer: 32 * 1024 * 1024 });
  return summarizeProcessTree(parseProcessTable(stdout), hostPid, runtimeRoot);
}

function createSampler(options) {
  const samples = [];
  let timer = null, label = 'idle';
  const tick = async () => {
    try { samples.push({ t: Date.now(), label, ...await sampleProcesses(options.hostPid, options.runtimeRoot) }); }
    catch { /* A failed ps sample is recorded as a gap, not a failure. */ }
  };
  return {
    samples,
    setLabel(value) { label = value; },
    start() { if (options.hostPid) { void tick(); timer = setInterval(tick, 2_000); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

const modelOf = info => info?.providerID && info?.modelID ? `${info.providerID}/${info.modelID}` : null;
const agentOf = info => info?.agent ?? info?.mode ?? null;

// Grades one finished session tree: who ran, on which model, and whether any
// assistant message or tool call ended in error.
export function gradeSmokeTree(testCase, tree, expectedSelections, backupModels = {}) {
  const failures = [];
  const agentsSeen = [];
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const tools = { total: 0, errors: 0, byName: {} };
  const errors = [];
  for (const entry of tree) {
    for (const message of entry.messages ?? []) {
      const info = message?.info;
      if (info?.role !== 'assistant') continue;
      const seen = { sessionId: entry.sessionId, root: entry.parentSessionId === null, agent: agentOf(info), model: modelOf(info),
        variant: info.variant ?? null };
      if (!agentsSeen.some(row => row.sessionId === seen.sessionId && row.agent === seen.agent && row.model === seen.model)) agentsSeen.push(seen);
      usage.input += info.tokens?.input ?? 0; usage.output += info.tokens?.output ?? 0; usage.reasoning += info.tokens?.reasoning ?? 0;
      usage.cacheRead += info.tokens?.cache?.read ?? 0; usage.cacheWrite += info.tokens?.cache?.write ?? 0; usage.cost += info.cost ?? 0;
      if (info.error) errors.push({ sessionId: entry.sessionId, name: info.error.name ?? 'error' });
      for (const part of message.parts ?? []) {
        if (part?.type !== 'tool') continue;
        tools.total += 1; tools.byName[part.tool] = (tools.byName[part.tool] ?? 0) + 1;
        if (part.state?.status === 'error') tools.errors += 1;
      }
    }
  }
  const expected = expectedSelections?.[testCase.expectAgent] ?? null;
  const backup = backupModels?.[testCase.expectAgent]?.model ?? null;
  const warnings = [];
  const ran = agentsSeen.filter(row => row.agent === testCase.expectAgent);
  if (!ran.length) failures.push(`expected agent ${testCase.expectAgent} did not answer`);
  else if (expected?.model) {
    const unexpected = [...new Set(ran.map(row => row.model))].filter(model => model !== expected.model && model !== backup);
    if (unexpected.length) failures.push(`${testCase.expectAgent} answered on ${unexpected.join(',')} instead of ${expected.model}`);
    else if (backup && ran.some(row => row.model === backup)) warnings.push(`${testCase.expectAgent} recovered on its backup model ${backup}`);
  }
  if (errors.length) failures.push(`${errors.length} assistant message error(s): ${[...new Set(errors.map(row => row.name))].join(',')}`);
  usage.cost = Math.round(usage.cost * 10_000) / 10_000;
  return { agentsSeen, expectedModel: expected?.model ?? null, expectedVariant: expected?.variant ?? null, usage, tools, errors, failures, warnings };
}

const firstActivityMs = (tree, startedAt) => {
  const root = tree.find(entry => entry.parentSessionId === null);
  const times = (root?.messages ?? []).filter(message => message?.info?.role === 'assistant')
    .flatMap(message => (message.parts ?? []).map(part => part?.time?.start).filter(Number.isFinite));
  return times.length ? Math.max(0, Math.min(...times) - startedAt) : null;
};

export async function runAgentVisualSmoke(options) {
  const evidence = JSON.parse(await fs.readFile(options.expect, 'utf8'));
  const selections = evidence.agentSelections ?? {};
  const backups = evidence.orchestrationSidecar?.agentBackupModels ?? {};
  const client = createEvaluationClient({ baseUrl: options.origin, requestTimeoutMs: 120_000, pollIntervalMs: 500 });
  await fs.mkdir(options.out, { recursive: true });
  const sampler = createSampler(options);
  sampler.start();
  const results = [];
  try {
    for (const id of options.cases) {
      const testCase = SMOKE_CASES.find(entry => entry.id === id);
      const selection = selections[testCase.rootAgent];
      const [providerId, ...model] = String(selection?.model ?? '').split('/');
      if (!providerId || !model.length) { results.push({ id, status: 'failed', failures: [`no selection for ${testCase.rootAgent}`] }); continue; }
      sampler.setLabel(id);
      const startedAt = Date.now();
      let turn = null, error = null;
      try {
        turn = await runSmokeTurn({ client, directory: options.directory, title: `Visual smoke: ${id}`,
          selection: { providerId, modelId: model.join('/'), agent: testCase.rootAgent, variant: selection.variant ?? null },
          prompt: testCase.prompt, timeoutMs: options.timeoutMs });
      } catch (cause) { error = { code: cause?.code ?? 'error', message: String(cause?.message ?? cause).slice(0, 300) }; }
      const tree = turn?.sessionTree ?? [];
      const grade = gradeSmokeTree(testCase, tree, selections, backups);
      const tasks = (turn?.tasks ?? []).map(task => ({ taskId: task?.taskId ?? null, priorTaskId: task?.priorTaskId ?? null, agent: task?.agent ?? null,
        model: task?.providerId && task?.modelId ? `${task.providerId}/${task.modelId}` : null, variant: task?.variant ?? null,
        executionKind: task?.executionKind ?? null, status: task?.status ?? null }));
      // A failed attempt superseded by a later attempt in the same lineage is
      // recovery, not failure; only each lineage's final attempt counts.
      const superseded = new Set(tasks.map(task => task.priorTaskId).filter(Boolean));
      const failedTasks = tasks.filter(task => !superseded.has(task.taskId) && task.status !== 'completed');
      const failures = [...(error ? [`turn failed: ${error.code}`] : []), ...(turn?.timedOut ? ['timed out'] : []),
        ...(failedTasks.length ? [`${failedTasks.length} managed task(s) not completed: ${failedTasks.map(task => task.status).join(',')}`] : []),
        ...grade.failures];
      const result = { id, rootAgent: testCase.rootAgent, expectAgent: testCase.expectAgent, status: failures.length ? 'failed' : 'passed',
        failures, rootSessionId: turn?.rootSessionId ?? null, durationMs: Date.now() - startedAt, firstActivityMs: firstActivityMs(tree, startedAt),
        tasks, ...grade, error };
      results.push(result);
      console.error(JSON.stringify({ id, status: result.status, durationMs: result.durationMs, firstActivityMs: result.firstActivityMs,
        agents: grade.agentsSeen.map(row => `${row.agent}:${row.model}`), tasks: tasks.map(task => `${task.executionKind}:${task.model}:${task.status}`),
        toolErrors: grade.tools.errors, failures, warnings: grade.warnings }));
    }
    sampler.setLabel('settle');
    if (options.hostPid && options.idleSeconds) await new Promise(resolve => setTimeout(resolve, options.idleSeconds * 1_000));
  } finally { sampler.stop(); }
  const busy = sampler.samples.filter(sample => sample.label !== 'settle' && sample.label !== 'idle');
  const settle = sampler.samples.filter(sample => sample.label === 'settle');
  const last = settle.slice(-5);
  const resources = options.hostPid ? {
    peakRssMiB: Math.max(0, ...busy.map(sample => sample.rssMiB)),
    peakProcesses: Math.max(0, ...busy.map(sample => sample.count)),
    peakByClassMiB: busy.reduce((peaks, sample) => {
      for (const [name, entry] of Object.entries(sample.classes)) peaks[name] = Math.max(peaks[name] ?? 0, entry.rssMiB);
      return peaks;
    }, {}),
    settledCpu: last.length ? Math.round(last.reduce((sum, sample) => sum + sample.cpu, 0) / last.length * 10) / 10 : null,
    settledRssMiB: last.at(-1)?.rssMiB ?? null,
    settledClasses: last.at(-1)?.classes ?? null,
    orphans: last.at(-1)?.orphans ?? [],
  } : null;
  const report = { version: 1, origin: options.origin, generatedAt: new Date().toISOString(), selections,
    passed: results.filter(row => row.status === 'passed').length, failed: results.filter(row => row.status !== 'passed').length,
    results, resources, samples: sampler.samples };
  await fs.writeFile(path.join(options.out, 'smoke-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseSmokeArgs(process.argv.slice(2));
  const report = await runAgentVisualSmoke(options);
  const table = report.results.map(row => ({ case: row.id, status: row.status, agent: row.expectAgent,
    model: [...new Set((row.agentsSeen ?? []).filter(seen => seen.agent === row.expectAgent).map(seen => seen.model))].join(',') || '-',
    seconds: Math.round((row.durationMs ?? 0) / 100) / 10, firstActivitySeconds: row.firstActivityMs === null ? null : Math.round(row.firstActivityMs / 100) / 10,
    input: row.usage?.input ?? null, cacheRead: row.usage?.cacheRead ?? null, output: row.usage?.output ?? null, toolErrors: row.tools?.errors ?? null }));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, table, resources: report.resources }, null, 2));
  if (report.failed) process.exitCode = 1;
}
