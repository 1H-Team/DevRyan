// Explicit opt-in: `node scripts/qa/cursor-usage-live.mjs prepare|run|summary ROOT ...`.
// Importing the module never reads installed credentials or submits inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { requireCacheDirectory, seedEditingFixture, verifyEditingFixture, editingPrompts } from './claude-quota-fixture.mjs';
import { seedSustainedFixture, sustainedPrompts, sustainedFileHashes, verifySustainedFixture } from './claude-quota-sustained.mjs';
import { projectCursorQuota, cursorQuotaDelta, admitCursorWork, estimateCursorWorkPoints, cursorReferenceMatchesAttempt, summarizeCursorRuns, summarizeCursorStudy, canReuseCursorQuota } from './cursor-usage-evidence.mjs';
import { createQaProcessOwnership } from './process-ownership.mjs';
import { exerciseCursorLifecycle } from './cursor-usage-lifecycle.mjs';
import { useDetachedChildren } from '../dev-child-utils.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = async (promise, ms, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
};
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = async (file, value) => {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
};

async function access(onQuotaReadError = () => {}) {
  const { readAuthFile } = await import('../../packages/web/server/lib/opencode/auth.js');
  const { getCursorSdkApiKey } = await import('../../packages/cursor-sdk-runtime/index.js');
  const { fetchCursorAcpQuota } = await import('../../packages/web/server/lib/quota/providers/cursor-acp.js');
  const apiKey = getCursorSdkApiKey({ readAuth: readAuthFile });
  if (!apiKey) throw new Error('Configured Cursor SDK access is required');
  let snapshot; let pending;
  const quota = async ({ freshAfter = 0 } = {}) => {
    if (canReuseCursorQuota(snapshot, Date.now(), freshAfter, 60_000)) return snapshot;
    pending ??= fetchCursorAcpQuota({
      writeManagedCredential: () => { throw new Error('Study cannot change installed credentials'); },
    }).then(payload => {
      try { snapshot = projectCursorQuota(payload); return snapshot; }
      catch (error) {
        const reason = /429/.test(payload.error || '') ? 'rate-limit'
          : /timeout|abort/i.test(payload.error || '') ? 'request-timeout'
          : /expired|credentials/i.test(payload.error || '') ? 'credential-unavailable' : 'unavailable';
        const detail = String(payload.error || '').replace(/[A-Za-z0-9_./+=-]{32,}/g, '[redacted]').slice(0, 240);
        onQuotaReadError({ at: Date.now(), reason, detail, lastFetchedAt: snapshot?.fetchedAt ?? null });
        if (canReuseCursorQuota(snapshot, Date.now(), freshAfter)) return snapshot;
        throw new Error(`${error.message} (${reason}${detail ? `: ${detail}` : ''})`);
      }
    }).finally(() => { pending = null; });
    return pending;
  };
  return { apiKey, quota };
}

async function referenceActivity() {
  const { default: os } = await import('node:os');
  const directory = path.join(os.homedir(), '.config/openchamber/cursor-sdk-sessions');
  const rows = [];
  for (const name of (await fs.readdir(directory).catch(() => [])).sort()) {
    if (!name.endsWith('.json')) continue;
    const state = await readJson(path.join(directory, name));
    const messages = (state.records || []).map(row => row.info);
    rows.push({ id: state.sessionID, agentID: state.agentID, messages: messages.map(info => ({
      id: info.id, completed: info.time?.completed, finish: info.finish,
    })), active: messages.some(info => info.role === 'assistant' && !info.finish && !info.time?.completed) });
  }
  return { hash: hash(rows), active: rows.some(row => row.active) };
}

async function settledQuota(quota, readings = []) {
  let previous; let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    let next;
    try { next = await quota({ freshAfter: previous?.fetchedAt ?? Date.now() - 1 }); }
    catch (error) { lastError = error; }
    if (next) {
      readings.push(next);
      // A reset/decrease is an invalid comparison, not a transient fetch error.
      if (previous && Object.values(cursorQuotaDelta(previous, next)).every(value => value <= 0.000001)) return next;
      previous = next;
    }
    if (attempt < 5) await delay(15_000);
  }
  throw lastError || new Error('Cursor quota did not settle within the bounded reporting wait');
}

