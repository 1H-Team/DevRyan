import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abortSessionTree, collectSanitizedTools, fetchSessionTree } from '../agent-evals/client.mjs';
import { resolveProviderPromptTools } from '../../packages/orchestration-runtime/provider-prompt-tools.js';
import { gradeManagedTaskAcceptance, gradeQaManagedRepairToolEvidence, gradeQaRepairToolEvidence } from './acceptance-graders.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (id, passed) => ({ id, passed: passed === true });
const errorCode = error => ['qa_evidence_deadline', 'qa_evidence_page_limit', 'qa_evidence_invalid_response', 'evaluation_session_tree_limit'].includes(error?.code)
  ? error.code : 'qa_evidence_read_failed';
const fail = code => Object.assign(new Error(code), { code });

async function ownedProject(directory) {
  if (!path.isAbsolute(directory ?? '')) throw new Error('QA evidence requires an owned project directory');
  const canonical = await realpath(directory);
  if (canonical !== path.resolve(directory) || !inside(path.join(await realpath(root), '.cache'), canonical)
    || path.basename(canonical) !== 'project' || (await lstat(directory)).isSymbolicLink()) {
    throw new Error('QA evidence requires an owned project directory');
  }
  const seedPath = path.join(path.dirname(canonical), 'seed-manifest.json');
  if ((await lstat(seedPath)).isSymbolicLink()) throw new Error('QA evidence seed manifest must be an owned file');
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  if (seed.schemaVersion !== 1 || seed.seedVersion !== 1 || !Array.isArray(seed.manifest?.tracked)) throw new Error('Invalid QA evidence seed manifest');
  return { directory: canonical, seed };
}

// API calls stay on the already authenticated application tab. No prompt or
// session-create method is provided; cleanup exposes only the authorized abort.
function createAdapter(api, timeoutMs, onSessionID = () => {}) {
  const deadline = Date.now() + timeoutMs;
  const request = async (route, options, signal) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) throw fail('qa_evidence_deadline');
    let timer;
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => api(route, options)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail('qa_evidence_deadline')), remaining);
          onAbort = () => reject(fail('qa_evidence_deadline'));
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  };
  const route = (sessionID, directory, suffix) => {
    if (!safeId(sessionID)) throw fail('qa_evidence_invalid_response');
    onSessionID(sessionID);
    return `/api/session/${encodeURIComponent(sessionID)}/${suffix}?directory=${encodeURIComponent(directory)}`;
  };
  return {
    request,
    async getMessages(sessionID, directory, signal) {
      const rows = new Map();
      let before;
      for (let page = 0; page < 40; page++) {
        const result = await request(`${route(sessionID, directory, 'message')}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`, {}, signal);
        if (!Array.isArray(result) || result.some(row => !safeId(row?.info?.id) || !Array.isArray(row.parts))) throw fail('qa_evidence_invalid_response');
        let added = 0;
        for (const row of result) { if (!rows.has(row.info.id)) { rows.set(row.info.id, row); added++; } }
        if (result.length < 200) return [...rows.values()];
        if (!added) throw fail('qa_evidence_page_limit');
        // The native messages endpoint returns chronological pages.
        before = result[0].info.id;
      }
      throw fail('qa_evidence_page_limit');
    },
    async getChildren(sessionID, directory, signal) {
      const children = await request(route(sessionID, directory, 'children'), {}, signal);
      if (!Array.isArray(children) || children.some(child => !safeId(child?.id))) throw fail('qa_evidence_invalid_response');
      children.forEach(child => onSessionID(child.id));
      return children;
    },
    async abortSession(sessionID, directory, signal) {
      return await request(route(sessionID, directory, 'abort'), { method: 'POST', body: '{}' }, signal);
    },
  };
}