export async function prepareCursorUsageStudy(root) {
  root = await requireCacheDirectory(root);
  const file = path.join(root, 'study.json');
  if (await fs.stat(file).catch(() => null)) throw new Error('Study already exists; its budget cannot be reset');
  const { apiKey, quota } = await access();
  const require = createRequire(path.join(repository, 'packages/cursor-sdk-runtime/package.json'));
  const imported = require('@cursor/sdk');
  const sdk = imported.default || imported;
  const catalog = await sdk.Cursor.models.list({ apiKey });
  const { createCursorSdkRuntime } = await import('../../packages/cursor-sdk-runtime/index.js');
  const runtime = createCursorSdkRuntime({ env: { CURSOR_API_KEY: apiKey }, loadSdk: async () => ({ Cursor: { models: { list: async () => catalog } } }) });
  const provider = await runtime.refreshVirtualProvider({ force: true });
  await runtime.dispose();
  const { getAgentConfig, listConfigAgents } = await import('../../packages/web/server/lib/opencode/agents.js');
  const prompt = getAgentConfig('builder', repository)?.config?.prompt;
  if (!prompt) throw new Error('Selected Builder instructions are unavailable');
  const definitions = Object.fromEntries(listConfigAgents(repository).filter(agent => agent.name !== 'council' && agent.prompt)
    .map(agent => [agent.name, { description: agent.description || `${agent.name} DevRyan agent`, prompt: agent.prompt }]));
  const selections = {};
  for (const id of ['grok-4.6', 'auto', 'gpt-5.6-luna']) {
    const native = catalog.find(model => model.id === id);
    if (!native && id !== 'auto') throw new Error(`Model ${id} is unavailable`);
    const defaultParams = native?.variants?.find(variant => variant.isDefault)?.params || [];
    const variant = id === 'grok-4.6' ? 'high'
      : defaultParams.find(param => ['effort', 'reasoning'].includes(param.id))?.value || null;
    const row = provider.models[id];
    selections[id] = { variant, model: row?.variants?.[variant]?.cursorSdkModel || row?.options?.cursorSdkModel || { id },
      catalogAdvertised: Boolean(native) };
  }
  const control = path.join(root, 'control-runtime');
  if (!await fs.stat(control).catch(() => null)) throw new Error('Freeze the unchanged runtime before preparing the study');
  const baseline = await quota();
  const reference = await referenceActivity();
  if (reference.active) throw new Error('An installed Cursor session is active; defer live study admission');
  const study = { schemaVersion: 1, root, createdAt: Date.now(), baseline, reference,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    sdkPackage: path.resolve(path.dirname(require.resolve('@cursor/sdk')), '../../package.json'), selections, context: { prompt, definitions },
    contextSha256: hash({ prompt, definitions }), catalog, attempts: [], limitPoints: 10,
    isolation: 'Private marked home; native ambient user/team/plugin settings are absent in every arm. Frozen DevRyan Builder and specialist instructions remain enabled in runtime arms.' };
  await save(file, study);
  return { root, selections, baseline, contextSha256: study.contextSha256, definitionCount: Object.keys(definitions).length };
}

async function prepareAdapter(root, source, sdkPackage, observations) {
  const observer = path.join(root, 'observer.mjs');
  const usageProjection = path.join(root, 'observation-usage.mjs');
  await fs.copyFile(path.join(repository, 'packages/cursor-sdk-runtime/cursor-usage.js'), usageProjection);
  await fs.writeFile(observer, (await fs.readFile(path.join(repository, 'scripts/qa/cursor-usage-observer.mjs'), 'utf8'))
    .replace('../../packages/cursor-sdk-runtime/cursor-usage.js', './observation-usage.mjs'));
  const adapter = path.join(root, 'adapter');
  await fs.cp(source, adapter, { recursive: true, filter: file => !file.includes(`${path.sep}node_modules`) });
  const modules = path.join(adapter, 'node_modules');
  await fs.mkdir(path.join(modules, '@cursor/sdk'), { recursive: true });
  const require = createRequire(path.join(repository, 'packages/cursor-sdk-runtime/package.json'));
  for (const name of ['@modelcontextprotocol/sdk', 'zod']) {
    const packageRoot = name === 'zod' ? path.dirname(require.resolve('zod/package.json'))
      : path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/server/index.js')), '../../..');
    await fs.mkdir(path.dirname(path.join(modules, name)), { recursive: true });
    await fs.symlink(packageRoot, path.join(modules, name));
  }
  await fs.writeFile(path.join(modules, '@cursor/sdk/package.json'), '{"type":"module","exports":"./index.js"}');
  await fs.writeFile(path.join(modules, '@cursor/sdk/index.js'), `
    import {createRequire} from 'node:module'; import {appendFileSync} from 'node:fs';
    import {observeCursorSdk} from ${JSON.stringify(pathToFileURL(observer).href)};
    const require=createRequire(${JSON.stringify(sdkPackage)}); const mod=require('@cursor/sdk');
    const sdk=observeCursorSdk(mod.default||mod,row=>appendFileSync(${JSON.stringify(observations)},JSON.stringify({at:Date.now(),...row})+'\\n'));
    export const Agent=sdk.Agent, Cursor=sdk.Cursor;
  `);
  return adapter;
}