async function suiteProvenance({ directory, seed }) {
  const originalTests = seed.manifest.tracked.filter(entry => entry.path.startsWith('test/'));
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const retained = await Promise.all(originalTests.map(async entry => {
    const file = path.join(directory, entry.path);
    try { return inside(directory, file) && !(await lstat(file)).isSymbolicLink() && digest(await readFile(file)) === entry.sha256; }
    catch { return false; }
  }));
  let localNpmConfigurationAbsent = false;
  try { await lstat(path.join(directory, '.npmrc')); }
  catch (error) { if (error.code === 'ENOENT') localNpmConfigurationAbsent = true; else throw error; }
  return { testScriptUnchanged: packageJson.scripts?.test === 'node --test test/*.test.mjs'
      && packageJson.scripts?.pretest === undefined && packageJson.scripts?.posttest === undefined && localNpmConfigurationAbsent,
    originalTestsRetained: originalTests.length > 0 && retained.every(Boolean), originalTestCount: originalTests.length };
}

function tokens(segment) {
  // This is an allowlist grammar, not a shell interpreter. Substitution, pipes,
  // redirection, environment changes and arbitrary command suffixes never qualify.
  if (/[\r\n`$<>|;\\]/.test(segment)) return null;
  const result = [];
  let rest = segment.trim();
  while (rest) {
    const match = /^(?:'([^']*)'|"([^"]*)"|([^\s'"&]+))(?:\s+|$)/.exec(rest);
    if (!match) return null;
    result.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length);
  }
  return result;
}

function suiteCommand(command, directory, input) {
  if (typeof command !== 'string' || command.length > 8_192) return null;
  for (const key of ['workdir', 'cwd', 'directory']) {
    if (input?.[key] !== undefined && input[key] !== directory) return null;
  }
  const segments = command.trim().split(/\s*&&\s*/).map(tokens);
  if (segments.some(segment => !segment?.length)) return null;
  if (segments[0][0] === 'cd') {
    if (segments[0].length !== 2 || segments[0][1] !== directory) return null;
    segments.shift();
  }
  if (!segments.length) return null;
  const last = segments.pop();
  const permitted = [['npm', 'test'], ['npm', 'run', 'test'], ['node', '--test', 'test/tasks.test.mjs']];
  if (!permitted.some(args => args.length === last.length && args.every((arg, index) => arg === last[index]))) return null;
  if (!segments.every(segment => segment.length === 3 && segment[0] === 'node' && segment[1] === '--check'
    && /^(?:src|public|test)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:mjs|js)$/.test(segment[2]))) return null;
  return { kind: last[0] === 'node' ? 'original-test-file' : 'qa-npm-suite', precededBySyntaxChecks: segments.length > 0 };
}

function nativeExit(part) {
  if (part.state?.status !== 'completed') return null;
  const metadata = part.state.metadata;
  const present = ['exit', 'exitCode'].filter(key => Object.hasOwn(metadata ?? {}, key)).map(key => metadata[key]);
  if (!present.length || !present.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 255) || new Set(present).size !== 1) return null;
  return present[0];
}

export function projectQaNativeTestEvidence(part, directory) {
  if (!['bash', 'shell', 'terminal', 'exec', 'exec_command', 'oc_bash'].includes(part?.tool)) return null;
  const command = suiteCommand(part.state?.input?.command, directory, part.state?.input);
  const exitCode = nativeExit(part);
  if (!command || exitCode === null || (command.precededBySyntaxChecks && exitCode !== 0)) return null;
  return { ...command, exitCode };
}

async function sourceToolEvidence(part, directory) {
  if (part.state?.status !== 'completed') return null;
  const input = part.state.input;
  let names;
  let kind;
  if (['read', 'file_read', 'oc_read', 'edit', 'oc_edit', 'write', 'oc_write', 'multiedit'].includes(part.tool)) {
    const fields = ['filePath', 'file_path', 'path'].filter(key => typeof input?.[key] === 'string');
    if (fields.length !== 1) return null;
    names = [input[fields[0]]];
    kind = ['read', 'file_read', 'oc_read'].includes(part.tool) ? 'read' : 'mutation';
  } else if (part.tool === 'apply_patch' && typeof input?.patchText === 'string'
    && input.patchText.startsWith('*** Begin Patch\n') && input.patchText.trimEnd().endsWith('*** End Patch')) {
    names = [...input.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]);
    kind = 'mutation';
  } else return null;
  if (!names.length) return null;
  const relativePaths = [];
  for (const name of names) {
    const requested = path.resolve(directory, name);
    const relative = path.relative(directory, requested);
    if (!inside(directory, requested)) return null;
    try {
      if (!(await lstat(requested)).isFile() || await realpath(requested) !== requested) return null;
    } catch { return null; }
    if (/^(?:src|public)\/[a-zA-Z0-9_./-]+$/.test(relative) && !relative.split('/').includes('..')) relativePaths.push(relative);
  }
  return relativePaths.length ? { kind, relativePaths: [...new Set(relativePaths)] } : null;
}

async function suiteTools(tree, rootSessionID, directory, provenance) {
  const tools = [];
  for (const session of tree) for (const row of session.messages) for (const part of row.parts) {
    if (part.type !== 'tool') continue;
    const event = collectSanitizedTools([{ ...session, messages: [{ parts: [part] }] }], { rootSessionId: rootSessionID })[0];
    if (!event) continue;
    event.final = part.state?.status === 'completed';
    event.sessionID = safeId(session.sessionId) ? session.sessionId : null;
    event.callID = safeId(part.callID) ? part.callID : null;
    const source = await sourceToolEvidence(part, directory);
    if (source) event.ownedSource = source;
    const command = suiteCommand(part.state?.input?.command, directory, part.state?.input);
    const exit = nativeExit(part);
    if (provenance.testScriptUnchanged && provenance.originalTestsRetained && command && exit !== null
      && (!command.precededBySyntaxChecks || exit === 0)) {
      event.ownedTestOutcome = exit === 0 ? 'passed' : 'failed';
      event.testCommandKind = command.kind;
      event.nativeExitCode = exit;
      event.precededBySyntaxChecks = command.precededBySyntaxChecks;
    }
    tools.push(event);
  }
  return tools;
}

const pick = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field,
  value[field] === null || typeof value[field] === 'boolean' || safeId(value[field]) ? value[field] : null]));
const taskFields = ['taskId', 'rootSessionId', 'childSessionId', 'dispatchCallId', 'dispatchGrouped', 'mode', 'status', 'readOnly'];
const envelopeFields = ['envelopeId', 'taskId', 'rootSessionId', 'status', 'action'];
function snapshotProjection(value, rootSessionID) {
  if (!record(value) || !Array.isArray(value.tasks) || !Array.isArray(value.resultEnvelopes)) throw fail('qa_evidence_invalid_response');
  const tasks = value.tasks.filter(task => task.rootSessionId === rootSessionID).map(task => pick(task, taskFields));
  const taskIds = new Set(tasks.map(task => task.taskId));
  return { available: value.available === true, bridgeReady: value.bridgeReady === true, recoveryWarningPresent: value.recoveryWarning != null,
    tasks, resultEnvelopes: value.resultEnvelopes.filter(envelope => envelope.rootSessionId === rootSessionID || taskIds.has(envelope.taskId)).map(envelope => pick(envelope, envelopeFields)) };
}

const planUser = row => row?.info?.role === 'user' && (row.info.mode === 'plan' || row.info.metadata?.openchamberPlanMode === true
  || row.parts.some(part => part.type === 'text' && part.synthetic === true && typeof part.text === 'string' && part.text.trim().startsWith('User has requested to enter plan mode')));

export function projectQaPlanChildPolicy(tree, rootSessionID, tasks) {
  const rootRows = tree.find(session => session.sessionId === rootSessionID)?.messages ?? [];
  const expected = resolveProviderPromptTools('openai', 'explorer', { readOnly: true, contextModeAvailable: true });
  const enabledAllowlist = new Set(Object.entries(expected).filter(([, allowed]) => allowed === true).map(([name]) => name));
  const result = [];
  for (const task of tasks) {
    const dispatch = rootRows.find(row => row.parts.some(part => part.type === 'tool' && part.tool === 'devryan_task'
      && part.callID === task.dispatchCallId && part.state?.input?.action === 'start'));
    const parent = rootRows.find(row => row.info.id === dispatch?.info?.parentID);
    if (!planUser(parent)) continue;
    const childRows = tree.find(session => session.sessionId === task.childSessionId)?.messages.filter(row => row.info.role === 'user') ?? [];
    const policies = childRows.map(row => {
      const tools = row.info.tools;
      const observed = record(tools) && Object.values(tools).every(value => typeof value === 'boolean');
      return { userMessageID: row.info.id, observed, wildcardDenied: observed && tools['*'] === false,
        unknownEnabledToolCount: observed ? Object.entries(tools).filter(([name, value]) => value === true && !enabledAllowlist.has(name)).length : null };
    });
    result.push({ taskId: task.taskId, childSessionId: task.childSessionId, parentUserMessageID: parent.info.id, policies,
      enforced: policies.length > 0 && policies.every(policy => policy.observed && policy.wildcardDenied && policy.unknownEnabledToolCount === 0) });
  }
  return { source: 'canonical-child-user-message-tools', children: result, passed: result.length > 0 && result.every(child => child.enforced) };
}

function managedCalls(tree, rootSessionID, snapshot) {
  const starts = []; const dispositions = [];
  for (const session of tree) for (const row of session.messages) for (const part of row.parts) {
    if (session.sessionId !== rootSessionID || part.type !== 'tool' || part.tool !== 'devryan_task' || part.state?.status !== 'completed') continue;
    let output;
    try { output = JSON.parse(part.state.output); } catch { continue; }
    const action = part.state.input?.action;
    const taskId = output?.task?.taskId ?? output?.resultEnvelope?.taskId;
    if (!safeId(taskId) || !safeId(part.callID)) continue;
    const task = snapshot.tasks.find(item => item.taskId === taskId);
    if (action === 'start') starts.push({ taskId, childSessionId: task?.childSessionId ?? null, callId: part.callID,
      dispatchMatches: output.task?.dispatchCallId === part.callID && task?.dispatchCallId === part.callID,
      childMatches: output.task?.childSessionId == null || output.task.childSessionId === task?.childSessionId });
    if (action === 'continue') dispositions.push({ taskId, callId: part.callID, envelopeId: safeId(output.resultEnvelope?.envelopeId) ? output.resultEnvelope.envelopeId : null,
      accepted: part.state.input.task_id === taskId && output.resultEnvelope?.action === 'continue'
        && snapshot.resultEnvelopes.some(envelope => envelope.taskId === taskId && envelope.envelopeId === output.resultEnvelope?.envelopeId && envelope.action === 'continue') });
  }
  return { starts, dispositions };
}

export async function captureQaTaskEvidence({ api, rootSessionID, directory, agent, planMode = false, requireProjectWork = true, timeoutMs = 30_000 }) {
  if (typeof api !== 'function' || !safeId(rootSessionID) || !['builder', 'build', 'orchestrator'].includes(agent)
    || typeof planMode !== 'boolean' || typeof requireProjectWork !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120_000) throw new Error('Invalid QA task evidence selection');
  const project = await ownedProject(directory);
  const evidence = { schemaVersion: 1, rootSessionID, agent, passed: false, checks: [], sessionIDs: [rootSessionID], sessions: [], tools: [], collection: { complete: false } };
  const adapter = createAdapter(api, timeoutMs, id => { if (!evidence.sessionIDs.includes(id)) evidence.sessionIDs.push(id); });
  try {
    const snapshot = agent === 'orchestrator'
      ? snapshotProjection(await adapter.request(`/api/orchestration/snapshot?rootSessionId=${encodeURIComponent(rootSessionID)}`, {}), rootSessionID) : null;
    const additionalSessionIds = snapshot?.tasks.map(task => task.childSessionId).filter(safeId) ?? [];
    for (const id of additionalSessionIds) if (!evidence.sessionIDs.includes(id)) evidence.sessionIDs.push(id);
    const tree = await fetchSessionTree(adapter, rootSessionID, directory, { maximum: 64, additionalSessionIds });
    evidence.sessionIDs = tree.map(session => session.sessionId);
    evidence.sessions = tree.map(session => ({ sessionID: session.sessionId, parentSessionID: session.parentSessionId,
      messageCount: session.messages.length, userMessageCount: session.messages.filter(row => row.info.role === 'user').length,
      assistantMessageCount: session.messages.filter(row => row.info.role === 'assistant').length }));
    evidence.tools = collectSanitizedTools(tree, { rootSessionId: rootSessionID, ownedTestRelativePath: 'test/tasks.test.mjs' });
    const gradeRepair = agent === 'orchestrator' ? gradeQaManagedRepairToolEvidence : gradeQaRepairToolEvidence;
    const canonical = gradeRepair(evidence.tools);
    if (requireProjectWork) {
      const provenance = await suiteProvenance(project);
      const events = await suiteTools(tree, rootSessionID, directory, provenance);
      const suite = gradeRepair(events.filter(event => event.sessionID && event.callID
        && (event.ownedSource || event.ownedTestOutcome)));
      evidence.repair = { canonical, suite, provenance, suiteTools: events };
      // The legacy evaluator result is diagnostic: its wrapper/Cursor support
      // and final-error read semantics must not bypass this native QA contract.
      evidence.checks.push(check(agent === 'orchestrator' ? 'qa.orchestrator-causal-repair' : 'qa.builder-causal-repair', suite.passed));
    }
    if (agent === 'orchestrator') {
      const { starts, dispositions } = managedCalls(tree, rootSessionID, snapshot);
      // confirm:false calls scheduler.inspectAgentHandoff under its lock; this
      // does not switch agents, cancel work, or acknowledge results. Its clear
      // result covers the same grouped obligations for orchestrator-mode tasks.
      const inspection = await adapter.request('/api/orchestration/handoff', { method: 'POST', body: JSON.stringify({ rootSessionId: rootSessionID,
        fromMode: 'orchestrator', toMode: 'builder', confirm: false }) });
      const barrierClear = inspection?.rootSessionId === rootSessionID && inspection.fromMode === 'orchestrator' && inspection.toMode === 'builder'
        && inspection.state === 'clear' && Array.isArray(inspection.tasks) && inspection.tasks.length === 0
        && Array.isArray(inspection.failures) && inspection.failures.length === 0
        && snapshot.tasks.length > 0 && snapshot.tasks.every(task => task.mode === 'orchestrator');
      const barrier = { source: 'scheduler-readonly-handoff-inspection', observed: record(inspection), state: barrierClear ? 'clear' : 'unresolved',
        activeTaskIds: Array.isArray(inspection?.tasks) ? inspection.tasks.map(item => item.task?.taskId).filter(safeId) : null };
      const grade = gradeManagedTaskAcceptance({ rootSessionId: rootSessionID, snapshot,
        childSessionIds: evidence.sessionIDs.filter(id => id !== rootSessionID), dispatches: starts,
        activeBarriers: barrierClear ? [] : undefined });
      evidence.managed = { snapshot, dispatches: starts, dispositions, barrier, grade };
      evidence.checks.push(check('qa.managed-runtime-ready', snapshot.available && snapshot.bridgeReady && !snapshot.recoveryWarningPresent),
        ...grade.checks, check('qa.managed-dispatch-call-links', starts.length > 0 && starts.every(start => start.dispatchMatches && start.childMatches)),
        check('qa.managed-exact-dispositions', dispositions.length === snapshot.tasks.length
          && new Set(dispositions.map(item => item.taskId)).size === dispositions.length && dispositions.every(item => item.accepted)));
      if (planMode) {
        evidence.managed.planChildPolicy = projectQaPlanChildPolicy(tree, rootSessionID, snapshot.tasks);
        evidence.checks.push(check('qa.managed-plan-child-policy', evidence.managed.planChildPolicy.passed));
      }
    }
    evidence.collection.complete = true;
    evidence.checks.unshift(check('qa.canonical-session-tree', true));
  } catch (error) {
    evidence.collection.reason = errorCode(error);
    evidence.checks.unshift(check('qa.canonical-session-tree', false));
  }
  evidence.passed = evidence.checks.length > 0 && evidence.checks.every(item => item.passed);
  return evidence;
}

export async function cleanupQaSessionTree({ api, rootSessionID, directory, knownSessionIds = [], timeoutMs = 12_000 }) {
  if (typeof api !== 'function' || !safeId(rootSessionID) || !Array.isArray(knownSessionIds) || !knownSessionIds.every(safeId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120_000) throw new Error('Invalid QA cleanup selection');
  await ownedProject(directory);
  return await abortSessionTree(createAdapter(api, timeoutMs), rootSessionID, directory, { maximum: 64, knownSessionIds, timeoutMs });
}