export async function runCursorUsageAttempt(root, modelID, arm, repetition, workload = 'small', workerHost = 'node') {
  root = await requireCacheDirectory(root);
  if (!['direct', 'control', 'candidate'].includes(arm) || !Number.isInteger(repetition) || repetition < 1 || repetition > 3
    || !['small', 'sustained', 'lifecycle', 'title-retry'].includes(workload)) throw new Error('Invalid study arm, repetition, or workload');
  if (workload === 'lifecycle' && arm === 'direct') throw new Error('Question lifecycle requires the DevRyan runtime');
  if (!['node', 'electron'].includes(workerHost) || (workerHost === 'electron' && arm !== 'candidate')) {
    throw new Error('Native Electron verification requires the current candidate runtime');
  }
  const lock = await fs.open(path.join(root, 'live.lock'), 'wx');
  let ownership; let child; let current; let study; let record; let guardTimer; let guardCheck = Promise.resolve(); let guardError;
  const studyFile = path.join(root, 'study.json');
  const pending = new Map();
  const request = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = randomUUID(); pending.set(id, { resolve, reject }); child.send({ id, type, ...extra });
  });
  let quota;
  try {
    const credentials = await access(error => { if (record) (record.quotaReadErrors ??= []).push(error); });
    const apiKey = credentials.apiKey;
    quota = credentials.quota;
    study = await readJson(studyFile);
    if (!study.selections[modelID]) throw new Error('Model is outside the approved study');
    current = await quota();
    const previous = study.attempts.at(-1);
    if (previous?.quotaError && !previous.quotaRecovery) throw new Error('The earlier quota reading is unsettled; investigate before continuing');
    if (previous?.outcome === 'running') throw new Error('An earlier attempt has not settled');
    if (previous?.after && Object.values(cursorQuotaDelta(previous.after, current)).some(value => value > 0.000001)) {
      throw new Error('Quota changed after the settled reading; attribution requires investigation');
    }
    const estimatedPoints = estimateCursorWorkPoints(study.attempts, { modelID, arm, workload });
    admitCursorWork({ baseline: study.baseline, current, requiredPoints: estimatedPoints,
      phase: arm === 'candidate' ? 'verification' : 'exploration' });
    const reference = await referenceActivity();
    if (reference.active) throw new Error('Concurrent installed Cursor activity');
    const attemptRoot = path.join(root, `${modelID}-${arm}-${repetition}-${Date.now()}`);
    await fs.mkdir(attemptRoot, { recursive: true });
    record = { id: path.basename(attemptRoot), modelID, arm, repetition, workload, workerHost, startedAt: Date.now(),
      before: current, estimatedPoints, referenceBefore: reference, outcome: 'running', turns: [] };
    study.attempts.push(record); await save(studyFile, study);
    const workspace = path.join(attemptRoot, 'workspace'); await fs.mkdir(workspace);
    if (workload !== 'sustained') await seedEditingFixture(workspace); else await seedSustainedFixture(workspace);
    const observations = path.join(attemptRoot, 'native.ndjson');
    const source = (workload === 'lifecycle' || workerHost === 'electron') && arm === 'candidate' ? path.join(repository, 'packages/cursor-sdk-runtime')
      : arm === 'control' ? path.join(root, 'control-runtime') : path.join(root, 'candidate-runtime');
    const adapter = await prepareAdapter(attemptRoot, source, study.sdkPackage, observations);
    const runtimeSources = {};
    for (const file of (await fs.readdir(adapter)).filter(file => /\.(?:js|mjs|json)$/.test(file)).sort()) {
      runtimeSources[file] = hash(await fs.readFile(path.join(adapter, file), 'utf8'));
    }
    record.runtimeSources = runtimeSources; record.runtimeSha256 = hash(runtimeSources);
    record.observerSha256 = hash(await fs.readFile(path.join(attemptRoot, 'observer.mjs'), 'utf8'));
    const qaHome = path.join(attemptRoot, 'home'); await fs.mkdir(qaHome);
    await fs.writeFile(path.join(qaHome, '.devryan-qa-home'), 'owned Cursor study home\n', { mode: 0o600 });
    for (const directory of ['tmp', '.config', '.local/share', '.cache']) await fs.mkdir(path.join(qaHome, directory), { recursive: true });
    const config = { root: attemptRoot, adapter, arm, workload, workerHost, workspace, ...study.selections[modelID], context: study.context };
    if (workerHost === 'electron') {
      config.workerBinary = createRequire(path.join(repository, 'packages/electron/package.json'))('electron');
    }
    if (workload === 'title-retry') {
      if (arm === 'direct' || modelID !== 'auto') throw new Error('The existing title path uses Auto; select a runtime arm');
      config.titleAdapter = path.join(attemptRoot, 'title-runtime.mjs');
      await fs.copyFile(arm === 'control' ? path.join(root, 'control-title-runtime.mjs')
        : path.join(repository, 'packages/web/server/lib/opencode/cursor-session-title-runtime.js'), config.titleAdapter);
      record.titleSourceSha256 = hash(await fs.readFile(config.titleAdapter, 'utf8'));
    }
    await save(path.join(attemptRoot, 'config.json'), config);
    const env = { PATH: process.env.PATH, USER: process.env.USER, CURSOR_API_KEY: apiKey,
      DEVRYAN_QA_HOME: qaHome, XDG_CONFIG_HOME: path.join(qaHome, '.config'), XDG_DATA_HOME: path.join(qaHome, '.local/share'),
      XDG_CACHE_HOME: path.join(qaHome, '.cache'), TMPDIR: path.join(qaHome, 'tmp'),
      OPENCHAMBER_DATA_DIR: path.join(qaHome, '.config/openchamber'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(qaHome, '.gitconfig'),
      NODE_OPTIONS: `--import=${JSON.stringify(path.join(repository, 'scripts/qa/isolated-home.mjs'))}` };
    child = fork(path.join(import.meta.dirname, 'cursor-usage-child.mjs'), [path.join(attemptRoot, 'config.json')], {
      cwd: workspace, env, execArgv: [], detached: useDetachedChildren, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    ownership = createQaProcessOwnership(child);
    let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    child.on('message', message => {
      if (message.ready) { readyResolve(true); return; }
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result); else entry.reject(new Error(`Study child: ${message.errorCode}`));
    });
    child.on('exit', code => { for (const entry of pending.values()) entry.reject(new Error(`Study child exited ${code}`)); pending.clear(); });
    await deadline(ready, 30_000, 'Study child startup unavailable');
    let checking = false;
    guardTimer = setInterval(() => {
      if (checking) return; checking = true;
      guardCheck = (async () => { try {
        const snapshot = await quota(); current = snapshot;
        admitCursorWork({ baseline: study.baseline, current, phase: arm === 'candidate' ? 'verification' : 'exploration' });
        if ((await referenceActivity()).hash !== reference.hash) throw new Error('Concurrent Cursor activity invalidates attribution');
      } catch (error) { guardError = error; void request('cancel').catch(() => {}); }
      finally { checking = false; } })();
    }, 30_000);
    if (workload === 'lifecycle') {
      record.lifecycle = await exerciseCursorLifecycle({ request, workspace, deadline, beforeSend: async () => {
        if (guardError) throw guardError;
        current = await quota();
        admitCursorWork({ baseline: study.baseline, current, phase: arm === 'candidate' ? 'verification' : 'exploration' });
      } });
      current = await quota();
      admitCursorWork({ baseline: study.baseline, current, phase: arm === 'candidate' ? 'verification' : 'exploration' });
      record.title = await deadline(request('title'), 90_000, 'Title inference deadline exceeded');
      if (typeof record.title?.title !== 'string' || !record.title.title.trim()) throw new Error('Native title generation was unavailable');
    }
    if (workload === 'title-retry') {
      record.titleRetry = await deadline(request('title-retry'), 180_000, 'Title retry deadline exceeded');
      if (!record.titleRetry.passed) throw new Error('Title retry correctness failed');
    }
    const prompts = ['lifecycle', 'title-retry'].includes(workload) ? [] : workload === 'small' ? editingPrompts : sustainedPrompts;
    record.promptSha256 = hash(prompts); record.contextSha256 = study.contextSha256;
    for (let turn = 0; turn < prompts.length; turn++) {
      if (guardError) throw guardError;
      current = await quota();
      admitCursorWork({ baseline: study.baseline, current, phase: arm === 'candidate' ? 'verification' : 'exploration' });
      if (turn === 2) await request('reload');
      const beforeHashes = workload === 'sustained' ? await sustainedFileHashes(workspace) : null;
      const start = Date.now();
      const result = await deadline(request('send', { text: prompts[turn] }), 300_000, 'Study prompt deadline exceeded');
      const completedAt = Date.now();
      const turnRecord = { turn, start, completedAt, result, grade: null };
      record.turns.push(turnRecord);
      await save(studyFile, study);
      if (guardError) throw guardError;
      if (result.status !== 'finished') throw new Error(`Native run finished with ${result.status}`);
      const grade = workload === 'small' ? await verifyEditingFixture(workspace, { turn })
        : await verifySustainedFixture(workspace, { turn, beforeHashes });
      turnRecord.grade = grade;
      await save(studyFile, study);
      if (!grade.passed) throw new Error('Independent workload checks failed');
      await delay(30_000);
      if (guardError) throw guardError;
    }
    record.idleStartedAt = Date.now();
    await delay(60_000);
    const native = (await fs.readFile(observations, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (workerHost === 'electron' && !native.some(row => row.host?.electron)) throw new Error('Native Electron SDK host was not observed');
    const selection = model => JSON.stringify({ id: model?.id,
      params: [...(model?.params || [])].sort((left, right) => left.id.localeCompare(right.id)) });
    const sends = native.filter(row => row.kind === (workload === 'title-retry' ? 'one-shot-started' : 'send'));
    record.modelParametersMatched = sends.length > 0
      && sends.every(row => selection(row.model) === selection(study.selections[modelID].model));
    if (!record.modelParametersMatched) throw new Error('Selected model parameters changed at the SDK boundary');
    record.idleRunStarts = native.filter(row => row.kind === 'run-started' && row.at >= record.idleStartedAt).length;
    if (record.idleRunStarts) throw new Error('Unexpected idle inference');
    if (workload === 'lifecycle') {
      const afterAbort = record.lifecycle.cancellation.settledAt;
      const beforeResume = record.lifecycle.steps.at(-1).start;
      record.lifecycle.postAbortActivity = native.filter(row => ['run-started', 'tool-started', 'one-shot-started'].includes(row.kind)
        && row.at > afterAbort && row.at < beforeResume).length;
      if (record.lifecycle.postAbortActivity) throw new Error('Native activity continued after settled abort');
    }
    if (workload === 'lifecycle' && !native.some(row => row.kind === 'tool-started' && /task|subagent/i.test(row.tool || ''))) {
      throw new Error('Native subagent activity was not observed');
    }
    if (guardError) throw guardError;
    record.outcome = 'completed';
  } catch (error) {
    if (!record) throw error;
    record.outcome = 'failed'; record.error = error.message;
    if (child?.connected) await Promise.race([request('cancel').catch(() => {}), delay(5000)]);
  } finally {
    clearInterval(guardTimer);
    await guardCheck;
    if (record && guardError) { record.outcome = 'failed'; record.guardError = guardError.message; }
    if (child?.connected) await Promise.race([request('close').catch(() => {}), delay(5000)]);
    if (ownership) {
      try { await ownership.refresh(); await ownership.terminateRemaining(); await ownership.auditStopped(); }
      catch (error) { if (record) { record.outcome = 'failed'; record.cleanupError = error.message; } }
      await ownership.closeTracking();
      if (record) record.cleanup = ownership.getEvidence();
    }
    if (record) {
      await delay(30_000);
      try {
        record.settlementReadings = [];
        record.after = await settledQuota(quota, record.settlementReadings);
        record.delta = cursorQuotaDelta(record.before, record.after);
        if ((await referenceActivity()).hash !== record.referenceBefore.hash) throw new Error('Concurrent Cursor activity invalidates attribution');
      }
      catch (error) { record.outcome = 'failed'; record.quotaError = error.message; }
      const evidence = await fs.readFile(path.join(root, record.id, 'native.ndjson'), 'utf8').catch(() => '');
      record.native = summarizeCursorRuns(evidence.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
      record.completedAt = Date.now(); await save(studyFile, study);
    }
    await lock.close(); await fs.unlink(path.join(root, 'live.lock'));
  }
  return record;
}

// No inference. Recover a failed post-work reading without removing the failure,
// renewing the budget, or pretending the attempt passed its original guard.
export async function recoverCursorUsageQuota(root) {
  root = await requireCacheDirectory(root);
  const lock = await fs.open(path.join(root, 'live.lock'), 'wx');
  try {
    const file = path.join(root, 'study.json');
    const study = await readJson(file);
    const attempt = study.attempts.at(-1);
    if (!attempt || attempt.outcome === 'running') throw new Error('No settled attempt to reconcile');
    const { quota } = await access();
    const readings = [];
    const after = await settledQuota(quota, readings);
    if (!cursorReferenceMatchesAttempt(attempt, await referenceActivity())) throw new Error('Installed Cursor activity changed during the gap');
    cursorQuotaDelta(study.baseline, after);
    attempt.quotaRecovery = { readings, after, at: Date.now(), attribution: 'bounded delayed reading; independent IDE activity unavailable' };
    attempt.after = after;
    attempt.delta = cursorQuotaDelta(attempt.before, after);
    await save(file, study);
    return { id: attempt.id, outcome: attempt.outcome, delta: attempt.delta, after };
  } finally {
    await lock.close(); await fs.unlink(path.join(root, 'live.lock'));
  }
}

async function main() {
  const [action, root, model, arm, repetition, workload, workerHost] = process.argv.slice(2);
  if (!root || !['prepare', 'run', 'recover-quota', 'summary'].includes(action)) throw new Error('Usage: cursor-usage-live.mjs prepare|run|recover-quota|summary ROOT [MODEL ARM REP small|sustained|lifecycle|title-retry node|electron]');
  let result;
  if (action === 'prepare') result = await prepareCursorUsageStudy(root);
  else if (action === 'run') result = await runCursorUsageAttempt(root, model, arm, Number(repetition), workload, workerHost);
  else if (action === 'recover-quota') result = await recoverCursorUsageQuota(root);
  else result = summarizeCursorStudy(await readJson(path.join(await requireCacheDirectory(root), 'study.json')));
  console.log(JSON.stringify(action === 'run' ? { id: result.id, outcome: result.outcome, error: result.error, delta: result.delta, native: result.native } : result, null, 2));
  if (result?.outcome === 'failed') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
